/**
 * Transaction coordinator for artifact plan application.
 *
 * Implements the full preflight → PREPARED → APPLYING → COMMITTED flow
 * with durable journaling, per-entry CAS, and crash recovery.
 *
 * ALL filesystem mutations go through the safe-fs backend DirectoryHandle.
 * No Node path-based writes are used for journal, backup, or target files.
 *
 * @module artifacts/transaction
 */

import { randomBytes } from 'node:crypto';
import { relative } from 'node:path';
import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import { canonicalArtifactPath } from './path-key.mjs';
import { acquireProjectLock } from './project-lock.mjs';

import {
  ReleaseError,
  PLAN_STALE,
  TRANSACTION_INCOMPLETE,
  SAFE_WRITE_UNAVAILABLE,
  MISSING_PARAMETERS,
  PATH_UNSAFE,
} from '../core/errors.mjs';

import {
  createTransactionJournal,
  readJournal,
  writeJournalTransition,
  recordAppliedEntry,
  createBackup,
  writeRecoveryRequiredFile,
} from './transaction-journal.mjs';

// ---------------------------------------------------------------------------
// Plan digest computation (raw JSON-parsed form, no bytes decoding)
// ---------------------------------------------------------------------------

/**
 * Compute the canonical plan digest from the raw JSON-parsed plan.
 *
 * Strips the planDigest field, then computes sha256 of canonicalJson.
 * This matches how the test helper `computePlanDigest` works:
 * the digest is computed from the JSON-serialised form of the plan,
 * including Buffer-as-JSON representations of the bytes fields.
 *
 * @param {object} plan — raw JSON-parsed plan (bytes are plain objects).
 * @returns {string} Canonical plan digest (sha256:hex).
 */
function computeCanonicalPlanDigest(plan) {
  const { planDigest: _ignored, ...content } = plan;
  return `sha256:${sha256Hex(canonicalJson(content))}`;
}

// ---------------------------------------------------------------------------
// Bytes decoding
// ---------------------------------------------------------------------------

/**
 * Decode bytes from JSON-serialised Buffer representation to actual Buffer.
 *
 * Handles:
 * - { type: 'Buffer', data: [byte, ...] } — JSON.stringify output
 * - Buffer object passthrough
 *
 * @param {*} raw — raw bytes field.
 * @returns {Buffer} Decoded buffer.
 * @throws {ReleaseError} PATH_UNSAFE if format is invalid.
 */
function decodeBytes(raw) {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (
    raw
    && typeof raw === 'object'
    && raw.type === 'Buffer'
    && Array.isArray(raw.data)
  ) {
    for (let i = 0; i < raw.data.length; i++) {
      if (!Number.isInteger(raw.data[i]) || raw.data[i] < 0 || raw.data[i] > 255) {
        throw new ReleaseError(
          TRANSACTION_INCOMPLETE,
          `bytes[${i}] must be an integer in range 0..255`,
          { index: i },
        );
      }
    }
    return Buffer.from(raw.data);
  }
  throw new ReleaseError(PATH_UNSAFE, 'bytes field has invalid format');
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate a relative artifact path.
 *
 * @param {string} path — relative artifact path.
 * @throws {ReleaseError} PATH_UNSAFE on violations.
 */
function validatePath(path) {
  canonicalArtifactPath(path);
}

/**
 * Run an operation against the parent directory of a canonical artifact
 * path. Child handles are always closed once, in reverse order. The root
 * handle remains owned by the transaction coordinator.
 */
async function withParentHandle(rootHandle, path, operation) {
  const canonical = canonicalArtifactPath(path).path;
  const segments = canonical.split('/');
  const opened = [];
  let current = rootHandle;
  let result;
  let primaryError;

  try {
    for (let i = 0; i < segments.length - 1; i++) {
      current = await current.openDir(segments[i]);
      opened.push(current);
    }
    result = await operation(current, segments[segments.length - 1]);
  } catch (error) {
    primaryError = error;
  }

  const closeFailures = [];
  for (let i = opened.length - 1; i >= 0; i--) {
    try {
      await opened[i].close();
    } catch (error) {
      closeFailures.push(error?.code || error?.message || 'close failed');
    }
  }

  if (primaryError) {
    if (closeFailures.length > 0 && primaryError && typeof primaryError === 'object') {
      primaryError.details = { ...(primaryError.details || {}), closeFailures };
    }
    throw primaryError;
  }
  if (closeFailures.length > 0) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'safe filesystem child handle close failed',
      { closeFailures },
    );
  }
  return result;
}

/**
 * Collect canonical paths, check for duplicates and parent-child overlap.
 *
 * @param {object[]} artifacts — plan artifacts.
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE on violations.
 */
