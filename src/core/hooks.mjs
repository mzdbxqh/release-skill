/**
 * Secure hook execution for the release-skill system.
 *
 * Design constraints:
 * - Uses `execFile` exclusively; never `exec` or `shell: true`.
 * - Resolves cwd through `realpath` and rejects any path that escapes root.
 * - Builds a minimal environment: platform-required vars plus only those
 *   explicitly listed in `envAllowlist` that exist in `context.env`.
 * - Kills the child process on timeout and returns `HOOK_TIMEOUT`.
 * - Never leaks unallowlisted environment variables to the child process.
 *
 * @module hooks
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import { ReleaseError } from './errors.mjs';

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Platform-required environment variables
// ---------------------------------------------------------------------------

/**
 * Minimum environment variables needed for child processes.
 * PATH is always included; HOME/USER are needed for temporary directories and
 * user detection; LANG/LC_* support locale on POSIX; SystemRoot/COMSPEC/PATHEXT
 * are required on Windows.
 */
const PLATFORM_REQUIRED_VARS = (() => {
  const posix = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'];
  const win32 = ['PATH', 'HOME', 'USER', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'];
  return new Set(process.platform === 'win32' ? win32 : posix);
})();

/** Pattern that every envAllowlist key must satisfy. */
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate the shape of a hook descriptor against the project contract.
 *
 * @param {unknown} hook
 * @throws {ReleaseError} INVALID_HOOK on any contract violation.
 */
function validateHook(hook) {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
    throw new ReleaseError('INVALID_HOOK', 'hook must be a non-null object');
  }

  const { command, cwd, timeoutMs, envAllowlist } = hook;

  // command: required, non-empty array of strings
  if (!Array.isArray(command) || command.length === 0) {
    throw new ReleaseError('INVALID_HOOK', 'hook.command must be a non-empty array');
  }
  for (const c of command) {
    if (typeof c !== 'string') {
      throw new ReleaseError('INVALID_HOOK', 'every element of hook.command must be a string');
    }
  }

  // cwd: optional string
  if (cwd !== undefined && typeof cwd !== 'string') {
    throw new ReleaseError('INVALID_HOOK', 'hook.cwd must be a string when provided');
  }

  // timeoutMs: optional positive integer (minimum 1 to avoid accidental zero)
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new ReleaseError('INVALID_HOOK', 'hook.timeoutMs must be a positive integer');
    }
  }

  // envAllowlist: optional array of uppercase key names
  if (envAllowlist !== undefined) {
    if (!Array.isArray(envAllowlist)) {
      throw new ReleaseError('INVALID_HOOK', 'hook.envAllowlist must be an array');
    }
    for (const key of envAllowlist) {
      if (typeof key !== 'string' || !ENV_KEY_PATTERN.test(key)) {
        throw new ReleaseError(
          'INVALID_HOOK',
          `hook.envAllowlist key "${key}" must match /^[A-Z_][A-Z0-9_]*$/`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Environment building
// ---------------------------------------------------------------------------

/**
 * Build a filtered environment for a child process.
 *
 * Included keys:
 * 1. Platform-required vars (from `process.env`).
 * 2. Allowlisted vars (from `context.env` only).
 *
 * Everything else is stripped.
 *
 * @param {string[]} envAllowlist - Keys to forward from context.env.
 * @param {Record<string, string>} [contextEnv] - Caller-provided env map.
 * @returns {Record<string, string>}
 */
function buildFilteredEnv(envAllowlist, contextEnv) {
  const env = {};

  // 1. Platform-required variables
  for (const key of PLATFORM_REQUIRED_VARS) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }

  // 2. Allowlisted variables from context.env
  if (contextEnv && envAllowlist) {
    for (const key of envAllowlist) {
      if (key in contextEnv) {
        env[key] = contextEnv[key];
      }
    }
  }

  return env;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a hook command in a controlled subprocess.
 *
 * @param {Object} hook
 * @param {string[]}   hook.command       - [executable, ...args].
 * @param {string}     [hook.cwd]         - Relative (to root) working directory.
 * @param {number}     [hook.timeoutMs]   - Kill child after this many ms.
 * @param {string[]}   [hook.envAllowlist] - Extra env keys to pass through.
 *
 * @param {Object} context
 * @param {string} context.root           - Absolute project root.
 * @param {Record<string, string>} [context.env] - Extra env variables.
 *
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 *
 * @throws {ReleaseError} HOOK_TIMEOUT - when timeoutMs expires.
 * @throws {ReleaseError} INVALID_HOOK - when hook shape is invalid or cwd escapes root.
 */
export async function runHook(hook, context) {
  // --- Validate inputs ---
  validateHook(hook);

  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new ReleaseError('INVALID_HOOK', 'context must be a non-null object');
  }
  if (typeof context.root !== 'string' || !isAbsolute(context.root)) {
    throw new ReleaseError('INVALID_HOOK', 'context.root must be an absolute path');
  }

  const { command, cwd, timeoutMs, envAllowlist = [] } = hook;

  // --- Resolve and validate cwd ---
  const rootReal = await realpath(context.root);
  const resolvedCwd = cwd
    ? await realpath(resolve(rootReal, cwd))
    : rootReal;

  const rel = relative(rootReal, resolvedCwd);
  if (rel.startsWith('..') || rel === '..') {
    throw new ReleaseError(
      'INVALID_HOOK',
      `hook.cwd "${cwd}" resolves outside project root`,
    );
  }

  // --- Build safe environment ---
  const env = buildFilteredEnv(envAllowlist, context.env);

  // --- Set up timeout ---
  const executable = command[0];
  const args = command.slice(1);

  /** @type {AbortController | undefined} */
  let timeoutController;
  /** @type {NodeJS.Timeout | undefined} */
  let timeoutHandle;

  if (timeoutMs && timeoutMs > 0) {
    timeoutController = new AbortController();
    timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
  }

  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd: resolvedCwd,
      env,
      shell: false,
      maxBuffer: 10 * 1024 * 1024, // 10 MiB
      signal: timeoutController?.signal,
    });

    return { exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err) {
    // Two timeout indicators:
    //   1. AbortError — direct result of AbortController.abort()
    //   2. err.killed && err.signal === 'SIGTERM' — child was killed
    if (err.name === 'AbortError' || (err.killed && err.signal === 'SIGTERM')) {
      throw new ReleaseError(
        'HOOK_TIMEOUT',
        `hook timed out after ${timeoutMs}ms: ${executable} ${args.join(' ')}`,
        { command, timeoutMs },
      );
    }

    // Non-zero exit code: return the result so callers can inspect exitCode.
    if ('stdout' in err) {
      return {
        exitCode: typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
      };
    }

    // Unexpected errors bubble up.
    throw err;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
