/**
 * Shared project lock for artifact commands.
 *
 * All mutating artifact commands (apply, accept, recover, resolve submit,
 * prepare) share a single project lock domain. The lock is acquired via
 * exclusive `mkdir(.release-skill/lock)` — atomic on all POSIX filesystems.
 *
 * Owner record contains: pid, host, bootId (or session id), nonce, command,
 * startedAt. The owner JSON and parent directory are fsynced before the
 * acquire call returns success.
 *
 * TTL is informational only — aging a lock directory never permits automatic
 * deletion. Only the exact owner can release, or an operator can break the
 * lock with `breakProjectLock` which requires matching the exact owner and
 * writes audit evidence.
 *
 * @module artifacts/project-lock
 */

import { mkdir, rm, writeFile, readFile, readdir, stat, lstat, open } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  ReleaseError,
  TRANSACTION_INCOMPLETE,
  PATH_UNSAFE,
} from '../core/errors.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCK_DIR_NAME = 'lock';
const OWNER_FILE_NAME = '.owner';
const AUDIT_DIR_NAME = 'lock-audit';

/** All owner fields that must match exactly. */
const OWNER_FIELDS = ['pid', 'host', 'bootId', 'nonce', 'command', 'startedAt'];

// ---------------------------------------------------------------------------
// Owner construction
// ---------------------------------------------------------------------------

/**
 * Build an owner record for the current process.
 *
 * @param {string} command - The command acquiring the lock.
 * @param {() => string} [clock] - Clock function for timestamps.
 * @returns {object} Frozen owner record.
 */
function buildOwner(command, clock) {
  const startedAt = clock ? clock() : new Date().toISOString();
  assertIsoTimestamp(startedAt, 'clock result');
  return Object.freeze({
    pid: process.pid,
    host: hostname(),
    bootId: getBootId(),
    nonce: randomBytes(16).toString('hex'),
    command,
    startedAt,
  });
}

/**
 * Get a boot or session identifier.
 *
 * On Linux, reads /proc/sys/kernel/random/boot_id. On other platforms,
 * falls back to a process-lifetime constant derived from process.pid +
 * start time.
 *
 * @returns {string} Boot/session identifier.
 */
function getBootId() {
  try {
    // Linux: stable across reboots
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    // Fallback: pid + uptime at module load time (stable within process)
    return `pid-${process.pid}-uptime-${Math.floor(process.uptime())}`;
  }
}

// ---------------------------------------------------------------------------
// Internal: path helpers
// ---------------------------------------------------------------------------

function lockDir(root) {
  return join(root, '.release-skill', LOCK_DIR_NAME);
}

function ownerPath(root) {
  return join(lockDir(root), OWNER_FILE_NAME);
}

function auditDir(root) {
  return join(root, '.release-skill', AUDIT_DIR_NAME);
}

// ---------------------------------------------------------------------------
// Internal: owner validation
// ---------------------------------------------------------------------------

/**
 * Validate that an expectedOwner object is structurally sound:
 * - Must be a plain object (not array, not null)
 * - Must have exactly the 6 required fields (no extra, no missing)
 * - pid must be a positive integer
 * - All other fields must be non-empty strings
 * - String fields must not contain control characters
 *
 * @param {object} owner - The owner object to validate.
 * @throws {ReleaseError} PATH_UNSAFE on any violation.
 */