function validatePathUniqueness(artifacts) {
  const paths = [];
  for (const a of artifacts) {
    if (!a.path || typeof a.path !== 'string') {
      throw new ReleaseError(TRANSACTION_INCOMPLETE, `artifact ${a.id} missing path`);
    }
    const { path: canonical, collisionKey } = canonicalArtifactPath(a.path);
    paths.push({ id: a.id, canonical, collisionKey });
  }

  const seen = new Set();
  for (const p of paths) {
    if (seen.has(p.collisionKey)) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `duplicate canonical path: ${p.canonical}`,
        { path: p.canonical },
      );
    }
    seen.add(p.collisionKey);
  }

  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const a = paths[i].canonical;
      const b = paths[j].canonical;
      if (b.startsWith(a + '/') || a.startsWith(b + '/')) {
        throw new ReleaseError(
          TRANSACTION_INCOMPLETE,
          `parent-child path overlap: ${a} and ${b}`,
          { pathA: a, pathB: b },
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry validation and decoding
// ---------------------------------------------------------------------------

/**
 * Validate and decode an entry from the plan.
 *
 * P0-6: Validates entry closed schema, kind, bytes/sha256/size/mode for regular,
 * and Buffer bytes range (0..255 per byte).
 *
 * @param {object} entry — plan entry (may be absent or regular).
 * @param {string} label — 'oldEntry' or 'newEntry'.
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE on violations.
 */
function validateAndDecodeEntry(entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, `${label} must be an object`);
  }

  // P0-6: Validate entry closed schema
  const ENTRY_SCHEMA_FIELDS = new Set(['kind', 'bytes', 'sha256', 'size', 'mode']);
  for (const key of Object.keys(entry)) {
    if (!ENTRY_SCHEMA_FIELDS.has(key)) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `${label} has unknown field: ${key}`,
        { field: key },
      );
    }
  }

  // P0-6: Validate kind
  const VALID_KINDS = new Set(['absent', 'regular']);
  if (!VALID_KINDS.has(entry.kind)) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      `${label} has invalid kind: ${entry.kind}`,
      { kind: entry.kind },
    );
  }

  if (entry.kind === 'absent') {
    if (Object.keys(entry).length !== 1) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `${label} absent entry must contain only kind`,
      );
    }
    return;
  }

  if (entry.kind !== 'regular') return;

  const isNewEntry = label === 'newEntry';

  if (isNewEntry && entry.bytes !== undefined && entry.bytes !== null) {
    entry.bytes = decodeBytes(entry.bytes);

    // P0-6: Validate Buffer bytes range (0..255 per byte)
    for (let i = 0; i < entry.bytes.length; i++) {
      if (entry.bytes[i] < 0 || entry.bytes[i] > 255) {
        throw new ReleaseError(
          TRANSACTION_INCOMPLETE,
          `${label} bytes[${i}] is out of range 0..255: ${entry.bytes[i]}`,
          { index: i, value: entry.bytes[i] },
        );
      }
    }

    if (typeof entry.sha256 === 'string' && /^(?:sha256:)?[0-9a-f]{64}$/.test(entry.sha256)) {
      const expected = entry.sha256.replace(/^sha256:/, '');
      const actual = sha256Hex(entry.bytes);
      if (actual !== expected) {
        throw new ReleaseError(
          TRANSACTION_INCOMPLETE,
          `${label} sha256 mismatch: expected ${expected}, got ${actual}`,
        );
      }
    } else {
      // P0-6: regular entry with bytes MUST have valid sha256
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `${label} regular entry with bytes must have sha256 in sha256:hex format`,
      );
    }

    if (entry.size !== undefined && entry.size !== null) {
      if (Number(entry.size) !== entry.bytes.length) {
        throw new ReleaseError(
          TRANSACTION_INCOMPLETE,
          `${label} size mismatch: expected ${entry.size}, got ${entry.bytes.length}`,
        );
      }
    } else {
      // P0-6: regular entry with bytes MUST have size
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `${label} regular entry with bytes must have size`,
      );
    }
  } else if (isNewEntry) {
    // New regular entries carry the exact bytes to materialise.
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      `${label} regular entry must have bytes`,
    );
  } else if (entry.bytes !== undefined) {
    // Old bytes are deliberately not trusted from the plan. They are read
    // from the identity-bound live entry after the per-entry CAS and then
    // persisted in the transaction backup.
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      `${label} regular entry must not contain bytes`,
    );
  }

  if (typeof entry.sha256 !== 'string' || !/^(?:sha256:)?[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      `${label} regular entry must have a valid sha256`,
    );
  }

  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      `${label} regular entry must have a non-negative integer size`,
    );
  }

  if (entry.mode !== undefined && entry.mode !== null) {
    const modeStr = String(entry.mode);
    // P0-6: Validate mode format (last 3 digits are octal)
    const last3 = modeStr.slice(-3);
    if (!/^[0-7]{3}$/.test(last3)) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `${label} has invalid mode: ${entry.mode}`,
      );
    }
  } else {
    // P0-6: regular entry MUST have mode
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      `${label} regular entry must have mode`,
    );
  }
}

// ---------------------------------------------------------------------------
// CAS validation (full)
// ---------------------------------------------------------------------------

/**
 * Validate an old entry against the current filesystem state using the
 * safe-fs backend.
 *
 * @param {object} handle — root DirectoryHandle.
 * @param {object} oldEntry — plan oldEntry.
 * @param {string} canonicalPath — normalised artifact path.
 * @throws {ReleaseError} PLAN_STALE on any mismatch.
 */
