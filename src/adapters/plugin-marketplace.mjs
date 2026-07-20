/**
 * Plugin marketplace adapter for release-skill.
 *
 * Validates generated Claude/Codex plugin manifests and installable content.
 * Uses `execFile` to call `node` for manifest validation. Never uses `exec`,
 * `execSync`, or `shell: true`.
 *
 * Marketplace install actions only require
 * `context.isolatedConsumerWritesAuthorized === true`; they write to
 * isolated consumer directories, not to remote services.
 *
 * @module adapters/plugin-marketplace
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, mkdir, writeFile, rename, readdir, rm, realpath, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';

import {
  ActionType,
  ActionStatus,
  createResult,
  assertWritesAuthorized,
  assertIsolatedConsumerWritesAuthorized,
  matchObservation,
} from './contract.mjs';

import { createHash } from 'node:crypto';
import { computeFrozenSnapshot, resolveFrozenPath } from '../snapshot/frozen.mjs';

const execFile = promisify(execFileCb);

const NAME = 'plugin-marketplace';

function transportPayload(entries) {
  return entries.map(({ path, type, mode, size, contentDigest }) => ({
    path,
    type,
    // The local authority removes write bits when sealing. Git checkout and
    // plugin installation restore owner-write permission, while preserving
    // executable intent. Ignore only write bits; retain every other mode bit.
    mode: mode & ~0o222,
    size,
    contentDigest,
  }));
}

async function verifyInstalledMarketplacePayload(action, context, installPath, consumer) {
  const sourcePath = await resolveFrozenPath(
    context.root,
    action.snapshotPath,
    'frozen marketplace snapshot',
  );
  const sourceSnapshot = await computeFrozenSnapshot(sourcePath);
  if (sourceSnapshot.digest !== action.manifestDigest) {
    throw new Error('frozen marketplace snapshot digest no longer matches the plan');
  }
  const installedSnapshot = await computeFrozenSnapshot(installPath, {
    excludeRootEntries: consumer === 'codex' ? ['.git'] : [],
  });
  if (
    JSON.stringify(transportPayload(sourceSnapshot.entries))
    !== JSON.stringify(transportPayload(installedSnapshot.entries))
  ) {
    throw new Error('installed marketplace payload differs in path, bytes, size, or non-write mode bits');
  }
  // This is not an expected-value backfill: the sealed authority digest was
  // revalidated above and the installed payload was independently compared.
  return action.manifestDigest;
}

async function writeEvidenceAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(tempPath, filePath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

const SUPPORTED_TYPES = [
  ActionType.PLUGIN_MANIFEST_VALIDATE,
  ActionType.PLUGIN_INSTALL_CHECK,
  ActionType.CLAUDE_MARKETPLACE_INSTALL,
  ActionType.CODEX_MARKETPLACE_INSTALL,
];

/** Safe identifier pattern: lowercase alphanumeric, hyphens, dots, underscores. */
const SAFE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Safe repo pattern: owner/repo with alphanumeric, hyphens, dots, underscores. */
const SAFE_REPO_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Strict semver pattern: supports prerelease and build metadata.
 * Matches: 1.0.0, 1.0.0-beta.1, 1.0.0-rc.1+build.123
 */