function validateOwnerObject(owner) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    throw new ReleaseError(PATH_UNSAFE, 'expectedOwner must be a plain object', {});
  }

  const keys = Object.keys(owner);
  const expectedSet = new Set(OWNER_FIELDS);
  const actualSet = new Set(keys);

  if (keys.length !== OWNER_FIELDS.length) {
    throw new ReleaseError(
      PATH_UNSAFE,
      `expectedOwner must have exactly ${OWNER_FIELDS.length} fields; got ${keys.length}`,
      {},
    );
  }

  for (const field of OWNER_FIELDS) {
    if (!actualSet.has(field)) {
      throw new ReleaseError(PATH_UNSAFE, `expectedOwner missing required field: ${field}`, {});
    }
  }

  for (const key of keys) {
    if (!expectedSet.has(key)) {
      throw new ReleaseError(PATH_UNSAFE, `expectedOwner has unexpected field: ${key}`, {});
    }
  }

  // Type validation
  if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    throw new ReleaseError(PATH_UNSAFE, 'expectedOwner.pid must be a positive integer', {});
  }

  const stringFields = OWNER_FIELDS.filter((f) => f !== 'pid');
  for (const field of stringFields) {
    if (typeof owner[field] !== 'string' || owner[field].trim().length === 0) {
      throw new ReleaseError(PATH_UNSAFE, `expectedOwner.${field} must be a non-empty string`, {});
    }
  }

  // Control character check on all string fields
  for (const field of stringFields) {
    if (/[\x00-\x1f\x7f]/.test(owner[field])) {
      throw new ReleaseError(PATH_UNSAFE, `expectedOwner.${field} contains control characters`, {});
    }
  }

  // nonce becomes part of an audit filename, so accept only the format
  // produced by buildOwner(). This excludes separators, dot segments and
  // platform-specific path syntax by construction.
  if (!/^[a-f0-9]{32}$/.test(owner.nonce)) {
    throw new ReleaseError(
      PATH_UNSAFE,
      'expectedOwner.nonce must be exactly 32 lowercase hexadecimal characters',
      {},
    );
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(owner.host) || !/^[A-Za-z0-9._:-]+$/.test(owner.bootId)) {
    throw new ReleaseError(PATH_UNSAFE, 'expectedOwner host/bootId contains unsafe characters', {});
  }
  if (sanitizeReason(owner.command) !== owner.command) {
    throw new ReleaseError(PATH_UNSAFE, 'expectedOwner.command must not contain absolute paths', {});
  }
  assertIsoTimestamp(owner.startedAt, 'expectedOwner.startedAt');
}

function assertIsoTimestamp(value, label) {
  if (
    typeof value !== 'string'
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new ReleaseError(PATH_UNSAFE, `${label} must be a canonical ISO-8601 timestamp`, {});
  }
}

// ---------------------------------------------------------------------------
// Internal: reason sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a reason string for audit records.
 *
 * If the reason contains absolute paths (e.g. /Users/..., /home/...),
 * they are deterministically replaced with path-agnostic placeholders.
 * This prevents leaking local filesystem layout into audit files.
 *
 * @param {string} reason - Raw reason text.
 * @returns {string} Sanitized reason text.
 */