async function assertFullCas(handle, oldEntry, canonicalPath) {
  if (!oldEntry || typeof oldEntry !== 'object') return;

  const current = await readCurrentEntry(handle, canonicalPath);

  if (oldEntry.kind === 'absent') {
    if (current.kind !== 'absent') {
      throw new ReleaseError(
        PLAN_STALE,
        `CAS mismatch: ${canonicalPath} expected absent, got ${current.kind}`,
        { path: canonicalPath, expected: 'absent', actual: current.kind },
      );
    }
    return current;
  }

  if (oldEntry.kind === 'regular') {
    if (current.kind !== 'regular') {
      throw new ReleaseError(
        PLAN_STALE,
        `CAS mismatch: ${canonicalPath} expected regular, got ${current.kind}`,
        { path: canonicalPath, expected: 'regular', actual: current.kind },
      );
    }

    if (typeof oldEntry.sha256 === 'string') {
      const expected = oldEntry.sha256.startsWith('sha256:')
        ? oldEntry.sha256
        : `sha256:${oldEntry.sha256}`;
      if (current.sha256 !== expected) {
        throw new ReleaseError(
          PLAN_STALE,
          `CAS mismatch: ${canonicalPath} sha256 changed`,
          { path: canonicalPath, expected, actual: current.sha256 },
        );
      }
    }

    if (oldEntry.size !== undefined && oldEntry.size !== null) {
      if (Number(oldEntry.size) !== current.size) {
        throw new ReleaseError(
          PLAN_STALE,
          `CAS mismatch: ${canonicalPath} size changed`,
          { path: canonicalPath, expected: Number(oldEntry.size), actual: current.size },
        );
      }
    }

    if (oldEntry.mode !== undefined && oldEntry.mode !== null) {
      const modeStr = String(oldEntry.mode);
      const last3 = modeStr.slice(-3);
      if (/^[0-7]{3}$/.test(last3)) {
        const expectedMode = parseInt(last3, 8);
        const maskedExpected = expectedMode & 0o111 ? expectedMode : expectedMode & ~0o111;
        const maskedActual = current.mode & 0o111 ? current.mode : current.mode & ~0o111;
        if (maskedExpected !== maskedActual) {
          throw new ReleaseError(
            PLAN_STALE,
            `CAS mismatch: ${canonicalPath} mode changed`,
            {
              path: canonicalPath,
              expected: `0o${maskedExpected.toString(8)}`,
              actual: `0o${maskedActual.toString(8)}`,
            },
          );
        }
      }
    }
    return current;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Read current entry from safe-fs backend
// ---------------------------------------------------------------------------

/**
 * Read the current filesystem state of an artifact via the safe-fs backend.
 *
 * Maps real addon readEntry format { type, size, mode } to internal { kind, ... }.
 * For regular files, reads bytes via readFile to compute sha256.
 *
 * @param {object} handle — root DirectoryHandle.
 * @param {string} path — normalised relative path.
 * @returns {Promise<object>} Entry with kind, sha256, size, mode.
 */
async function readCurrentEntry(handle, path) {
  return withParentHandle(handle, path, async (current, leaf) => {
    const entry = await current.readEntry(leaf);

    if (!entry || entry.kind === 'absent') {
      return { kind: 'absent' };
    }

  // Map both the production addon shape ({type:'file'|'directory'}) and
  // artifact-style recording backends ({kind:'regular'|'tree',type:'blob'}).
    if (entry.type === 'directory' || entry.kind === 'tree') {
      return { kind: 'tree', entries: [] };
    }

    const isRegular = entry.type === 'file'
      || entry.type === 'blob'
      || entry.kind === 'regular';
    if (!isRegular) {
      throw new ReleaseError(
        PATH_UNSAFE,
        `artifact path is not a regular file: ${entry.type}`,
        { path, type: entry.type },
      );
    }

  // For regular files, read bytes via readFile to compute sha256
    const fileData = await current.readFile(leaf);
    if (!fileData) return { kind: 'absent' };
    if (Number(fileData.nlink) !== 1) {
      throw new ReleaseError(
        PATH_UNSAFE,
        `artifact path has unexpected hard link count: ${path}`,
        { path, nlink: Number(fileData.nlink) },
      );
    }

    return {
      kind: 'regular',
      bytes: fileData.bytes,
      sha256: `sha256:${sha256Hex(fileData.bytes)}`,
      size: fileData.size,
      mode: fileData.mode,
      identityToken: fileData,
    };
  });
}

// ---------------------------------------------------------------------------
// Preflight and CAS (zero side effects)
// ---------------------------------------------------------------------------

/**
 * Full preflight validation with zero filesystem side effects.
 *
 * P0-6: Validates apiVersion/bindings, plan schema, safeToWrite, artifact
 * schema, path safety, path uniqueness, entry schema/decoding, Buffer
 * bytes range (0..255), unknown fields/kinds, and full CAS for all old entries.
 *
 * @param {object} handle — root DirectoryHandle.
 * @param {object} plan — decoded plan (bytes decoded in-place).
 * @param {string} planPath — for error context.
 * @throws {ReleaseError} On any validation failure.
 */
async function performPreflightAndCas(handle, plan, planPath) {
  if (!plan || typeof plan !== 'object') {
    throw new ReleaseError(PLAN_STALE, 'plan is not a valid object', { path: planPath });
  }

  if (plan.apiVersion !== 'release-skill.dev/artifact-plan/v1') {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'plan apiVersion is missing or unsupported',
      { apiVersion: plan.apiVersion },
    );
  }

  if (typeof plan.bindings !== 'object' || plan.bindings === null || Array.isArray(plan.bindings)) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'plan bindings must be an object',
    );
  }
  const bindingFields = [
    'repositoryIdentity', 'policyDigest', 'baseManifestDigest',
    'currentManifestDigest', 'producerClosureDigest',
  ];
  if (Object.keys(plan.bindings).length !== bindingFields.length) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'plan bindings must use the closed v1 schema');
  }
  for (const field of bindingFields) {
    if (typeof plan.bindings[field] !== 'string'
        || !/^sha256:[0-9a-f]{64}$/.test(plan.bindings[field])) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `plan binding ${field} must be a sha256 digest`,
      );
    }
  }

  if (!plan.safeToWrite) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'plan is not safe to write',
      { safeToWrite: plan.safeToWrite },
    );
  }
  if (!['inspect', 'status', 'apply'].includes(plan.operation)) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      `plan operation is not applyable: ${plan.operation}`,
    );
  }
  if (plan.targetUnchanged !== true) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'plan targetUnchanged must be true');
  }
  if (!plan.nextAction || typeof plan.nextAction !== 'object'
      || Array.isArray(plan.nextAction)
      || Object.keys(plan.nextAction).length !== 1
      || typeof plan.nextAction.command !== 'string'
      || !/\bartifacts apply\b/.test(plan.nextAction.command)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'plan nextAction must be the apply command');
  }
  if (!Array.isArray(plan.artifacts)) {
    throw new ReleaseError(PLAN_STALE, 'plan missing artifacts array', { path: planPath });
  }

  // P0-6: Validate no unknown plan fields (closed schema)
  const PLAN_SCHEMA_FIELDS = new Set([
    'apiVersion', 'operation', 'bindings', 'safeToWrite', 'targetUnchanged',
    'nextAction', 'artifacts', 'planDigest',
  ]);
  for (const key of Object.keys(plan)) {
    if (!PLAN_SCHEMA_FIELDS.has(key)) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `plan has unknown field: ${key}`,
        { field: key },
      );
    }
  }

  // Validate and decode all entries (in-place bytes modification)
  for (const artifact of plan.artifacts) {
    if (!artifact.id || typeof artifact.id !== 'string') {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        'artifact missing id or id is not a string',
        { artifact },
      );
    }

    // P0-6: Validate artifact closed schema
    const ARTIFACT_SCHEMA_FIELDS = new Set([
      'id', 'path', 'oldEntry', 'newEntry', 'status', 'safeToWrite',
    ]);
    for (const key of Object.keys(artifact)) {
      if (!ARTIFACT_SCHEMA_FIELDS.has(key)) {
        throw new ReleaseError(
          TRANSACTION_INCOMPLETE,
          `artifact has unknown field: ${key}`,
          { artifactId: artifact.id, field: key },
        );
      }
    }

    const VALID_ARTIFACT_STATUSES = new Set([
      'READY', 'CLEAN', 'NEW', 'HUMAN_CHANGED',
      'GENERATOR_CHANGED', 'MERGEABLE', 'RESOLVED',
    ]);
    if (!VALID_ARTIFACT_STATUSES.has(artifact.status)) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `artifact has invalid or blocking status: ${artifact.status}`,
        { artifactId: artifact.id, status: artifact.status },
      );
    }
    if (artifact.safeToWrite !== true) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `artifact is not explicitly safe to write: ${artifact.id}`,
        { artifactId: artifact.id, safeToWrite: artifact.safeToWrite },
      );
    }

    validateAndDecodeEntry(artifact.newEntry, 'newEntry');
    validateAndDecodeEntry(artifact.oldEntry, 'oldEntry');
  }

  // Path validation
  for (const artifact of plan.artifacts) {
    validatePath(artifact.path);
  }
  validatePathUniqueness(plan.artifacts);

  // Full CAS for all old entries (zero side effects)
  for (const artifact of plan.artifacts) {
    const canonicalPath = artifact.path.endsWith('/')
      ? artifact.path.slice(0, -1)
      : artifact.path;
    await assertFullCas(handle, artifact.oldEntry, canonicalPath);
  }
}

