/**
 * README executable examples extraction and sandboxed execution.
 *
 * Extracts fenced code blocks annotated with <!-- release-skill:exec fixture=<id> -->
 * metadata from README files, copies the referenced fixture into a temporary
 * directory, and executes each command using `execFile` (never shell) in isolation.
 * The original fixture directory is never modified.
 *
 * @module readme/examples
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, cp, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ReleaseError } from '../core/errors.mjs';

const execFileAsync = promisify(execFileCb);

/** Default command timeout in milliseconds (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum buffer for child process stdout/stderr (10 MiB). */
const MAX_BUFFER = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract executable command blocks from README content.
 *
 * A block is executable when the line immediately before the opening fence
 * contains: <!-- release-skill:exec fixture=<id> -->
 *
 * @param {string} content - README file content.
 * @returns {Array<{ fixture: string, language: string, commands: string[] }>}
 */
function extractExecBlocks(content) {
  const results = [];
  const regex =
    /<!--\s*release-skill:exec\s+fixture=([\w-]+)\s*-->\s*\n```(sh|bash)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const fixture = match[1];
    const language = match[2];
    const blockBody = match[3];
    const commands = blockBody
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    results.push({ fixture, language, commands });
  }
  return results;
}

/**
 * Parse a shell-style command line into [executable, ...args].
 *
 * Handles quoted arguments (single and double) and strips inline comments.
 * This is a simple parser -- it does NOT invoke a shell.
 *
 * @param {string} line - A single command line.
 * @returns {string[]}  - [executable, ...args]
 */
function parseCommand(line) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
    } else if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < line.length) {
        current += line[++i];
      } else {
        current += ch;
      }
    } else if (ch === '#') {
      // Inline comment -- stop processing this line
      break;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Safely read a file; return null if absent.
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
async function safeRead(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ExecResult
 * @property {string}   fixture   - The fixture id from the exec metadata.
 * @property {string}   command   - The original command line string.
 * @property {string[]} parsed    - Parsed [executable, ...args].
 * @property {string}   stdout    - Captured stdout.
 * @property {string}   stderr    - Captured stderr.
 * @property {number}   exitCode  - Process exit code (0 for success).
 * @property {string}   cwd       - Absolute path to the sandboxed working directory.
 * @property {'ok'|'timeout'|'error'} status - Execution outcome.
 */

/**
 * Extract executable commands from README files and run them in isolated
 * fixture copies using `execFile` (never shell).
 *
 * For each fixture referenced by exec metadata:
 * 1. The fixture directory is copied to a fresh temporary directory.
 * 2. Every command in the block is executed in that copy via `execFile`.
 * 3. The original fixture is never modified.
 *
 * @param {object}  options
 * @param {string}  options.snapshotDir  - Directory containing README.md / README.zh-CN.md.
 * @param {string}  options.fixturesDir  - Directory containing fixture subdirectories.
 * @param {number}  [options.timeoutMs=30000] - Per-command timeout in milliseconds.
 * @returns {Promise<ExecResult[]>}
 */
export async function extractExecutableCommands({
  snapshotDir,
  fixturesDir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  // 1. Read README files and extract exec blocks
  const enContent = await safeRead(path.join(snapshotDir, 'README.md'));
  const zhContent = await safeRead(path.join(snapshotDir, 'README.zh-CN.md'));

  /** @type {Map<string, { fixture: string, commands: string[] }>} */
  const blocksByFixture = new Map();

  const addBlocks = (content) => {
    if (!content) return;
    for (const block of extractExecBlocks(content)) {
      if (!blocksByFixture.has(block.fixture)) {
        blocksByFixture.set(block.fixture, {
          fixture: block.fixture,
          commands: block.commands,
        });
      }
    }
  };

  addBlocks(enContent);
  addBlocks(zhContent);

  if (blocksByFixture.size === 0) {
    return [];
  }

  // 2. Create a parent temp directory for all fixture copies
  const parentTmp = await mkdtemp(path.join(os.tmpdir(), 'release-skill-examples-'));

  /** @type {ExecResult[]} */
  const results = [];

  try {
    for (const [fixtureId, block] of blocksByFixture) {
      const srcDir = path.join(fixturesDir, fixtureId);

      // Create an isolated copy for this fixture
      const sandboxDir = path.join(parentTmp, fixtureId);
      await cp(srcDir, sandboxDir, { recursive: true });

      for (const line of block.commands) {
        const parsed = parseCommand(line);
        if (parsed.length === 0) continue;

        const executable = parsed[0];
        const args = parsed.slice(1);

        /** @type {ExecResult} */
        let result;

        try {
          // Set up timeout via AbortController
          const controller = new AbortController();
          const handle = setTimeout(() => controller.abort(), timeoutMs);

          try {
            const { stdout, stderr } = await execFileAsync(executable, args, {
              cwd: sandboxDir,
              shell: false,
              maxBuffer: MAX_BUFFER,
              signal: controller.signal,
            });

            result = {
              fixture: fixtureId,
              command: line,
              parsed,
              stdout: stdout ?? '',
              stderr: stderr ?? '',
              exitCode: 0,
              cwd: sandboxDir,
              status: 'ok',
            };
          } finally {
            clearTimeout(handle);
          }
        } catch (err) {
          // Timeout detection: AbortError or killed via SIGTERM
          if (err.name === 'AbortError' || (err.killed && err.signal === 'SIGTERM')) {
            result = {
              fixture: fixtureId,
              command: line,
              parsed,
              stdout: err.stdout ?? '',
              stderr: err.stderr ?? '',
              exitCode: 16, // HOOK_TIMEOUT exit code
              cwd: sandboxDir,
              status: 'timeout',
            };
          } else if ('stdout' in err) {
            // Non-zero exit
            result = {
              fixture: fixtureId,
              command: line,
              parsed,
              stdout: err.stdout ?? '',
              stderr: err.stderr ?? '',
              exitCode: typeof err.code === 'number' ? err.code : 1,
              cwd: sandboxDir,
              status: 'error',
            };
          } else {
            // Unexpected failure (e.g., ENOENT)
            result = {
              fixture: fixtureId,
              command: line,
              parsed,
              stdout: '',
              stderr: err.message ?? String(err),
              exitCode: 1,
              cwd: sandboxDir,
              status: 'error',
            };
          }
        }

        results.push(result);
      }
    }
  } finally {
    // Clean up the temporary directory tree
    await rm(parentTmp, { recursive: true, force: true });
  }

  return results;
}