function sanitizeReason(reason) {
  return reason
    .replace(/\/Users\/[^\s,;:'")\]]+/g, '<user-path>')
    .replace(/\/home\/[^\s,;:'")\]]+/g, '<user-path>')
    .replace(/\/tmp\/[^\s,;:'")\]]+/g, '<temp-path>')
    .replace(/(^|[\s("'=])\/(?!\/)[^\s,;:'")\]]+/g, '$1<absolute-path>')
    .replace(/(^|[\s("'=])(?:[A-Za-z]:[\\/]|\\\\)[^\s,;:'")\]]+/g, '$1<absolute-path>');
}

async function emitDurability(observer, event) {
  if (!observer) return;
  try {
    await observer(Object.freeze(event));
  } catch {
    // Observation must never weaken, skip or fail a durability operation.
  }
}

async function fsyncFileObserved(filePath, observer) {
  await fsyncFile(filePath);
  await emitDurability(observer, { operation: 'fsync-file', path: filePath });
}

async function fsyncDirObserved(dirPath, observer) {
  await fsyncDir(dirPath);
  await emitDurability(observer, { operation: 'fsync-dir', path: dirPath });
}

// ---------------------------------------------------------------------------
// Internal: assert owner matches on disk
// ---------------------------------------------------------------------------

/**
 * Read the persisted owner from disk and compare with the expected owner.
 * All six fields (pid, host, bootId, nonce, command, startedAt) must match
 * exactly.
 *
 * @param {object} expected - The expected owner record.
 * @param {string} root - Repository root.
 * @returns {Promise<void>}
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE if owner mismatch or missing.
 */
async function assertOwnerOnDisk(expected, root) {
  let raw;
  try {
    raw = await readFile(ownerPath(root), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        'project lock directory does not exist — ownership lost',
        { root },
      );
    }
    throw err;
  }

  let actual;
  try {
    actual = JSON.parse(raw);
  } catch {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'project lock owner file is corrupt',
      { root },
    );
  }

  for (const field of OWNER_FIELDS) {
    if (actual[field] !== expected[field]) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `project lock owner does not match — field "${field}" differs`,
        { root, field, expected: field === 'nonce' ? expected[field]?.slice(0, 8) : undefined },
      );
    }
  }
}

/**
 * Remove the lock directory only if the persisted owner matches exactly.
 * After removal, fsync the parent .release-skill directory for durability.
 *
 * @param {object} expected - The expected owner record.
 * @param {string} root - Repository root.
 * @param {(event: object) => Promise<void>} [durabilityObserver] - Observe completed durability operations.
 * @returns {Promise<void>}
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE if owner mismatch.
 */
async function removeLockIfExactOwner(expected, root, durabilityObserver) {
  await assertOwnerOnDisk(expected, root);
  await rm(lockDir(root), { recursive: true, force: true });
  await emitDurability(durabilityObserver, { operation: 'remove-dir', path: lockDir(root) });
  // Fsync parent directory to persist the lock removal
  await fsyncDirObserved(join(root, '.release-skill'), durabilityObserver);
}

// ---------------------------------------------------------------------------
// Internal: fsync helpers
// ---------------------------------------------------------------------------

/**
 * Fsync a file by path — opens, syncs, closes.
 *
 * @param {string} filePath
 */
async function fsyncFile(filePath) {
  const fh = await open(filePath, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Fsync a directory by path.
 *
 * @param {string} dirPath
 */
async function fsyncDir(dirPath) {
  const fh = await open(dirPath, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Internal: symlink/non-directory fail-closed checks
// ---------------------------------------------------------------------------

/**
 * Assert that a path is not a symlink and, if it exists, is a directory.
 * Fails closed with PATH_UNSAFE on any violation.
 *
 * @param {string} dirPath - Path to check.
 * @param {string} label - Human label for error messages.
 * @returns {Promise<void>}
 * @throws {ReleaseError} PATH_UNSAFE if symlink or non-directory.
 */
async function assertNotSymlinkOrFile(dirPath, label) {
  let st;
  try {
    st = await lstat(dirPath);
  } catch (err) {
    if (err.code === 'ENOENT') return; // doesn't exist yet — OK
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new ReleaseError(
      PATH_UNSAFE,
      `${label} is a symlink — refusing to operate on symlinked path`,
      { path: dirPath },
    );
  }
  if (!st.isDirectory()) {
    throw new ReleaseError(
      PATH_UNSAFE,
      `${label} exists but is not a directory`,
      { path: dirPath },
    );
  }
}

/**
 * Assert that the .release-skill and lock directories are not symlinks.
 * Checks every level: .release-skill, .release-skill/lock, .release-skill/lock-audit.
 *
 * @param {string} root - Repository root.
 * @returns {Promise<void>}
 */
async function assertLockPathsNotSymlinks(root) {
  const releaseSkillDir = join(root, '.release-skill');
  await assertNotSymlinkOrFile(releaseSkillDir, '.release-skill');
  await assertNotSymlinkOrFile(lockDir(root), '.release-skill/lock');
}

/**
 * Assert that the audit directory is not a symlink.
 *
 * @param {string} root - Repository root.
 * @returns {Promise<void>}
 */
async function assertAuditPathNotSymlink(root) {
  const releaseSkillDir = join(root, '.release-skill');
  await assertNotSymlinkOrFile(releaseSkillDir, '.release-skill');
  await assertNotSymlinkOrFile(auditDir(root), '.release-skill/lock-audit');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Acquire the project lock.
 *
 * Uses exclusive `mkdir` to atomically claim the lock. The owner record
 * is written to `.owner` and fsynced before returning.
 *
 * If the lock is already held, throws `TRANSACTION_INCOMPLETE` — there is
 * no automatic stale lock breakage based on TTL.
 *
 * @param {object} options
 * @param {string} options.root - Repository root (absolute).
 * @param {string} options.command - The command acquiring the lock (e.g. 'apply', 'accept').
 * @param {'exclusive'} [options.mode='exclusive'] - Lock mode (currently only exclusive).
 * @param {() => string} [options.clock] - Clock function for timestamps.
 * @param {(event: object) => Promise<void>} [options.durabilityObserver] - Best-effort observer; cannot replace or interrupt fsync.
 * @param {(point: string) => Promise<void>} [options.faultInjector] - Test-only safe failure injection.
 * @returns {Promise<ProjectLock>}
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE if lock is already held.
 */
export async function acquireProjectLock({
  root,
  command,
  mode = 'exclusive',
  clock,
  durabilityObserver,
  faultInjector,
} = {}) {
  if (!root || typeof root !== 'string') {
    throw new ReleaseError(PATH_UNSAFE, 'root must be a non-empty string', { root });
  }
  if (!command || typeof command !== 'string' || command.trim().length === 0) {
    throw new ReleaseError(PATH_UNSAFE, 'command must be a non-empty string', { command });
  }
  if (/[\x00-\x1f\x7f]/.test(command)) {
    throw new ReleaseError(PATH_UNSAFE, 'command contains control characters', {});
  }
  if (sanitizeReason(command) !== command) {
    throw new ReleaseError(PATH_UNSAFE, 'command must not contain absolute paths', {});
  }
  if (mode !== 'exclusive') {
    throw new ReleaseError(
      PATH_UNSAFE,
      `lock mode must be "exclusive"; "${mode}" is not supported`,
      { mode },
    );
  }

  // Construct and validate the owner before touching the filesystem so a bad
  // injected clock cannot leave a directory without an owner.
  const owner = buildOwner(command, clock);

  // Symlink/non-directory fail-closed: check every path level before touching fs
  const releaseSkillDir = join(root, '.release-skill');
  await assertLockPathsNotSymlinks(root);

  // Ensure parent directory exists (only if not already checked as non-symlink)
  let parentExisted = false;
  try {
    await lstat(releaseSkillDir);
    parentExisted = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!parentExisted) {
    await mkdir(releaseSkillDir, { recursive: true, mode: 0o700 });
    await emitDurability(durabilityObserver, { operation: 'create-dir', path: releaseSkillDir });
    // Persist the new .release-skill directory entry in root.
    await fsyncDirObserved(root, durabilityObserver);
  }

  const dir = lockDir(root);

  // Atomic lock acquisition via mkdir. Everything after successful mkdir and
  // before returning is inside one cleanup boundary, so any write/fsync/fault
  // failure cannot leave an ownerless lock directory.
  let lockCreated = false;
  try {
    await mkdir(dir, { recursive: false, mode: 0o700 });
    lockCreated = true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Lock is held — TTL never permits automatic breakage
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        'project lock is already held; another command is in progress',
        { root, lockDir: dir },
      );
    }
    throw err;
  }

  const ownerFilePath = join(dir, OWNER_FILE_NAME);
  try {
    await emitDurability(durabilityObserver, { operation: 'create-dir', path: dir });
    if (faultInjector) await faultInjector('after-lock-create');
    await fsyncDirObserved(releaseSkillDir, durabilityObserver);

    await writeFile(ownerFilePath, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    await emitDurability(durabilityObserver, { operation: 'write-file', path: ownerFilePath });
    if (faultInjector) await faultInjector('after-owner-write');

    // Fsync owner file then lock directory for durability
    await fsyncFileObserved(ownerFilePath, durabilityObserver);
    await fsyncDirObserved(dir, durabilityObserver);
  } catch (writeErr) {
    // Cleanup: remove the lock dir if owner write failed — prevents zombie lock
    // without an owner file (which cannot be broken since break requires owner).
    if (!lockCreated) throw writeErr;
    try {
      await rm(dir, { recursive: true, force: true });
      await emitDurability(durabilityObserver, { operation: 'remove-dir', path: dir });
      await fsyncDirObserved(releaseSkillDir, durabilityObserver);
    } catch (cleanupErr) {
      const incomplete = new ReleaseError(
        TRANSACTION_INCOMPLETE,
        'project lock acquisition failed and cleanup could not be made durable',
        {
          acquireErrorCode: typeof writeErr?.code === 'string' ? writeErr.code : null,
          cleanupErrorCode: typeof cleanupErr?.code === 'string' ? cleanupErr.code : null,
        },
      );
      incomplete.cause = writeErr;
      incomplete.cleanupCause = cleanupErr;
      throw incomplete;
    }
    throw writeErr;
  }

  return Object.freeze({
    owner,

    /**
     * Run a function while asserting lock ownership before and after.
     *
     * Post-owner check runs regardless of whether fn succeeds or throws.
     * If fn throws AND post-owner check fails, the error is TRANSACTION_INCOMPLETE
     * with the original business error as `cause` (fail-closed, never loses the error).
     *
     * @param {() => Promise<T>} fn - Function to execute under lock.
     * @returns {Promise<T>} Result of fn.
     * @throws {ReleaseError} if ownership verification fails.
     */
    async capture(fn) {
      await assertOwnerOnDisk(owner, root);
      let fnResult;
      try {
        fnResult = await fn();
      } catch (fnErr) {
        // fn threw — still perform post-owner check (fail-closed)
        try {
          await assertOwnerOnDisk(owner, root);
        } catch {
          // Both fn error AND owner lost — fail closed with TRANSACTION_INCOMPLETE,
          // preserve the original business error as cause
          const lockError = new ReleaseError(
            TRANSACTION_INCOMPLETE,
            'business error and lock ownership lost during capture',
            { businessErrorCode: typeof fnErr?.code === 'string' ? fnErr.code : null },
          );
          lockError.cause = fnErr;
          throw lockError;
        }
        // Owner still held — re-throw the original business error
        throw fnErr;
      }
      // fn succeeded — post-owner check
      await assertOwnerOnDisk(owner, root);
      return fnResult;
    },

    /**
     * Assert that the current process still owns the lock.
     *
     * @returns {Promise<void>}
     * @throws {ReleaseError} TRANSACTION_INCOMPLETE if ownership lost.
     */
    async assertOwner() {
      return assertOwnerOnDisk(owner, root);
    },

    /**
     * Release the lock. Only succeeds if the persisted owner matches exactly.
     * After removal, fsyncs the parent .release-skill directory for durability.
     *
     * @returns {Promise<void>}
     * @throws {ReleaseError} TRANSACTION_INCOMPLETE if owner mismatch.
     */
    async release() {
      return removeLockIfExactOwner(owner, root, durabilityObserver);
    },
  });
}

/**
 * Break a project lock by force.
 *
 * Requires the exact owner record to match what is persisted on disk.
 * Writes an audit record to `.release-skill/lock-audit/` before removing
 * the lock directory.
 *
 * @param {object} options
 * @param {string} options.root - Repository root (absolute).
 * @param {object} options.expectedOwner - The exact owner record to match.
 * @param {string} options.reason - Human-readable reason for breaking the lock.
 * @param {() => string} [options.clock] - Clock function for timestamps.
 * @param {(event: object) => Promise<void>} [options.durabilityObserver] - Observe completed durability operations; cannot replace fsync.
 * @returns {Promise<AuditRecord>}
 * @throws {ReleaseError} if owner does not match or lock does not exist.
 */
export async function breakProjectLock({ root, expectedOwner, reason, clock, durabilityObserver } = {}) {
  if (!root || typeof root !== 'string') {
    throw new ReleaseError(PATH_UNSAFE, 'root must be a non-empty string', { root });
  }

  // Strict owner validation before any filesystem operations
  validateOwnerObject(expectedOwner);

  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ReleaseError(PATH_UNSAFE, 'reason must be a non-empty string (trimmed)', {});
  }
  if (/[\x00-\x1f\x7f]/.test(reason)) {
    throw new ReleaseError(PATH_UNSAFE, 'reason contains control characters', {});
  }
  const trimmedReason = sanitizeReason(reason.trim());
  const brokenAt = clock ? clock() : new Date().toISOString();
  assertIsoTimestamp(brokenAt, 'clock result');

  // Symlink/non-directory fail-closed check before reading owner
  await assertLockPathsNotSymlinks(root);

  // Read persisted owner
  let raw;
  try {
    raw = await readFile(ownerPath(root), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        'no project lock to break — lock directory does not exist',
        { root },
      );
    }
    throw err;
  }

  let actualOwner;
  try {
    actualOwner = JSON.parse(raw);
  } catch {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'project lock owner file is corrupt — cannot break safely',
      { root },
    );
  }

  // Exact owner match: all six fields must match
  for (const field of OWNER_FIELDS) {
    if (actualOwner[field] !== expectedOwner[field]) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `break-lock rejected: expectedOwner does not match persisted owner (field: ${field})`,
        { root, field },
      );
    }
  }

  // Check audit path is not a symlink before writing
  await assertAuditPathNotSymlink(root);

  // Build audit record — sanitize: no absolute paths in the JSON
  const safeOriginalOwner = Object.freeze({
    pid: actualOwner.pid,
    host: actualOwner.host,
    bootId: actualOwner.bootId,
    nonce: actualOwner.nonce,
    command: actualOwner.command,
    startedAt: actualOwner.startedAt,
  });

  const auditRecord = Object.freeze({
    brokenAt,
    reason: trimmedReason,
    originalOwner: safeOriginalOwner,
    breakerPid: process.pid,
    breakerHost: hostname(),
  });

  // Write audit evidence before removing lock
  const auditDirectory = auditDir(root);
  await mkdir(auditDirectory, { recursive: true, mode: 0o700 });
  await emitDurability(durabilityObserver, { operation: 'create-dir', path: auditDirectory });

  // Fsync .release-skill after creating audit directory
  await fsyncDirObserved(join(root, '.release-skill'), durabilityObserver);

  const safeTimestamp = auditRecord.brokenAt.replace(/[^A-Za-z0-9_-]/g, '-');
  const auditFileName = `${safeTimestamp}-${actualOwner.nonce}.json`;
  const auditFilePath = join(auditDirectory, auditFileName);
  await writeFile(auditFilePath, JSON.stringify(auditRecord, null, 2), { mode: 0o600, flag: 'wx' });
  await emitDurability(durabilityObserver, { operation: 'write-file', path: auditFilePath });
  await fsyncFileObserved(auditFilePath, durabilityObserver);
  await fsyncDirObserved(auditDirectory, durabilityObserver);

  // Remove the lock directory
  await rm(lockDir(root), { recursive: true, force: true });
  await emitDurability(durabilityObserver, { operation: 'remove-dir', path: lockDir(root) });

  // Fsync parent after lock removal
  await fsyncDirObserved(join(root, '.release-skill'), durabilityObserver);

  return auditRecord;
}

/**
 * @typedef {object} ProjectLock
 * @property {object} owner - The owner record.
 * @property {(fn: () => Promise<T>) => Promise<T>} capture - Run fn under lock ownership assertion.
 * @property {() => Promise<void>} assertOwner - Verify current process owns the lock.
 * @property {() => Promise<void>} release - Release the lock.
 */

/**
 * @typedef {object} AuditRecord
 * @property {string} brokenAt - ISO timestamp of when the lock was broken.
 * @property {string} reason - Human-readable reason.
 * @property {object} originalOwner - The owner that was broken.
 * @property {number} breakerPid - PID of the process that broke the lock.
 * @property {string} breakerHost - Hostname of the breaker.
 */