// ---------------------------------------------------------------------------
// Manifest building
// ---------------------------------------------------------------------------

/**
 * Build old manifest with backup data (bytes for regular files).
 *
 * @param {object} handle — root DirectoryHandle.
 * @param {object[]} artifacts — plan artifacts.
 * @returns {Promise<object[]>} Old manifest entries.
 */
async function buildOldManifest(handle, artifacts) {
  const manifest = [];
  for (const artifact of artifacts) {
    const canonicalPath = artifact.path.endsWith('/')
      ? artifact.path.slice(0, -1)
      : artifact.path;
    const current = await assertFullCas(handle, artifact.oldEntry, canonicalPath);
    if (artifact.oldEntry && artifact.oldEntry.kind === 'regular') {
      manifest.push({
        path: canonicalPath,
        kind: 'regular',
        sha256: current.sha256,
        size: current.size,
        mode: current.mode,
        bytes: current.bytes,
      });
    } else {
      manifest.push({
        path: canonicalPath,
        kind: 'absent',
        absent: true,
      });
    }
  }
  return manifest;
}

/**
 * Build new manifest from plan newEntry.
 *
 * @param {object[]} artifacts — plan artifacts (bytes already decoded).
 * @returns {object[]} New manifest entries.
 */
function buildNewManifest(artifacts) {
  return artifacts.map((a) => {
    const canonicalPath = a.path.endsWith('/') ? a.path.slice(0, -1) : a.path;
    if (a.newEntry && a.newEntry.kind === 'regular') {
      return {
        path: canonicalPath,
        kind: 'regular',
        sha256: a.newEntry.sha256.startsWith('sha256:')
          ? a.newEntry.sha256
          : `sha256:${a.newEntry.sha256}`,
        size: a.newEntry.size,
        mode: a.newEntry.mode,
      };
    }
    return { path: canonicalPath, kind: 'absent' };
  });
}