const STRICT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Validate a Git ref for injection safety.
 * Rejects: backslash, //, leading/trailing /, trailing ., .lock, @{, standalone @,
 * .., control characters, option-like values.
 *
 * @param {string} ref
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateSafeRef(ref) {
  if (!ref || typeof ref !== 'string') {
    return { valid: false, error: 'ref is required' };
  }
  if (/[\x00-\x1f]/.test(ref)) {
    return { valid: false, error: 'ref contains control characters' };
  }
  if (ref.startsWith('-')) {
    return { valid: false, error: `ref must not start with '-': "${ref}"` };
  }
  if (ref.includes('\\')) {
    return { valid: false, error: 'ref contains backslash' };
  }
  if (ref.includes('//')) {
    return { valid: false, error: 'ref contains //' };
  }
  if (ref.startsWith('/') || ref.endsWith('/')) {
    return { valid: false, error: 'ref must not start or end with /' };
  }
  if (ref.endsWith('.')) {
    return { valid: false, error: 'ref must not end with .' };
  }
  if (ref.endsWith('.lock')) {
    return { valid: false, error: 'ref must not end with .lock' };
  }
  if (ref.includes('@{')) {
    return { valid: false, error: 'ref contains @{' };
  }
  if (ref === '@') {
    return { valid: false, error: 'ref must not be standalone @' };
  }
  if (ref.includes('..')) {
    return { valid: false, error: 'ref contains ..' };
  }
  if (/[;|&`$(){}]/.test(ref)) {
    return { valid: false, error: 'ref contains shell metacharacters' };
  }
  // Must match safe alphanumeric pattern
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref)) {
    return { valid: false, error: `unsafe ref: "${ref}"` };
  }
  return { valid: true, error: null };
}

/**
 * Validate marketplace install parameters for injection-safe values.
 *
 * @param {object} params - The action parameters.
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateMarketplaceParams(params) {
  if (!params || typeof params !== 'object') {
    return { valid: false, error: 'parameters must be an object' };
  }
  const { consumer, plugin, marketplace, repo, version, entrySkill } = params;
  if (!['claude', 'codex'].includes(consumer)) {
    return { valid: false, error: `invalid consumer: "${consumer}"` };
  }
  if (!plugin || !SAFE_ID_RE.test(plugin)) {
    return { valid: false, error: `unsafe plugin identifier: "${plugin}"` };
  }
  if (!marketplace || !SAFE_ID_RE.test(marketplace)) {
    return { valid: false, error: `unsafe marketplace identifier: "${marketplace}"` };
  }
  if (!repo || !SAFE_REPO_RE.test(repo)) {
    return { valid: false, error: `unsafe repo identifier: "${repo}"` };
  }
  if (!version || !STRICT_SEMVER_RE.test(version)) {
    return { valid: false, error: `unsafe version (must be valid semver): "${version}"` };
  }
  if (!entrySkill || !SAFE_ID_RE.test(entrySkill)) {
    return { valid: false, error: `unsafe entrySkill: "${entrySkill}"` };
  }
  return { valid: true, error: null };
}


/**
 * Resolve and validate the frozen timeoutMs from the expanded adapter action.
 *
 * The publish/reconcile/verify call path expands plan actions as
 * `{ actionType, ...action.parameters }`, so `parameters.timeoutMs` in the
 * plan becomes `action.timeoutMs` at the adapter level. This function reads
 * from the top-level action, not from a nested `parameters` sub-object.
 *
 * Rules:
 * - Missing field (undefined): returns 300000 default (legacy compatibility).
 * - Present but null/invalid (null, string, NaN, Infinity, non-integer,
 *   out of range): fail-closed, throws.
 * - Valid integer in [30000, 900000]: returns the value as-is.
 *
 * @param {object} action - The expanded adapter action (top-level).
 * @returns {number} Validated timeout in milliseconds.
 * @throws {Error} If the value is present but invalid.
 */
function resolveTimeoutMs(action) {
  const raw = action?.timeoutMs;
  if (raw === undefined) {
    return 300000;
  }
  if (raw === null || typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new Error(
      `action.timeoutMs must be a finite integer, got: ${JSON.stringify(raw)}`,
    );
  }
  if (raw < 30000 || raw > 900000) {
    throw new Error(
      `action.timeoutMs must be between 30000 and 900000, got: ${raw}`,
    );
  }
  return raw;
}

/**
 * Run a CLI command using execFile (never shell: true).
 */
async function run(cmd, args, options = {}) {
  return execFile(cmd, args, {
    shell: false,
    encoding: 'utf8',
    timeout: 30_000,
    ...options,
  });
}

/**
 * Validate that a manifest file exists and contains required fields.
 *
 * @param {string} manifestPath - Absolute path to the manifest JSON file.
 * @param {string[]} requiredFields - Fields that must be present.
 * @returns {Promise<{ valid: boolean, manifest: Object|null, missing: string[], error: string|null }>}
 */
async function validateManifestFile(manifestPath, requiredFields) {
  try {
    const content = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(content);

    const missing = requiredFields.filter((f) => !(f in manifest));

    return {
      valid: missing.length === 0,
      manifest,
      missing,
      error: missing.length > 0 ? `Missing required fields: ${missing.join(', ')}` : null,
    };
  } catch (err) {
    return {
      valid: false,
      manifest: null,
      missing: requiredFields,
      error: `Failed to read manifest: ${err.message}`,
    };
  }
}

/**
 * Check that required files exist in a directory.
 *
 * @param {string} dir - Absolute path to check.
 * @param {string[]} requiredFiles - File paths relative to dir.
 * @returns {Promise<{ allPresent: boolean, missing: string[] }>}
 */
async function checkRequiredFiles(dir, requiredFiles) {
  const missing = [];
  for (const file of requiredFiles) {
    try {
      await stat(resolve(dir, file));
    } catch {
      missing.push(file);
    }
  }
  return { allPresent: missing.length === 0, missing };
}

/**
 * Create the plugin-marketplace adapter.
 *
 * @param {Object} [deps]
 * @param {typeof run} [deps.exec] - Injectable exec function for testing.
 * @returns {import('./contract.mjs').Adapter}
 */
export function createPluginMarketplaceAdapter(deps = {}) {
  const exec = deps.exec ?? run;

  return Object.freeze({
    name: NAME,
    actionTypes: SUPPORTED_TYPES,

    /**
     * Preflight: read-only checks before execution.
     * Fail-closed: snapshotPath, ref, manifestDigest are required for
     * marketplace install actions.
     */
    async preflight(action, context) {
      const { actionType } = action;

      try {
        if (actionType === ActionType.PLUGIN_MANIFEST_VALIDATE) {
          const manifestPath = action.manifestPath;
          if (!manifestPath) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'manifestPath is required',
            });
          }

          // Read-only check: manifest file exists and is parseable
          const result = await validateManifestFile(manifestPath, [
            'name',
            'version',
            'description',
          ]);

          if (!result.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: result.error,
            });
          }

          return createResult({
            actionType,
            status: ActionStatus.PREFLIGHT_PASSED,
          });
        }

        if (actionType === ActionType.PLUGIN_INSTALL_CHECK) {
          const pluginDir = action.pluginDir;
          if (!pluginDir) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'pluginDir is required',
            });
          }

          // Check directory exists
          try {
            const s = await stat(pluginDir);
            if (!s.isDirectory()) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `pluginDir is not a directory: ${pluginDir}`,
              });
            }
          } catch {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `pluginDir does not exist: ${pluginDir}`,
            });
          }

          return createResult({
            actionType,
            status: ActionStatus.PREFLIGHT_PASSED,
          });
        }

        // Marketplace install preflight: fail-closed validation
        if (
          actionType === ActionType.CLAUDE_MARKETPLACE_INSTALL ||
          actionType === ActionType.CODEX_MARKETPLACE_INSTALL
        ) {
          // 1. Validate all parameters for injection safety
          const validation = validateMarketplaceParams(action);
          if (!validation.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: validation.error,
            });
          }

          // 2. ref is required and must be safe
          const ref = action.ref;
          if (!ref) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'ref is required for marketplace install',
            });
          }
          const refValidation = validateSafeRef(ref);
          if (!refValidation.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: refValidation.error,
            });
          }

          // 3. snapshotPath is required
          const snapshotPath = action.snapshotPath;
          if (!snapshotPath) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'snapshotPath is required for marketplace install',
            });
          }

          // 4. manifestDigest is required
          const manifestDigest = action.manifestDigest;
          if (!manifestDigest || typeof manifestDigest !== 'string') {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'manifestDigest is required for marketplace install',
            });
          }
          if (!/^[a-f0-9]{64}$/.test(manifestDigest)) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `manifestDigest must be a 64-char lowercase hex string`,
            });
          }

          // 5. Validate context (root and runDir required)
          if (!context?.root) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'context.root is required for marketplace install',
            });
          }
          if (!context.runDir) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'context.runDir is required for marketplace install',
            });
          }

          // 6. Verify frozen snapshot exists and contains required marketplace files
          const consumer = action.consumer;
          let snapshotDirReal;
          try {
            snapshotDirReal = await resolveFrozenPath(context.root, snapshotPath, 'frozen snapshot path');
          } catch (frozenErr) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `frozen snapshot validation failed: ${frozenErr.message}`,
            });
          }

          // Verify marketplace files exist.
          // marketplace.json is at the snapshot root; plugin manifest is
          // resolved relative to the entry's declared source path.
          const marketplaceRelative = consumer === 'claude'
            ? '.claude-plugin/marketplace.json'
            : '.agents/plugins/marketplace.json';

          const marketplacePath = resolve(snapshotDirReal, marketplaceRelative);

          // marketplace.json must exist and have root name (no root version required)
          const marketplaceResult = await validateManifestFile(marketplacePath, ['name']);
          if (!marketplaceResult.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `frozen snapshot ${marketplaceRelative} invalid: ${marketplaceResult.error}`,
            });
          }

          // Root name must equal action.marketplace
          if (marketplaceResult.manifest.name !== action.marketplace) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace.json name "${marketplaceResult.manifest.name}" does not match action marketplace "${action.marketplace}"`,
            });
          }

          // plugins[] must exist with exactly one entry matching action.plugin
          const plugins = marketplaceResult.manifest.plugins;
          if (!Array.isArray(plugins)) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `${marketplaceRelative} must have a plugins[] array`,
            });
          }
          const pluginEntry = plugins.filter((p) => p.name === action.plugin);
          if (pluginEntry.length !== 1) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `expected exactly one plugins[] entry with name "${action.plugin}", found ${pluginEntry.length}`,
            });
          }
          const entry = pluginEntry[0];

          // Entry source must be a safe relative path within the snapshot.
          // Accepts "./" (root-level), "./adapters/claude" (subdirectory),
          // etc. Rejects absolute paths, ".." traversal, remote URLs, and
          // empty strings.
          const sourcePath = consumer === 'claude'
            ? entry.source
            : entry.source?.source === 'local' ? entry.source?.path : null;
          if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace plugin entry source must be a non-empty relative path${consumer === 'codex' ? ' (object with source:"local")' : ''}, got ${JSON.stringify(entry.source)}`,
            });
          }
          if (
            sourcePath.startsWith('/') ||
            sourcePath.includes('..') ||
            sourcePath.includes('\\') ||
            /^https?:\/\//i.test(sourcePath)
          ) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace plugin entry source "${sourcePath}" is not a safe relative path`,
            });
          }
          // Verify the declared source directory exists and contains the
          // expected plugin manifest inside the frozen snapshot.
          const sourceDirAbs = resolve(snapshotDirReal, sourcePath);
          const sourceDirReal = await realpath(sourceDirAbs).catch(() => null);
          if (!sourceDirReal) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace plugin entry source directory does not exist: ${sourcePath}`,
            });
          }
          // Containment check: source must stay inside the snapshot
          const sourceRelCheck = relative(snapshotDirReal, sourceDirReal);
          if (sourceRelCheck.startsWith('..') || isAbsolute(sourceRelCheck)) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace plugin entry source "${sourcePath}" escapes the frozen snapshot`,
            });
          }

          // Resolve plugin manifest relative to the declared source path.
          // For root layouts (source: "./"), this resolves to
          //   snapshot/.claude-plugin/plugin.json
          // For subdirectory layouts (source: "./adapters/claude"), this resolves to
          //   snapshot/adapters/claude/.claude-plugin/plugin.json
          const manifestRelative = consumer === 'claude'
            ? join(sourcePath, '.claude-plugin', 'plugin.json')
            : join(sourcePath, '.codex-plugin', 'plugin.json');
          const manifestPath = resolve(snapshotDirReal, manifestRelative);

          const manifestResult = await validateManifestFile(manifestPath, ['name', 'version']);
          if (!manifestResult.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `frozen snapshot ${manifestRelative} invalid: ${manifestResult.error}`,
            });
          }

          // Claude carries the version in the marketplace entry. Codex keeps
          // the authoritative version in .codex-plugin/plugin.json.
          if (consumer === 'claude' && entry.version !== action.version) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace plugin entry version "${entry.version}" does not match action version "${action.version}"`,
            });
          }

          // Verify plugin manifest name/version match marketplace entry
          const pluginManifestResult = await validateManifestFile(manifestPath, ['name', 'version']);
          if (!pluginManifestResult.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `frozen snapshot ${manifestRelative} invalid: ${pluginManifestResult.error}`,
            });
          }
          if (pluginManifestResult.manifest.name !== entry.name) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `plugin manifest name "${pluginManifestResult.manifest.name}" does not match marketplace entry name "${entry.name}"`,
            });
          }
          if (pluginManifestResult.manifest.version !== action.version) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `plugin manifest version "${pluginManifestResult.manifest.version}" does not match action version "${action.version}"`,
            });
          }

          // Verify entrySkill file exists in snapshot
          const entrySkillFile = resolve(snapshotDirReal, 'skills', action.entrySkill, 'SKILL.md');
          try {
            await stat(entrySkillFile);
          } catch {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `entry skill not found in snapshot: skills/${action.entrySkill}/SKILL.md`,
            });
          }

          // Verify manifestDigest matches actual snapshot content using frozen algorithm
          try {
            const { digest: actualDigest } = await computeFrozenSnapshot(snapshotDirReal);
            if (actualDigest !== manifestDigest) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `manifestDigest mismatch: expected ${manifestDigest.slice(0, 16)}..., actual ${actualDigest.slice(0, 16)}...`,
              });
            }
          } catch (digestErr) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `failed to compute snapshot digest: ${digestErr.message}`,
            });
          }

          return createResult({
            actionType,
            status: ActionStatus.PREFLIGHT_PASSED,
          });
        }

        return createResult({
          actionType,
          status: ActionStatus.PREFLIGHT_FAILED,
          error: `Unsupported action type: ${actionType}`,
        });
      } catch (err) {
        return createResult({
          actionType,
          status: ActionStatus.PREFLIGHT_FAILED,
          error: err.message,
        });
      }
    },

    /**
     * Execute: perform the validation/write action. For marketplace,
     * "execute" means running structured validation.
     * Some actions require authorization (e.g., updating remote metadata).
     */
    async execute(action, context) {
      const { actionType } = action;

      // Plugin validation is read-only; no authorization needed for validate
      // Only actual remote writes require authorization
      if (actionType === ActionType.PLUGIN_MANIFEST_VALIDATE) {
        try {
          const manifestPath = action.manifestPath;
          const requiredFields = action.requiredFields ?? ['name', 'version', 'description'];

          const result = await validateManifestFile(manifestPath, requiredFields);

          if (!result.valid) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: result.error,
              observation: { valid: false, missing: result.missing },
            });
          }

          // Additional structural validation via node --check if a JS entry is specified
          if (action.entryPoint) {
            try {
              await exec(process.execPath, ['--check', action.entryPoint]);
            } catch (checkErr) {
              return createResult({
                actionType,
                status: ActionStatus.EXECUTE_FAILED,
                error: `Entry point syntax check failed: ${checkErr.message}`,
              });
            }
          }

          return createResult({
            actionType,
            status: ActionStatus.EXECUTED,
            observation: {
              valid: true,
              manifest: result.manifest,
              manifestPath,
            },
          });
        } catch (err) {
          return createResult({
            actionType,
            status: ActionStatus.EXECUTE_FAILED,
            error: err.message,
          });
        }
      }

      if (actionType === ActionType.PLUGIN_INSTALL_CHECK) {
        // Install check may involve writing temp files in some cases
        // For now it's read-only, so no authorization check needed
        try {
          const { pluginDir, requiredFiles } = action;
          const check = await checkRequiredFiles(pluginDir, requiredFiles ?? []);

          if (!check.allPresent) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: `Missing required files: ${check.missing.join(', ')}`,
              observation: { allPresent: false, missing: check.missing },
            });
          }

          // Smoke test: try loading the entry point
          if (action.entryPoint) {
            try {
              await exec(process.execPath, ['--check', resolve(pluginDir, action.entryPoint)]);
            } catch (checkErr) {
              return createResult({
                actionType,
                status: ActionStatus.EXECUTE_FAILED,
                error: `Install smoke test failed: ${checkErr.message}`,
              });
            }
          }

          return createResult({
            actionType,
            status: ActionStatus.EXECUTED,
            observation: {
              allPresent: true,
              pluginDir,
              checkedFiles: requiredFiles ?? [],
            },
          });
        } catch (err) {
          return createResult({
            actionType,
            status: ActionStatus.EXECUTE_FAILED,
            error: err.message,
          });
        }
      }

      // Marketplace install execute
      if (
        actionType === ActionType.CLAUDE_MARKETPLACE_INSTALL ||
        actionType === ActionType.CODEX_MARKETPLACE_INSTALL
      ) {
        try {
          assertIsolatedConsumerWritesAuthorized(context, actionType);

          const validation = validateMarketplaceParams(action);
          if (!validation.valid) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: validation.error,
            });
          }

          // Validate context
          if (!context?.root) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: 'context.root is required for marketplace install',
            });
          }
          if (!context.runDir) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: 'context.runDir is required for marketplace install',
            });
          }

          const consumer = action.consumer;
          const runDir = context.runDir;
          const isolatedHome = resolve(runDir, 'consumers', `${consumer}-${action.plugin}`);

          // Verify consumer directory is inside runDir
          const runDirReal = await realpath(runDir).catch(() => runDir);
          const isolatedHomePreReal = await realpath(isolatedHome).catch(() => isolatedHome);
          const relToRun = relative(runDirReal, isolatedHomePreReal);
          const sepE = process.platform === 'win32' ? '\\' : '/';
          if (relToRun !== '' && (isAbsolute(relToRun) || relToRun === '..' || relToRun.startsWith(`..${sepE}`))) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: `consumer directory escapes runDir: ${isolatedHome}`,
            });
          }

          // Create isolated HOME and required subdirectories
          await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
          if (consumer === 'claude') {
            await mkdir(resolve(isolatedHome, '.claude'), { recursive: true, mode: 0o700 });
          } else {
            await mkdir(resolve(isolatedHome, '.codex'), { recursive: true, mode: 0o700 });
          }

          const cliCmd = consumer === 'claude' ? 'claude' : 'codex';
          const baseEnv = { ...process.env, ...context.env };
          const env = {
            ...baseEnv,
            ...(consumer === 'claude'
              ? { HOME: isolatedHome, CLAUDE_CONFIG_DIR: resolve(isolatedHome, '.claude') }
              : { HOME: isolatedHome, CODEX_HOME: isolatedHome }),
          };
          // Ensure real HOME/CODEX_HOME don't leak back (already overridden above)

          // Resolve frozen timeoutMs from the expanded action (top-level,
          // not action.parameters -- the publish/reconcile/verify call path
          // expands plan action as { actionType, ...action.parameters }).
          // Default to 300000 for old plans that lack the field.
          // Fail closed on invalid values (null, non-integer, non-finite,
          // out of range).
          let frozenTimeoutMs;
          try {
            frozenTimeoutMs = resolveTimeoutMs(action);
          } catch (timeoutErr) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: timeoutErr.message,
            });
          }

          // Step 1: Add marketplace
          const ref = action.ref ?? `v${action.version}`;
          let addOutput;
          const marketplaceArgs = consumer === 'claude'
            ? ['plugin', 'marketplace', 'add', `${action.repo}@${ref}`]
            : ['plugin', 'marketplace', 'add', action.repo, '--ref', ref, '--json'];
          try {
            const addResult = await exec(cliCmd, marketplaceArgs, { env, cwd: context.root, timeout: frozenTimeoutMs });
            if (consumer === 'codex') {
              try {
                addOutput = JSON.parse(addResult.stdout);
                if (!addOutput || typeof addOutput !== 'object') {
                  return createResult({
                    actionType,
                    status: ActionStatus.EXECUTE_FAILED,
                    error: 'marketplace add returned invalid JSON output',
                  });
                }
                if (addOutput.marketplaceName !== action.marketplace) {
                  return createResult({
                    actionType,
                    status: ActionStatus.EXECUTE_FAILED,
                    error: `marketplace add marketplaceName "${addOutput.marketplaceName}" does not match action marketplace "${action.marketplace}"`,
                  });
                }
              } catch {
                return createResult({
                  actionType,
                  status: ActionStatus.EXECUTE_FAILED,
                  error: 'marketplace add returned malformed JSON',
                });
              }
            }
          } catch (addErr) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: `marketplace add failed: ${addErr.message}`,
            });
          }

          // Step 2: Install plugin
          let installOutput;
          const installArgs = consumer === 'claude'
            ? ['plugin', 'install', `${action.plugin}@${action.marketplace}`]
            : ['plugin', 'add', `${action.plugin}@${action.marketplace}`, '--json'];
          try {
            const installResult = await exec(cliCmd, installArgs, { env, cwd: context.root, timeout: frozenTimeoutMs });
            if (consumer === 'codex') {
              try {
                installOutput = JSON.parse(installResult.stdout);
                if (!installOutput || typeof installOutput !== 'object') {
                  return createResult({
                    actionType,
                    status: ActionStatus.EXECUTE_FAILED,
                    error: 'plugin install returned invalid JSON output',
                  });
                }
                const expectedPluginId = `${action.plugin}@${action.marketplace}`;
                const installFields = {
                  pluginId: installOutput.pluginId,
                  name: installOutput.name,
                  marketplaceName: installOutput.marketplaceName,
                  version: installOutput.version,
                  installedPath: installOutput.installedPath,
                };
                const expectedFields = {
                  pluginId: expectedPluginId,
                  name: action.plugin,
                  marketplaceName: action.marketplace,
                  version: action.version,
                  installedPath: undefined, // must exist and be non-empty
                };
                for (const [field, expected] of Object.entries(expectedFields)) {
                  if (field === 'installedPath') {
                    if (!installFields.installedPath) {
                      return createResult({
                        actionType,
                        status: ActionStatus.EXECUTE_FAILED,
                        error: `plugin install JSON missing installedPath`,
                      });
                    }
                    // installedPath must be inside isolated HOME
                    const installPathAbs = resolve(installFields.installedPath);
                    const installPathRel = relative(isolatedHome, installPathAbs);
                    if (isAbsolute(installPathRel) || installPathRel === '..' || installPathRel.startsWith(`..${sepE}`)) {
                      return createResult({
                        actionType,
                        status: ActionStatus.EXECUTE_FAILED,
                        error: `plugin install installedPath escapes isolated HOME: ${installFields.installedPath}`,
                      });
                    }
                  } else if (installFields[field] !== expected) {
                    return createResult({
                      actionType,
                      status: ActionStatus.EXECUTE_FAILED,
                      error: `plugin install JSON ${field} "${installFields[field]}" does not match expected "${expected}"`,
                    });
                  }
                }
              } catch {
                return createResult({
                  actionType,
                  status: ActionStatus.EXECUTE_FAILED,
                  error: 'plugin install returned malformed JSON',
                });
              }
            }
          } catch (installErr) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: `plugin install failed: ${installErr.message}`,
            });
          }

          // Build and write structured evidence for observe cross-validation
          const evidence = {
            isolatedHome,
            consumer,
            plugin: action.plugin,
            marketplace: action.marketplace,
            repo: action.repo,
            ref,
            version: action.version,
            addOutput,
            installOutput,
            executedAt: new Date().toISOString(),
          };

          // Write evidence file to runDir/evidence/ (outside isolatedHome/installPath digest scope)
          const evidenceDir = resolve(runDir, 'evidence', `${consumer}-${action.plugin}`);
          await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
          const evidencePath = resolve(evidenceDir, 'release-skill-install-evidence.json');
          await writeEvidenceAtomic(evidencePath, evidence);

          // Compute manifestDigest from installed content and build
          // expected-compatible observation for executeCheckpoint's
          // matchObservation check.
          const installPath = installOutput?.installedPath;
          let executeManifestDigest = null;
          if (installPath) {
            try {
              executeManifestDigest = await verifyInstalledMarketplacePayload(
                action,
                context,
                installPath,
                consumer,
              );
            } catch {
              // Digest computation failure is caught at verify time
            }
          }

          const executeObservation = {
            ...evidence,
            installed: true,
            entrySkill: action.entrySkill,
            ...(executeManifestDigest ? { manifestDigest: executeManifestDigest } : {}),
          };

          return createResult({
            actionType,
            status: ActionStatus.EXECUTED,
            observation: executeObservation,
          });
        } catch (err) {
          return createResult({
            actionType,
            status: ActionStatus.EXECUTE_FAILED,
            error: err.message,
          });
        }
      }

      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `Unsupported action type: ${actionType}`,
      });
    },

    /**
     * Observe: read the current state of the plugin manifest and content.
     * Never infers success from exit code alone.
     *
     * For Claude: uses id === "plugin@marketplace" match in list array,
     * reads installPath from CLI output, verifies install dir is inside
     * isolated HOME, computes real manifestDigest from installed content.
     *
     * For Codex: uses pluginId === "plugin@marketplace" match in installed array,
     * reads installedPath from add/install output or list, verifies install dir
     * is inside isolated HOME, computes real manifestDigest.
     */
    async observe(action, context) {
      const { actionType } = action;

      try {
        if (actionType === ActionType.PLUGIN_MANIFEST_VALIDATE) {
          const manifestPath = action.manifestPath;
          try {
            const content = await readFile(manifestPath, 'utf8');
            const manifest = JSON.parse(content);
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                exists: true,
                name: manifest.name,
                version: manifest.version,
                description: manifest.description,
              },
            });
          } catch {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: { exists: false },
            });
          }
        }

        if (actionType === ActionType.PLUGIN_INSTALL_CHECK) {
          const { pluginDir, requiredFiles } = action;
          const check = await checkRequiredFiles(pluginDir, requiredFiles ?? []);

          return createResult({
            actionType,
            status: ActionStatus.OBSERVED,
            observation: {
              allPresent: check.allPresent,
              missing: check.missing,
              pluginDir,
            },
          });
        }

        // Marketplace install observe
        if (
          actionType === ActionType.CLAUDE_MARKETPLACE_INSTALL ||
          actionType === ActionType.CODEX_MARKETPLACE_INSTALL
        ) {
          const consumer = action.consumer;
          const runDir = context.runDir;
          if (!runDir) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: { installed: false, error: 'context.runDir is required' },
            });
          }
          const isolatedHome = resolve(runDir, 'consumers', `${consumer}-${action.plugin}`);
          const cliCmd = consumer === 'claude' ? 'claude' : 'codex';
          const baseEnv = { ...process.env, ...(context.env ?? {}) };
          const env = {
            ...baseEnv,
            ...(consumer === 'claude'
              ? { HOME: isolatedHome, CLAUDE_CONFIG_DIR: resolve(isolatedHome, '.claude') }
              : { HOME: isolatedHome, CODEX_HOME: isolatedHome }),
          };

          // Resolve frozen timeoutMs from the expanded action (top-level).
          // Default to 300000 for old plans. Fail closed on invalid values.
          let frozenTimeoutMs;
          try {
            frozenTimeoutMs = resolveTimeoutMs(action);
          } catch (timeoutErr) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: { installed: false, error: timeoutErr.message },
              error: timeoutErr.message,
            });
          }

          // Read execute evidence — mandatory for observe validation
          let evidence = null;
          try {
            const evidenceRaw = await readFile(resolve(runDir, 'evidence', `${consumer}-${action.plugin}`, 'release-skill-install-evidence.json'), 'utf8');
            evidence = JSON.parse(evidenceRaw);
          } catch {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: false,
                error: 'execute evidence file is missing or unreadable',
              },
            });
          }

          if (
            evidence.consumer !== consumer ||
            evidence.plugin !== action.plugin ||
            evidence.marketplace !== action.marketplace ||
            evidence.version !== action.version ||
            evidence.repo !== action.repo ||
            evidence.ref !== action.ref ||
            evidence.isolatedHome !== isolatedHome
          ) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: false,
                error: 'execute evidence identity does not match the frozen action',
              },
            });
          }

          // Run list command to verify installation
          const listArgs = consumer === 'claude'
            ? ['plugin', 'list', '--json']
            : ['plugin', 'list', '--json'];

          let listOutput;
          try {
            const result = await exec(cliCmd, listArgs, { env, cwd: context.root, timeout: frozenTimeoutMs });
            listOutput = JSON.parse(result.stdout);
          } catch (listErr) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: false,
                error: `list command failed: ${listErr.message}`,
              },
            });
          }

          const pluginId = `${action.plugin}@${action.marketplace}`;
          let found = null;
          let installPath = null;

          if (consumer === 'claude') {
            // Claude: list returns an array; find by id === "plugin@marketplace"
            if (!Array.isArray(listOutput)) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: 'Claude plugin list did not return an array',
                },
              });
            }
            found = listOutput.find((p) => p.id === pluginId);
            if (!found) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `plugin "${pluginId}" not found in Claude plugin list`,
                },
              });
            }
            if (!found.installPath) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `plugin "${pluginId}" found but missing installPath`,
                },
              });
            }
            installPath = found.installPath;
          } else {
            // Codex: installPath comes from validated evidence, not from list
            installPath = evidence.installOutput?.installedPath;
            if (!installPath) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: 'evidence install JSON missing installedPath',
                },
              });
            }

            // Cross-validate with list (list does NOT provide installedPath)
            const installed = listOutput?.installed;
            if (!Array.isArray(installed)) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: 'Codex plugin list did not return {installed: [...]}',
                },
              });
            }
            found = installed.find((p) => p.pluginId === pluginId);
            if (!found) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `plugin "${pluginId}" not found in Codex installed list`,
                },
              });
            }
            // Cross-validate: list fields must match evidence/action
            if (found.name !== action.plugin) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: `list name "${found.name}" does not match action plugin "${action.plugin}"` },
              });
            }
            if (found.marketplaceName !== action.marketplace) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: `list marketplaceName "${found.marketplaceName}" does not match action marketplace "${action.marketplace}"` },
              });
            }
            if (found.version !== action.version) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: `list version "${found.version}" does not match action version "${action.version}"` },
              });
            }
          }

          // Verify installPath is inside or at isolated HOME (path escape protection)
          const isolatedHomeReal = await realpath(isolatedHome).catch(() => isolatedHome);
          const installPathReal = await realpath(installPath).catch(() => installPath);
          const relToHome = relative(isolatedHomeReal, installPathReal);
          const sep = process.platform === 'win32' ? '\\' : '/';
          if (
            relToHome !== '' &&
            (isAbsolute(relToHome) || relToHome === '..' || relToHome.startsWith(`..${sep}`))
          ) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: false,
                error: `install path escapes isolated HOME: ${installPath}`,
              },
            });
          }

          // Verify entry skill exists as a regular file in install dir
          const entrySkillPath = resolve(installPath, 'skills', action.entrySkill, 'SKILL.md');
          let entrySkillFound = false;
          try {
            const skillStat = await lstat(entrySkillPath);
            if (skillStat.isFile() && !skillStat.isSymbolicLink()) {
              entrySkillFound = true;
            }
          } catch {
            // entry skill not found
          }

          if (!entrySkillFound) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: false,
                error: `entry skill not found: skills/${action.entrySkill}/SKILL.md`,
              },
            });
          }

          // Bind the installed payload back to the sealed authority while
          // normalizing only transport-restored write permission bits.
          let manifestDigest;
          let manifestError = null;
          try {
            manifestDigest = await verifyInstalledMarketplacePayload(
              action,
              context,
              installPath,
              consumer,
            );
          } catch (digestErr) {
            // Preserve independently observed fields for diagnostics. This
            // raw digest is not accepted as plan authority because the error
            // is returned and verify therefore fails closed.
            try {
              const installedSnapshot = await computeFrozenSnapshot(installPath, {
                excludeRootEntries: consumer === 'codex' ? ['.git'] : [],
              });
              manifestDigest = installedSnapshot.digest;
            } catch {
              manifestDigest = undefined;
            }
            manifestError = `failed to bind manifestDigest to frozen authority: ${digestErr.message}`;
          }

          // Build observation with CLI-proven fields only (no action backfill)
          const observation = {
            installed: true,
            installPath,
            entrySkillFound: true,
            entrySkill: action.entrySkill,
            manifestDigest,
            consumer,
          };

          // Fields from CLI evidence only
          if (consumer === 'claude') {
            // Claude list may not have name; extract plugin/marketplace from id
            const idParts = found.id.split('@');
            observation.plugin = idParts[0];
            observation.marketplace = idParts.slice(1).join('@');
            if (found.version) observation.version = found.version;
          } else {
            if (found.name) observation.plugin = found.name;
            if (found.marketplaceName) observation.marketplace = found.marketplaceName;
            if (found.version) observation.version = found.version;
          }

          // Cross-validate version: evidence vs CLI
          if (evidence.version && observation.version && evidence.version !== observation.version) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: true,
                manifestDigest,
                error: `version mismatch: CLI reports ${observation.version}, evidence shows ${evidence.version}`,
              },
            });
          }

          // Verify installed manifest name/version matches CLI/evidence
          try {
            const installedManifestPath = resolve(installPath, consumer === 'claude' ? '.claude-plugin/plugin.json' : '.codex-plugin/plugin.json');
            const installedManifestContent = await readFile(installedManifestPath, 'utf8');
            const installedManifest = JSON.parse(installedManifestContent);
            const expectedName = observation.plugin;
            if (expectedName && installedManifest.name !== expectedName) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath,
                  entrySkillFound: true,
                  manifestDigest,
                  error: `installed manifest name "${installedManifest.name}" does not match CLI plugin "${expectedName}"`,
                },
              });
            }
            if (observation.version && installedManifest.version !== observation.version) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath,
                  entrySkillFound: true,
                  manifestDigest,
                  error: `installed manifest version "${installedManifest.version}" does not match CLI version "${observation.version}"`,
                },
              });
            }
          } catch (manifestErr) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: true,
                manifestDigest,
                error: `installed plugin manifest is missing or invalid: ${manifestErr.message}`,
              },
            });
          }

          // Cross-validate repo/ref: evidence requested values must match current action
          if (evidence.repo && evidence.repo !== action.repo) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: true,
                manifestDigest,
                error: `evidence repo "${evidence.repo}" does not match action repo "${action.repo}"`,
              },
            });
          }
          if (evidence.ref && evidence.ref !== action.ref) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: true,
                manifestDigest,
                error: `evidence ref "${evidence.ref}" does not match action ref "${action.ref}"`,
              },
            });
          }

          // Output repo/ref only after cross-validation
          if (evidence.repo) observation.repo = evidence.repo;
          if (evidence.ref) observation.ref = evidence.ref;

          return createResult({
            actionType,
            status: ActionStatus.OBSERVED,
            observation,
            error: manifestError,
          });
        }

        return createResult({
          actionType,
          status: ActionStatus.OBSERVED,
          observation: {},
        });
      } catch (err) {
        return createResult({
          actionType,
          status: ActionStatus.OBSERVED,
          error: err.message,
          observation: {},
        });
      }
    },

    /**
     * Verify: compare observed state against the frozen plan's expected state.
     */
    async verify(action, context) {
      const observed = await this.observe(action, context);

      if (observed.error) {
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.VERIFY_FAILED,
          observation: observed.observation,
          error: observed.error,
        });
      }

      const expected = action.expected ?? {};
      const { matches, mismatches } = matchObservation(expected, observed.observation);

      return createResult({
        actionType: action.actionType,
        status: matches ? ActionStatus.VERIFIED : ActionStatus.VERIFY_FAILED,
        observation: observed.observation,
        error: matches ? null : `Observation mismatch: ${mismatches.join('; ')}`,
      });
    },
  });
}