// ---------------------------------------------------------------------------
// Apply single artifact through handle
// ---------------------------------------------------------------------------

/**
 * Apply a single artifact mutation through the safe-fs handle.
 *
 * @param {object} handle — root DirectoryHandle.
 * @param {object} artifact — plan artifact (bytes decoded).
 * @returns {Promise<void>}
 */
async function applySingleArtifact(handle, artifact, expectedIdentity = null) {
  const canonicalPath = artifact.path.endsWith('/')
    ? artifact.path.slice(0, -1)
    : artifact.path;
  return withParentHandle(handle, canonicalPath, async (parent, leaf) => {
    if (artifact.newEntry && artifact.newEntry.kind === 'absent') {
      await parent.unlink(leaf);
      await parent.fsync();
      return;
    }

    if (artifact.newEntry && artifact.newEntry.kind === 'regular') {
      const bytes = Buffer.from(artifact.newEntry.bytes);
      const mode = parseMode(artifact.newEntry.mode);
      const token = await parent.createTemp(leaf, mode, bytes);
      try {
        await parent.rename(token, leaf, expectedIdentity);
      } catch (renameError) {
        try {
          const abortResult = await parent.abortTemp(token);
          if (!abortResult?.removed) {
            renameError.details = {
              ...(renameError.details || {}),
              abortResult,
            };
          }
        } catch (abortError) {
          renameError.details = {
            ...(renameError.details || {}),
            abortError: abortError?.code || abortError?.message || 'abort failed',
          };
        }
        throw renameError;
      }
      await parent.fsync();
    }
  });
}

/**
 * Parse mode from plan entry (string '100644' → number 0o644).
 *
 * @param {*} mode — mode value from plan.
 * @returns {number} Permission bits as number.
 */
function parseMode(mode) {
  if (mode === undefined || mode === null) return 0o600;
  const modeStr = String(mode);
  const last3 = modeStr.slice(-3);
  if (/^[0-7]{3}$/.test(last3)) {
    return parseInt(last3, 8);
  }
  return 0o600;
}

// ---------------------------------------------------------------------------
// Manifest verification
// ---------------------------------------------------------------------------

/**
 * Verify the final state matches the plan's new entries.
 *
 * @param {object} handle — root DirectoryHandle.
 * @param {object[]} artifacts — plan artifacts.
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE on mismatch.
 */
async function verifyManifest(handle, artifacts) {
  for (const artifact of artifacts) {
    const canonicalPath = artifact.path.endsWith('/')
      ? artifact.path.slice(0, -1)
      : artifact.path;

    if (artifact.newEntry && artifact.newEntry.kind === 'absent') {
      await assertFullCas(handle, { kind: 'absent' }, canonicalPath);
    }

    if (artifact.newEntry && artifact.newEntry.kind === 'regular') {
      const expected = {
        kind: 'regular',
        sha256: artifact.newEntry.sha256,
        size: artifact.newEntry.size,
        mode: artifact.newEntry.mode,
      };
      await assertFullCas(handle, expected, canonicalPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Target unchanged check
// ---------------------------------------------------------------------------

/**
 * Check whether all target files are still unchanged (matching oldEntry).
 *
 * @param {object} handle — root DirectoryHandle.
 * @param {object[]} artifacts — plan artifacts.
 * @returns {Promise<boolean>} true if all targets match oldEntry state.
 */
async function checkTargetUnchanged(handle, artifacts) {
  try {
    for (const artifact of artifacts) {
      const canonicalPath = artifact.path.endsWith('/')
        ? artifact.path.slice(0, -1)
        : artifact.path;
      if (artifact.oldEntry && artifact.oldEntry.kind === 'regular') {
        await assertFullCas(handle, artifact.oldEntry, canonicalPath);
      }
      if (artifact.oldEntry && artifact.oldEntry.kind === 'absent') {
        await assertFullCas(handle, { kind: 'absent' }, canonicalPath);
      }
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Recovery protocol
// ---------------------------------------------------------------------------

/**
 * Attempt to transition journal to RECOVERY_REQUIRED and write marker file.
 *
 * P0-8: PREPARED后普通primitive error转为durable RECOVERY_REQUIRED，
 * 保留原cause code、transactionId、真实targetUnchanged、唯一recover命令。
 * journal建立前失败不得谎称recovery。
 *
 * @param {object} options
 * @param {object} options.backend — safe-fs backend.
 * @param {string} options.root — repository root.
 * @param {string} options.transactionId — transaction ID.
 * @param {Error} options.originalError — the error that triggered recovery.
 * @param {object[]} options.artifacts — plan artifacts.
 * @param {boolean} options.journalCreated — whether journal exists.
 * @returns {Promise<{ recoveryError: Error|null, targetUnchanged: boolean }>}
 */
async function tryRecoveryProtocol({
  rootHandle,
  txnHandle,
  transactionId,
  originalError,
  artifacts,
  journalCreated,
}) {
  // P0-8: Journal建立前失败不得谎称recovery
  if (!journalCreated) {
    return { recoveryError: null, targetUnchanged: false };
  }

  // P0-8: Real target unchanged check
  let targetUnchanged = false;
  try {
    targetUnchanged = await checkTargetUnchanged(rootHandle, artifacts);
  } catch {
    targetUnchanged = false;
  }

  let journalState = 'unknown';
  try {
    const journal = await readJournal(txnHandle, transactionId);
    journalState = journal.state;
  } catch {
    journalState = 'unreadable';
  }

  // P0-8: Unique recover command
  const recover = `release-skill artifacts recover --transaction ${transactionId}`;

  let recoveryStatePersisted = journalState === 'RECOVERY_REQUIRED';
  let transitionErrorCode = null;
  if (['PREPARED', 'APPLYING', 'APPLIED', 'VERIFYING'].includes(journalState)) {
    try {
      await writeJournalTransition({
        txnHandle,
        transactionId,
        from: journalState,
        to: 'RECOVERY_REQUIRED',
      });
      recoveryStatePersisted = true;
    } catch (error) {
      transitionErrorCode = error?.code || 'UNKNOWN';
    }
  }

  let recoveryMarkerPersisted = false;
  let markerErrorCode = null;
  try {
    await writeRecoveryRequiredFile({
      txnHandle,
      transactionId,
      targetUnchanged,
      recover,
    });
    recoveryMarkerPersisted = true;
  } catch (error) {
    markerErrorCode = error?.code || 'UNKNOWN';
  }

  // Never claim a durable RECOVERY_REQUIRED state when the journal transition
  // itself could not be persisted. The marker is supplementary evidence, not
  // a substitute for the authoritative state machine.
  const recoveryError = new ReleaseError(
    TRANSACTION_INCOMPLETE,
    recoveryStatePersisted
      ? `${originalError.message}. ${recover}`
      : `transaction failed and RECOVERY_REQUIRED could not be persisted. ${recover}`,
    {
      transactionId,
      targetUnchanged,
      recover,
      cause: originalError.code || null,
      causeMessage: originalError.message || null,
      recoveryDurable: recoveryStatePersisted,
      recoveryMarkerPersisted,
      journalState,
      transitionErrorCode,
      markerErrorCode,
    },
  );
  recoveryError.transactionId = transactionId;

  return { recoveryError, targetUnchanged };
}

// ---------------------------------------------------------------------------
// Transaction ID generation
// ---------------------------------------------------------------------------

function generateTransactionId(clock) {
  const timeSeed = clock ? clock() : Date.now();
  const timeDigest = sha256Hex(String(timeSeed)).slice(0, 12);
  return `txn-${timeDigest}-${randomBytes(8).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply an artifact plan with durable transaction journaling.
 *
 * All filesystem mutations use the safe-fs backend. No Node path writes.
 *
 * @param {object} options
 * @param {string} options.root — Repository root (absolute).
 * @param {string} options.planPath — Path to the artifact plan file.
 * @param {string} options.planDigest — Expected plan digest.
 * @param {object} [options.safeFs] — Safe filesystem backend.
 * @param {Function} [options.faultInjector] — Fault injection for testing.
 * @param {Function} [options.clock] — Clock function for timestamps.
 * @returns {Promise<TransactionResult>}
 * @throws {ReleaseError} On validation failure or CAS mismatch.
 */
async function applyArtifactPlanUnderLock({
  root,
  planPath,
  planDigest,
  safeFs,
  faultInjector,
  clock,
  assertLockOwner = async () => {},
} = {}) {
  // === PHASE 0: validate inputs and safe-fs availability ===

  if (!root || typeof root !== 'string') {
    throw new ReleaseError(PATH_UNSAFE, 'root must be a non-empty string');
  }
  if (!planPath || typeof planPath !== 'string') {
    throw new ReleaseError(MISSING_PARAMETERS, 'planPath is required');
  }
  if (!planDigest || typeof planDigest !== 'string') {
    throw new ReleaseError(MISSING_PARAMETERS, 'planDigest is required');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(planDigest)) {
    throw new ReleaseError(PLAN_STALE, 'planDigest must be a sha256 digest');
  }
  if (!safeFs) {
    throw new ReleaseError(
      SAFE_WRITE_UNAVAILABLE,
      'safe filesystem backend is required',
    );
  }

  // === PHASE 1: validate plan file through safe-fs ===

  const handle = await safeFs.openRoot(root);
  let txnResult;
  const assertLockAuthority = async () => {
    try {
      await assertLockOwner();
    } catch (error) {
      if (error && typeof error === 'object') error.lockOwnershipLost = true;
      throw error;
    }
  };
  try {

  // Convert the absolute plan path to a canonical root-relative path before
  // any fd-relative access. This rejects root itself and all escape spellings.
  const relPlanPath = canonicalArtifactPath(relative(root, planPath)).path;
  const planFileData = await withParentHandle(handle, relPlanPath, async (parent, leaf) => {
    const planEntry = await parent.readEntry(leaf);
    if (!planEntry || planEntry.kind === 'absent') {
      throw new ReleaseError(PLAN_STALE, 'plan file does not exist', { path: planPath });
    }
    const planIsRegular = planEntry.kind === 'regular'
      || planEntry.type === 'file'
      || planEntry.type === 'blob';
    if (!planIsRegular) {
      throw new ReleaseError(PATH_UNSAFE, 'plan path is not a regular file', { path: planPath });
    }
    if (typeof planEntry.nlink === 'number' && planEntry.nlink !== 1) {
      throw new ReleaseError(PATH_UNSAFE, 'plan file has unexpected hard link count');
    }
    const data = await parent.readFile(leaf);
    if (!data) {
      throw new ReleaseError(PLAN_STALE, 'plan file is unreadable', { path: planPath });
    }
    if (Number(data.nlink) !== 1) {
      throw new ReleaseError(PATH_UNSAFE, 'plan file has unexpected hard link count');
    }
    return data;
  });

  let plan;
  try {
    plan = JSON.parse(planFileData.bytes.toString('utf8'));
  } catch (err) {
    throw new ReleaseError(
      PLAN_STALE,
      'plan file is not valid JSON',
      { path: planPath, error: err.message },
    );
  }

  // === PHASE 2: recompute canonical plan digest ===

  const recomputedDigest = computeCanonicalPlanDigest(plan);
  if (plan.planDigest !== planDigest || recomputedDigest !== planDigest) {
    throw new ReleaseError(
      PLAN_STALE,
      'plan digest does not match expected',
      { expected: planDigest, embedded: plan.planDigest, actual: recomputedDigest },
    );
  }

  // === PHASE 3: full preflight + CAS (zero side effects) ===

  await performPreflightAndCas(handle, plan, planPath);

  if (faultInjector) {
    await faultInjector('preflight-complete');
  }

  // === PHASE 4: probe safe-fs backend ===

  const probeResult = await safeFs.probe(root);
  if (!probeResult.supported) {
    throw new ReleaseError(
      SAFE_WRITE_UNAVAILABLE,
      'safe write primitives are not functional on this platform',
      { platform: process.platform },
    );
  }
  if (faultInjector) await faultInjector('after-probe');
  await assertLockAuthority();

  // === PHASE 5: create transaction and journal ===

  const transactionId = generateTransactionId(clock);
  let journalCreated = false;

  const oldManifest = await buildOldManifest(handle, plan.artifacts);
  const newManifest = buildNewManifest(plan.artifacts);

  try {
    await assertLockAuthority();
    txnResult = await createTransactionJournal({
      rootHandle: handle,
      transactionId,
      planDigest,
      canonicalPlan: plan,
      oldManifest,
      newManifest,
    });
    journalCreated = true;
  } catch (journalErr) {
    // Journal creation failed — no side effects, clean failure
    throw journalErr;
  }

  const { txnHandle } = txnResult;

  try {
    if (faultInjector) await faultInjector('after-prepared');
    // === PHASE 5a: transition to APPLYING ===

    await assertLockAuthority();
    await writeJournalTransition({
      txnHandle,
      transactionId,
      from: 'PREPARED',
      to: 'APPLYING',
    });
    if (faultInjector) await faultInjector('after-applying-transition');

    // === PHASE 6: apply each artifact with write-ahead journaling ===

    const results = [];
    for (let i = 0; i < plan.artifacts.length; i++) {
      const artifact = plan.artifacts[i];

      // Write-ahead: record entry index BEFORE mutation
      await assertLockAuthority();
      await recordAppliedEntry({
        txnHandle,
        transactionId,
        entryIndex: i,
        entry: { id: artifact.id, path: artifact.path, status: 'pending' },
      });
      if (faultInjector) await faultInjector(`after-entry-pending:${i}`);

      // P0-4: Re-exact CAS before each target mutation
      const canonicalPath = artifact.path.endsWith('/')
        ? artifact.path.slice(0, -1)
        : artifact.path;
      const current = await assertFullCas(handle, artifact.oldEntry, canonicalPath);

      // P0-4: Create backup from the SAME stable read as CAS verification
      // backup bytes must come from this CAS read, not a separate one
      if (artifact.oldEntry && artifact.oldEntry.kind === 'regular') {
        // The exact bytes and unforgeable identity token come from the same
        // stable read used for this per-entry CAS.
        const expectedOldSha = artifact.oldEntry.sha256.startsWith('sha256:')
          ? artifact.oldEntry.sha256
          : `sha256:${artifact.oldEntry.sha256}`;
        if (current.sha256 !== expectedOldSha) {
          throw new ReleaseError(
            PLAN_STALE,
            `CAS mismatch during backup read: ${canonicalPath} sha256 changed`,
            { path: canonicalPath },
          );
        }
        await assertLockAuthority();
        await createBackup({
          txnHandle,
          transactionId,
          entryIndex: i,
          oldEntry: { ...artifact.oldEntry, bytes: current.bytes },
        });
      } else {
        await assertLockAuthority();
        await createBackup({
          txnHandle,
          transactionId,
          entryIndex: i,
          oldEntry: { kind: 'absent' },
        });
      }
      if (faultInjector) await faultInjector(`after-entry-backup:${i}`);

      // Apply artifact mutation through safe-fs handle
      if (faultInjector) await faultInjector(`before-entry-mutation:${i}`);
      await assertLockAuthority();
      await applySingleArtifact(
        handle,
        artifact,
        current?.kind === 'regular' ? current.identityToken : null,
      );
      if (faultInjector) await faultInjector(`after-entry-mutation:${i}`);

      // Record applied
      await assertLockAuthority();
      await recordAppliedEntry({
        txnHandle,
        transactionId,
        entryIndex: i,
        entry: { id: artifact.id, path: artifact.path, status: 'applied' },
      });
      if (faultInjector) await faultInjector(`after-entry-applied:${i}`);

      results.push({ id: artifact.id, path: artifact.path, applied: true });

    }

    // === PHASE 7: mark APPLIED → VERIFYING → COMMITTED ===

    await assertLockAuthority();
    await writeJournalTransition({
      txnHandle,
      transactionId,
      from: 'APPLYING',
      to: 'APPLIED',
    });
    if (faultInjector) await faultInjector('after-applied-transition');

    await assertLockAuthority();
    await writeJournalTransition({
      txnHandle,
      transactionId,
      from: 'APPLIED',
      to: 'VERIFYING',
    });
    if (faultInjector) await faultInjector('after-verifying-transition');

    await verifyManifest(handle, plan.artifacts);
    if (faultInjector) await faultInjector('after-verify');

    await assertLockAuthority();
    await writeJournalTransition({
      txnHandle,
      transactionId,
      from: 'VERIFYING',
      to: 'COMMITTED',
    });
    if (faultInjector) await faultInjector('after-committed');

    const finalJournal = await readJournal(txnHandle, transactionId);

    return Object.freeze({
      transactionId,
      state: 'COMMITTED',
      results: Object.freeze(results),
      journal: finalJournal,
    });
  } catch (applyErr) {
    // === RECOVERY PROTOCOL ===

    // A fault hook marked as a hard crash models abrupt process death: the
    // latest durable journal state must remain untouched for the next process.
    if (applyErr?.code === 'INJECTED_CRASH' || applyErr?.name === 'InjectedCrash') {
      throw applyErr;
    }
    if (applyErr?.lockOwnershipLost === true) {
      throw applyErr;
    }

    const { recoveryError } = await tryRecoveryProtocol({
      rootHandle: handle,
      txnHandle,
      transactionId,
      originalError: applyErr instanceof ReleaseError ? applyErr : new ReleaseError(
        typeof applyErr?.code === 'string' ? applyErr.code : TRANSACTION_INCOMPLETE,
        applyErr?.message || 'safe filesystem operation failed',
      ),
      artifacts: plan.artifacts,
      journalCreated,
    });

    if (recoveryError) {
      throw recoveryError;
    }

    throw applyErr;
  }
  } finally {
    let closeError;
    if (txnResult?.close) {
      try {
        await txnResult.close();
      } catch (error) {
        closeError = error;
      }
    }
    try {
      await handle.close();
    } catch (error) {
      closeError ??= error;
    }
    if (closeError) throw closeError;
  }
}

/**
 * Public apply entry. The shared project lock is held from plan read and
 * preflight through COMMITTED or durable RECOVERY_REQUIRED. Direct API users
 * receive the same concurrency boundary as the CLI.
 */
export async function applyArtifactPlan(options = {}) {
  const { root } = options;
  if (!root || typeof root !== 'string') {
    throw new ReleaseError(PATH_UNSAFE, 'root must be a non-empty string');
  }

  const lock = await acquireProjectLock({
    root,
    command: 'artifacts apply',
    mode: 'exclusive',
  });
  let result;
  let primaryError;
  try {
    result = await lock.capture(() => applyArtifactPlanUnderLock({
      ...options,
      assertLockOwner: () => lock.assertOwner(),
    }));
  } catch (error) {
    primaryError = error;
  }

  try {
    await lock.release();
  } catch (releaseError) {
    if (primaryError) {
      const combined = new ReleaseError(
        TRANSACTION_INCOMPLETE,
        'artifact apply failed and project lock release also failed',
        {
          businessErrorCode: primaryError?.code || null,
          releaseErrorCode: releaseError?.code || null,
        },
      );
      combined.cause = primaryError;
      combined.releaseCause = releaseError;
      throw combined;
    }
    throw releaseError;
  }

  if (primaryError) throw primaryError;
  return result;
}

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TransactionResult
 * @property {string} transactionId
 * @property {string} state — 'COMMITTED'
 * @property {Array<object>} results — per-artifact results
 * @property {object} journal — final journal state
 */
