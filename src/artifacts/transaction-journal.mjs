/**
 * Transaction journal for durable apply operations.
 *
 * Manages write-ahead logging, state transitions, and crash recovery
 * for artifact plan applications. ALL filesystem writes go through the
 * safe-fs backend DirectoryHandle — no Node path-based writes.
 *
 * @module artifacts/transaction-journal
 */

import { ReleaseError, INVALID_STATE_TRANSITION, TRANSACTION_INCOMPLETE, PATH_UNSAFE } from '../core/errors.mjs';
import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import { canonicalArtifactPath } from './path-key.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VALID_STATES = Object.freeze(new Set([
  'PREPARED',
  'APPLYING',
  'APPLIED',
  'VERIFYING',
  'COMMITTED',
  'RECOVERY_REQUIRED',
  'ROLLING_BACK',
  'ROLLED_BACK',
  'RECOVERY_CONFLICT',
]));

export const VALID_TRANSITIONS = Object.freeze({
  PREPARED: ['APPLYING', 'RECOVERY_REQUIRED'],
  APPLYING: ['APPLIED', 'RECOVERY_REQUIRED'],
  APPLIED: ['VERIFYING', 'RECOVERY_REQUIRED'],
  VERIFYING: ['COMMITTED', 'RECOVERY_REQUIRED'],
  COMMITTED: [],
  RECOVERY_REQUIRED: ['ROLLING_BACK', 'APPLYING'],
  ROLLING_BACK: ['ROLLED_BACK', 'RECOVERY_CONFLICT'],
  ROLLED_BACK: [],
  RECOVERY_CONFLICT: [],
});

const JOURNAL_SCHEMA_FIELDS = new Set([
  'transactionId',
  'planDigest',
  'canonicalPlan',
  'oldManifest',
  'newManifest',
  'state',
  'transitions',
  'entries',
  'createdAt',
  'updatedAt',
]);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const PLAN_SCHEMA_FIELDS = new Set([
  'apiVersion', 'operation', 'bindings', 'safeToWrite', 'targetUnchanged',
  'nextAction', 'artifacts', 'planDigest',
]);
const ARTIFACT_SCHEMA_FIELDS = new Set([
  'id', 'path', 'oldEntry', 'newEntry', 'status', 'safeToWrite',
]);

function failSchema(message, details) {
  throw new ReleaseError(TRANSACTION_INCOMPLETE, message, details);
}

function assertClosedObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    failSchema(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) failSchema(`${label} has unknown field: ${key}`);
  }
}

function normaliseMode(mode, label) {
  if (Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o777) return mode;
  const text = String(mode);
  const suffix = text.slice(-3);
  if (!/^[0-7]{3}$/.test(suffix)) failSchema(`${label} has invalid mode`);
  return Number.parseInt(suffix, 8);
}

function normaliseDigest(value, label) {
  if (typeof value !== 'string' || !/^(?:sha256:)?[0-9a-f]{64}$/.test(value)) {
    failSchema(`${label} has invalid sha256`);
  }
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function decodeJournalBytes(raw, label) {
  if (Buffer.isBuffer(raw)) return Buffer.from(raw);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || raw.type !== 'Buffer' || !Array.isArray(raw.data)
      || Object.keys(raw).some((key) => !['type', 'data'].includes(key))) {
    failSchema(`${label} has invalid bytes encoding`);
  }
  for (let i = 0; i < raw.data.length; i++) {
    if (!Number.isInteger(raw.data[i]) || raw.data[i] < 0 || raw.data[i] > 255) {
      failSchema(`${label}.bytes[${i}] must be an integer in range 0..255`);
    }
  }
  return Buffer.from(raw.data);
}

function validateManifestItem(item, role, index) {
  const label = `${role}Manifest[${index}]`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    failSchema(`${label} must be an object`);
  }
  const canonical = canonicalArtifactPath(item.path);
  if (canonical.path !== item.path) failSchema(`${label} path is not canonical`);

  if (item.kind === 'absent') {
    const allowed = role === 'old'
      ? new Set(['path', 'kind', 'absent'])
      : new Set(['path', 'kind']);
    assertClosedObject(item, allowed, label);
    if (role === 'old' && item.absent !== true) {
      failSchema(`${label} must carry an absence tombstone`);
    }
    return Object.freeze({ path: canonical.path, kind: 'absent' });
  }

  if (item.kind !== 'regular') failSchema(`${label} has invalid kind`);
  const allowed = role === 'old'
    ? new Set(['path', 'kind', 'sha256', 'size', 'mode', 'bytes'])
    : new Set(['path', 'kind', 'sha256', 'size', 'mode']);
  assertClosedObject(item, allowed, label);
  for (const required of allowed) {
    if (!Object.hasOwn(item, required)) failSchema(`${label} missing required field: ${required}`);
  }
  const digest = normaliseDigest(item.sha256, label);
  if (!Number.isSafeInteger(item.size) || item.size < 0) failSchema(`${label} has invalid size`);
  const mode = normaliseMode(item.mode, label);
  if (role === 'old') {
    const bytes = decodeJournalBytes(item.bytes, label);
    if (bytes.length !== item.size) failSchema(`${label} bytes do not match size`);
    if (`sha256:${sha256Hex(bytes)}` !== digest) failSchema(`${label} bytes do not match sha256`);
  }
  return Object.freeze({ path: canonical.path, kind: 'regular', digest, size: item.size, mode });
}

function validateCanonicalPlanBinding(journal, oldItems, newItems) {
  const plan = journal.canonicalPlan;
  assertClosedObject(plan, PLAN_SCHEMA_FIELDS, 'journal canonicalPlan');
  for (const field of PLAN_SCHEMA_FIELDS) {
    if (!Object.hasOwn(plan, field)) failSchema(`journal canonicalPlan missing required field: ${field}`);
  }
  const { planDigest: _ignored, ...content } = plan;
  const actualDigest = `sha256:${sha256Hex(canonicalJson(content))}`;
  if (plan.planDigest !== journal.planDigest || actualDigest !== journal.planDigest) {
    failSchema('journal canonicalPlan digest does not match journal planDigest');
  }
  if (plan.apiVersion !== 'release-skill.dev/artifact-plan/v1'
      || !['inspect', 'status', 'apply'].includes(plan.operation)
      || plan.safeToWrite !== true || plan.targetUnchanged !== true) {
    failSchema('journal canonicalPlan is not an applyable v1 plan');
  }
  const bindingFields = new Set([
    'repositoryIdentity', 'policyDigest', 'baseManifestDigest',
    'currentManifestDigest', 'producerClosureDigest',
  ]);
  assertClosedObject(plan.bindings, bindingFields, 'journal canonicalPlan.bindings');
  for (const field of bindingFields) {
    if (!DIGEST_RE.test(plan.bindings[field])) {
      failSchema(`journal canonicalPlan binding ${field} is invalid`);
    }
  }
  assertClosedObject(plan.nextAction, new Set(['command']), 'journal canonicalPlan.nextAction');
  if (typeof plan.nextAction.command !== 'string'
      || !/\bartifacts apply\b/.test(plan.nextAction.command)) {
    failSchema('journal canonicalPlan nextAction is not apply');
  }
  if (!Array.isArray(plan.artifacts) || plan.artifacts.length !== newItems.length) {
    failSchema('journal canonicalPlan artifacts do not match manifest length');
  }

  for (let i = 0; i < plan.artifacts.length; i++) {
    const artifact = plan.artifacts[i];
    const label = `journal canonicalPlan.artifacts[${i}]`;
    assertClosedObject(artifact, ARTIFACT_SCHEMA_FIELDS, label);
    for (const field of ARTIFACT_SCHEMA_FIELDS) {
      if (!Object.hasOwn(artifact, field)) failSchema(`${label} missing required field: ${field}`);
    }
    if (typeof artifact.id !== 'string' || artifact.id.length === 0) failSchema(`${label} has invalid id`);
    if (artifact.safeToWrite !== true
        || !new Set([
          'READY', 'CLEAN', 'NEW', 'HUMAN_CHANGED',
          'GENERATOR_CHANGED', 'MERGEABLE', 'RESOLVED',
        ]).has(artifact.status)) {
      failSchema(`${label} is not safe to write`);
    }
    const canonical = canonicalArtifactPath(artifact.path);
    if (canonical.path !== artifact.path || canonical.path !== oldItems[i].path) {
      failSchema(`${label} path does not match manifests`);
    }
    for (const [role, entry, manifest] of [
      ['oldEntry', artifact.oldEntry, oldItems[i]],
      ['newEntry', artifact.newEntry, newItems[i]],
    ]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.kind !== manifest.kind) {
        failSchema(`${label}.${role} does not match manifest kind`);
      }
      if (entry.kind === 'absent') {
        if (Object.keys(entry).length !== 1) failSchema(`${label}.${role} absent entry is not closed`);
        continue;
      }
      const entryFields = role === 'oldEntry'
        ? new Set(['kind', 'sha256', 'size', 'mode'])
        : new Set(['kind', 'bytes', 'sha256', 'size', 'mode']);
      assertClosedObject(entry, entryFields, `${label}.${role}`);
      for (const field of entryFields) {
        if (!Object.hasOwn(entry, field)) failSchema(`${label}.${role} missing required field: ${field}`);
      }
      if (normaliseDigest(entry.sha256, `${label}.${role}`) !== manifest.digest
          || entry.size !== manifest.size
          || normaliseMode(entry.mode, `${label}.${role}`) !== manifest.mode) {
        failSchema(`${label}.${role} does not match manifest identity`);
      }
      if (role === 'newEntry') {
        const bytes = decodeJournalBytes(entry.bytes, `${label}.${role}`);
        if (bytes.length !== manifest.size || `sha256:${sha256Hex(bytes)}` !== manifest.digest) {
          failSchema(`${label}.${role} bytes do not match manifest identity`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Handle helpers
// ---------------------------------------------------------------------------

/**
 * Navigate a handle through a slash-separated path, creating each segment
 * if it does not already exist.
 *
 * P0-5 fix: must NOT catch arbitrary openDir errors and mkdir.
 * First check if segment exists via readEntry; only mkdir if truly absent.
 * Symlinks, non-directories, permission/IO errors must fail closed.
 *
 * @param {object} handle — starting DirectoryHandle.
 * @param {string[]} segments — path segments to navigate.
 * @returns {Promise<object>} The leaf DirectoryHandle.
 */
async function ensurePath(handle, segments, openedHandles = []) {
  let current = handle;
  for (const seg of segments) {
    try {
      current = await current.openDir(seg);
      openedHandles.push(current);
    } catch (openErr) {
      // readEntry returns null (native) or {kind:'absent'} (recording) for
      // ENOENT. Every other result/error must fail closed: never turn an
      // EACCES, symlink, special file, or transient IO error into mkdir.
      const entry = await current.readEntry(seg);
      const absent = entry === null || entry?.kind === 'absent';
      if (!absent) {
        const isDirectory = entry?.type === 'directory' || entry?.kind === 'tree';
        if (isDirectory) throw openErr;
        throw new ReleaseError(
          PATH_UNSAFE,
          `ensurePath: path segment is not a directory: ${entry?.type || entry?.kind || 'unknown'}`,
        );
      }
      await current.mkdir(seg, 0o700);
      await current.fsync();
      current = await current.openDir(seg);
      openedHandles.push(current);
    }
  }
  return current;
}

async function closeHandlesReverse(handles) {
  const failures = [];
  for (let i = handles.length - 1; i >= 0; i--) {
    try {
      await handles[i].close();
    } catch (error) {
      failures.push(error?.code || error?.message || 'close failed');
    }
  }
  if (failures.length > 0) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'transaction handle close failed',
      { closeFailures: failures },
    );
  }
}

/**
 * Read and parse a JSON file through a handle.
 *
 * @param {object} handle — DirectoryHandle containing the file.
 * @param {string} name — file name.
 * @returns {Promise<object|null>} Parsed JSON or null if absent.
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE on corrupt JSON.
 */
async function readJsonViaHandle(handle, name) {
  const result = await handle.readFile(name);
  if (result === null) return null;
  const text = result.bytes.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      `journal file ${name} is corrupt (invalid JSON)`,
    );
  }
}

/**
 * Write a JSON object to a file atomically through a handle using
 * createTemp + fsync + rename + parent fsync.
 *
 * @param {object} handle — DirectoryHandle for the target directory.
 * @param {string} name — target file name.
 * @param {object} data — JSON-serialisable data.
 */
async function writeJsonViaHandle(handle, name, data) {
  const bytes = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  const expectedIdentity = await handle.readFile(name);
  const token = await handle.createTemp(name, 0o600, bytes);
  try {
    await handle.rename(token, name, expectedIdentity);
  } catch (error) {
    try {
      const aborted = await handle.abortTemp(token);
      if (!aborted?.removed) {
        error.details = { ...(error.details || {}), abortResult: aborted };
      }
    } catch (abortError) {
      error.details = {
        ...(error.details || {}),
        abortError: abortError?.code || abortError?.message || 'abort failed',
      };
    }
    throw error;
  }
  await handle.fsync();
}

async function abortTempAfterFailure(handle, token, primaryError) {
  try {
    const result = await handle.abortTemp(token);
    if (!result?.removed) {
      primaryError.details = { ...(primaryError.details || {}), abortResult: result };
    }
  } catch (abortError) {
    primaryError.details = {
      ...(primaryError.details || {}),
      abortError: abortError?.code || abortError?.message || 'abort failed',
    };
  }
}

/**
 * Validate a journal object against the closed schema.
 *
 * P0-7: Validates all required fields, transitions/entries structure,
 * index ranges, path uniqueness, transactionId/path safety, and legal
 * state transitions. Rejects from:null pseudo-transitions and metadata
 * overwriting reserved fields.
 *
 * @param {object} journal — journal object.
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE on unknown fields or
 *   invalid structure.
 */
function validateJournalSchema(journal) {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal is not an object');
  }

  // P0-7: Validate closed schema
  for (const key of Object.keys(journal)) {
    if (!JOURNAL_SCHEMA_FIELDS.has(key)) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `journal has unknown field: ${key}`,
      );
    }
  }
  for (const field of JOURNAL_SCHEMA_FIELDS) {
    if (!Object.hasOwn(journal, field)) {
      throw new ReleaseError(TRANSACTION_INCOMPLETE, `journal missing required field: ${field}`);
    }
  }

  // P0-7: Validate required fields
  if (typeof journal.transactionId !== 'string' || journal.transactionId.length === 0) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal missing transactionId');
  }

  // P0-7: Validate transactionId safety (no path separators, NUL, etc.)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(journal.transactionId)) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'journal transactionId contains unsafe characters',
      { transactionId: journal.transactionId },
    );
  }

  if (typeof journal.planDigest !== 'string' || !DIGEST_RE.test(journal.planDigest)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal missing planDigest');
  }

  if (!journal.canonicalPlan || typeof journal.canonicalPlan !== 'object'
      || Array.isArray(journal.canonicalPlan)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal canonicalPlan must be an object');
  }
  if (!Array.isArray(journal.oldManifest) || !Array.isArray(journal.newManifest)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal manifests must be arrays');
  }
  if (journal.oldManifest.length !== journal.newManifest.length) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal manifest lengths differ');
  }

  if (!VALID_STATES.has(journal.state)) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      `journal has invalid state: ${journal.state}`,
    );
  }

  if (!Array.isArray(journal.transitions)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal transitions is not an array');
  }

  if (!Array.isArray(journal.entries)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal entries is not an array');
  }

  let replayState = 'PREPARED';
  // P0-7: Validate transitions structure
  for (let i = 0; i < journal.transitions.length; i++) {
    const t = journal.transitions[i];
    if (!t || typeof t !== 'object') {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `journal transition[${i}] is not an object`,
      );
    }

    // P0-7: Reject from:null pseudo-transitions
    if (t.from === null || t.from === undefined) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `journal transition[${i}] must not use a null from state`,
      );
    } else if (typeof t.from !== 'string' || !VALID_STATES.has(t.from)) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `journal transition[${i}] has invalid from state: ${t.from}`,
      );
    }

    if (typeof t.to !== 'string' || !VALID_STATES.has(t.to)) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `journal transition[${i}] has invalid to state: ${t.to}`,
      );
    }

    // P0-7: Validate transition legality
    if (t.from !== replayState || !VALID_TRANSITIONS[t.from]?.includes(t.to)) {
      throw new ReleaseError(
        INVALID_STATE_TRANSITION,
        `journal transition[${i}] illegal or discontinuous: ${t.from} -> ${t.to}`,
        { from: t.from, to: t.to, expectedFrom: replayState },
      );
    }
    replayState = t.to;

    // Validate entryIndex if present
    if (t.entryIndex !== undefined && t.entryIndex !== null) {
      if (typeof t.entryIndex !== 'number' || t.entryIndex < 0
          || !Number.isInteger(t.entryIndex)
          || t.entryIndex >= journal.newManifest.length) {
        throw new ReleaseError(
          TRANSACTION_INCOMPLETE,
          `journal transition[${i}] has invalid entryIndex: ${t.entryIndex}`,
        );
      }
    }

    // P0-7: Reject unknown transition fields
    const TRANSITION_SCHEMA_FIELDS = new Set(['from', 'to', 'entryIndex', 'timestamp']);
    for (const key of Object.keys(t)) {
      if (!TRANSITION_SCHEMA_FIELDS.has(key)) {
        throw new ReleaseError(
          TRANSACTION_INCOMPLETE,
          `journal transition[${i}] has unknown field: ${key}`,
        );
      }
    }
    if (typeof t.timestamp !== 'string' || !Number.isFinite(Date.parse(t.timestamp))) {
      throw new ReleaseError(TRANSACTION_INCOMPLETE, `journal transition[${i}] has invalid timestamp`);
    }
  }
  if (replayState !== journal.state) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      `journal state ${journal.state} does not match transition replay ${replayState}`,
    );
  }

  const manifestPaths = new Set();
  const oldItems = [];
  const newItems = [];
  for (let i = 0; i < journal.newManifest.length; i++) {
    const oldItem = journal.oldManifest[i];
    const newItem = journal.newManifest[i];
    const validatedOld = validateManifestItem(oldItem, 'old', i);
    const validatedNew = validateManifestItem(newItem, 'new', i);
    if (validatedOld.path !== validatedNew.path) {
      throw new ReleaseError(TRANSACTION_INCOMPLETE, `journal manifest[${i}] paths differ`);
    }
    oldItems.push(validatedOld);
    newItems.push(validatedNew);
    const { collisionKey } = canonicalArtifactPath(validatedNew.path);
    if (manifestPaths.has(collisionKey)) {
      throw new ReleaseError(TRANSACTION_INCOMPLETE, `journal manifest path is duplicated: ${newItem.path}`);
    }
    manifestPaths.add(collisionKey);
  }
  validateCanonicalPlanBinding(journal, oldItems, newItems);

  // P0-7: Validate entries structure
  const seenIndices = new Set();
  const seenPaths = new Set();
  if (journal.entries.length > journal.newManifest.length) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal entries exceed manifest length');
  }
  for (let i = 0; i < journal.entries.length; i++) {
    const e = journal.entries[i];
    if (e === null || e === undefined) {
      // Entries may have null gaps (write-ahead placeholders)
      continue;
    }

    if (typeof e !== 'object') {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `journal entries[${i}] is not an object or null`,
      );
    }

    // P0-7: Validate entry index uniqueness
    if (seenIndices.has(i)) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `journal entries has duplicate index: ${i}`,
      );
    }
    seenIndices.add(i);

    // P0-7: Validate entry path uniqueness
    if (typeof e.id !== 'string' || e.id.length === 0 || typeof e.path !== 'string') {
      throw new ReleaseError(TRANSACTION_INCOMPLETE, `journal entries[${i}] missing id/path`);
    }
    const entryPath = canonicalArtifactPath(e.path);
    if (e.id !== journal.canonicalPlan.artifacts[i].id
        || entryPath.path !== newItems[i].path) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `journal entries[${i}] does not match canonical plan authority`,
      );
    }
    if (typeof e.path === 'string') {
      if (seenPaths.has(entryPath.collisionKey)) {
        throw new ReleaseError(
          TRANSACTION_INCOMPLETE,
          `journal entries has duplicate path: ${e.path}`,
        );
      }
      seenPaths.add(entryPath.collisionKey);
    }
    if (!['pending', 'applied'].includes(e.status)) {
      throw new ReleaseError(TRANSACTION_INCOMPLETE, `journal entries[${i}] has invalid status`);
    }
    if (typeof e.appliedAt !== 'string' || !Number.isFinite(Date.parse(e.appliedAt))) {
      throw new ReleaseError(TRANSACTION_INCOMPLETE, `journal entries[${i}] has invalid appliedAt`);
    }

    // P0-7: Validate entry closed schema
    const ENTRY_SCHEMA_FIELDS = new Set(['id', 'path', 'status', 'appliedAt']);
    for (const key of Object.keys(e)) {
      if (!ENTRY_SCHEMA_FIELDS.has(key)) {
        throw new ReleaseError(
          TRANSACTION_INCOMPLETE,
          `journal entries[${i}] has unknown field: ${key}`,
        );
      }
    }
  }

  if (typeof journal.createdAt !== 'string' || !Number.isFinite(Date.parse(journal.createdAt))) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal createdAt must be a timestamp');
  }
  if (typeof journal.updatedAt !== 'string' || !Number.isFinite(Date.parse(journal.updatedAt))) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal updatedAt must be a timestamp');
  }
  if (['APPLIED', 'VERIFYING', 'COMMITTED'].includes(journal.state)) {
    if (journal.entries.length !== journal.newManifest.length
        || journal.entries.some((entry) => !entry || entry.status !== 'applied')) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `journal state ${journal.state} requires every manifest entry to be applied`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Journal creation
// ---------------------------------------------------------------------------

/**
 * Create a new transaction journal through the safe-fs backend.
 *
 * Creates `.release-skill/transactions/<txnId>/journal.json` with initial
 * PREPARED state, canonical plan, old/new manifest.
 *
 * @param {object} options
 * @param {object} options.backend — safe-fs backend.
 * @param {string} options.root — repository root.
 * @param {string} options.transactionId — unique transaction ID.
 * @param {string} options.planDigest — canonical plan digest.
 * @param {object} options.canonicalPlan — decoded plan (with Buffer bytes).
 * @param {object[]} options.oldManifest — snapshot of old entries with
 *   backup bytes (for absent entries, `absent: true`).
 * @param {object[]} options.newManifest — snapshot of new entries.
 * @returns {Promise<{ journal: object, txnHandle: object }>}
 */
export async function createTransactionJournal({
  rootHandle,
  transactionId,
  planDigest,
  canonicalPlan,
  oldManifest,
  newManifest,
} = {}) {
  if (typeof transactionId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(transactionId)) {
    throw new ReleaseError(PATH_UNSAFE, 'transactionId is not a safe path segment');
  }
  if (typeof planDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(planDigest)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'planDigest is invalid');
  }
  const openedHandles = [];
  try {

  // Ensure .release-skill/transactions/ exists
  const txnParent = await ensurePath(
    rootHandle,
    ['.release-skill', 'transactions'],
    openedHandles,
  );

  // Create the transaction directory
  try {
    await txnParent.mkdir(transactionId, 0o700);
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `transaction directory already exists: ${transactionId}`,
        { transactionId },
      );
    }
    throw err;
  }
  await txnParent.fsync();

  const txnHandle = await txnParent.openDir(transactionId);
  openedHandles.push(txnHandle);

  const now = new Date().toISOString();
  const journal = {
    transactionId,
    planDigest,
    canonicalPlan,
    oldManifest,
    newManifest,
    state: 'PREPARED',
    transitions: [],
    entries: [],
    createdAt: now,
    updatedAt: now,
  };

  validateJournalSchema(journal);
  await writeJsonViaHandle(txnHandle, 'journal.json', journal);

  return {
    journal,
    txnHandle,
    async close() {
      await closeHandlesReverse(openedHandles);
    },
  };
  } catch (error) {
    try {
      await closeHandlesReverse(openedHandles);
    } catch (closeError) {
      error.details = {
        ...(error.details || {}),
        closeFailures: closeError.details?.closeFailures || [closeError.code || closeError.message],
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Journal reading
// ---------------------------------------------------------------------------

/**
 * Read and validate the journal from a transaction handle.
 *
 * @param {object} txnHandle — DirectoryHandle for the transaction directory.
 * @param {string} transactionId — for error context.
 * @returns {Promise<object>} Validated journal data.
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE if missing or corrupt.
 */
export async function readJournal(txnHandle, transactionId) {
  const journal = await readJsonViaHandle(txnHandle, 'journal.json');
  if (journal === null) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'transaction journal does not exist',
      { transactionId },
    );
  }
  validateJournalSchema(journal);
  if (journal.transactionId !== transactionId) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'journal transactionId does not match its directory authority',
      { expected: transactionId, actual: journal.transactionId },
    );
  }
  return journal;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/**
 * Write a journal state transition through the transaction handle.
 *
 * @param {object} options
 * @param {object} options.txnHandle — DirectoryHandle.
 * @param {string} options.transactionId — for error context.
 * @param {string|null} options.from — expected current state (null = skip
 *   check for initial write).
 * @param {string} options.to — target state.
 * @param {number} [options.entryIndex] — entry index for write-ahead.
 * @returns {Promise<object>} Updated journal.
 * @throws {ReleaseError} INVALID_STATE_TRANSITION on invalid transition.
 */
export async function writeJournalTransition({
  txnHandle,
  transactionId,
  from,
  to,
  entryIndex,
} = {}) {
  if (typeof from !== 'string' || !VALID_STATES.has(from)) {
    throw new ReleaseError(
      INVALID_STATE_TRANSITION,
      'journal transitions require a concrete valid from state',
      { from },
    );
  }
  const journal = await readJournal(txnHandle, transactionId);

  if (from !== null && journal.state !== from) {
    throw new ReleaseError(
      INVALID_STATE_TRANSITION,
      `invalid state transition: expected ${from}, got ${journal.state}`,
      { expected: from, actual: journal.state, transactionId },
    );
  }

  if (from !== null && !VALID_TRANSITIONS[from]?.includes(to)) {
    throw new ReleaseError(
      INVALID_STATE_TRANSITION,
      `invalid state transition: ${from} -> ${to}`,
      { from, to, transactionId },
    );
  }

  if (from !== null) {
    journal.state = to;
  }

  journal.transitions.push({
    from,
    to,
    entryIndex,
    timestamp: new Date().toISOString(),
  });

  journal.updatedAt = new Date().toISOString();

  await writeJsonViaHandle(txnHandle, 'journal.json', journal);

  return journal;
}

// ---------------------------------------------------------------------------
// Entry recording
// ---------------------------------------------------------------------------

/**
 * Record a write-ahead entry index (before mutation) or an applied entry
 * (after mutation) in the journal.
 *
 * @param {object} options
 * @param {object} options.txnHandle — DirectoryHandle.
 * @param {string} options.transactionId — for error context.
 * @param {number} options.entryIndex — entry index.
 * @param {object} [options.entry] — entry data (omit for write-ahead).
 * @returns {Promise<object>} Updated journal.
 */
export async function recordAppliedEntry({
  txnHandle,
  transactionId,
  entryIndex,
  entry,
} = {}) {
  if (!Number.isInteger(entryIndex) || entryIndex < 0) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'entryIndex must be a non-negative integer');
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some((key) => !['id', 'path', 'status'].includes(key))
      || typeof entry.id !== 'string' || typeof entry.path !== 'string'
      || !['pending', 'applied'].includes(entry.status)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal entry metadata is invalid');
  }
  const journal = await readJournal(txnHandle, transactionId);
  if (entryIndex >= journal.newManifest.length) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'entryIndex exceeds manifest length');
  }

  while (journal.entries.length <= entryIndex) {
    journal.entries.push(null);
  }

  journal.entries[entryIndex] = {
    ...entry,
    appliedAt: new Date().toISOString(),
  };

  journal.updatedAt = new Date().toISOString();
  await writeJsonViaHandle(txnHandle, 'journal.json', journal);

  return journal;
}

// ---------------------------------------------------------------------------
// Backup operations (all through handle)
// ---------------------------------------------------------------------------

/**
 * Create a backup of an old entry before applying changes.
 *
 * For regular files, backs up the full bytes. For absent entries,
 * writes an absence tombstone.
 *
 * @param {object} options
 * @param {object} options.txnHandle — DirectoryHandle for the transaction dir.
 * @param {string} options.transactionId — for error context.
 * @param {number} options.entryIndex — entry index.
 * @param {object} options.oldEntry — old entry data (may have bytes or absent flag).
 * @returns {Promise<void>}
 */
export async function createBackup({
  txnHandle,
  transactionId,
  entryIndex,
  oldEntry,
} = {}) {
  if (!Number.isInteger(entryIndex) || entryIndex < 0) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'backup entryIndex is invalid');
  }
  // Ensure backups directory exists
  let backupsHandle;
  try {
    backupsHandle = await txnHandle.openDir('backups');
  } catch (openErr) {
    const entry = await txnHandle.readEntry('backups');
    const absent = entry === null || entry?.kind === 'absent';
    if (!absent) {
      const isDirectory = entry?.type === 'directory' || entry?.kind === 'tree';
      if (isDirectory) throw openErr;
      throw new ReleaseError(PATH_UNSAFE, 'backups path is not a directory');
    }
    await txnHandle.mkdir('backups', 0o700);
    await txnHandle.fsync();
    backupsHandle = await txnHandle.openDir('backups');
  }

  let primaryError;
  try {
    const backupData = oldEntry.kind === 'regular' && oldEntry.bytes
      ? Buffer.from(oldEntry.bytes)
      : Buffer.from(JSON.stringify({ absent: true, entryIndex, timestamp: new Date().toISOString() }), 'utf8');

    const backupName = `${entryIndex}.bak`;
    const token = await backupsHandle.createTemp(backupName, 0o600, backupData);
    try {
      await backupsHandle.rename(token, backupName);
    } catch (error) {
      await abortTempAfterFailure(backupsHandle, token, error);
      throw error;
    }
    await backupsHandle.fsync();
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await backupsHandle.close();
    } catch (closeError) {
      if (primaryError) {
        primaryError.details = {
          ...(primaryError.details || {}),
          closeError: closeError?.code || closeError?.message || 'close failed',
        };
      } else {
        throw closeError;
      }
    }
  }
  if (primaryError) throw primaryError;
}

// ---------------------------------------------------------------------------
// Recovery file
// ---------------------------------------------------------------------------

/**
 * Write a RECOVERY_REQUIRED marker file through the transaction handle.
 *
 * @param {object} options
 * @param {object} options.txnHandle — DirectoryHandle.
 * @param {string} options.transactionId — transaction ID.
 * @param {boolean} options.targetUnchanged — whether targets are unchanged.
 * @param {string} options.recover — unique recover command.
 * @returns {Promise<void>}
 */
export async function writeRecoveryRequiredFile({
  txnHandle,
  transactionId,
  targetUnchanged,
  recover,
} = {}) {
  const data = {
    transactionId,
    targetUnchanged,
    recover,
    failedAt: new Date().toISOString(),
  };
  const bytes = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  const expectedIdentity = await txnHandle.readFile('RECOVERY_REQUIRED');
  const token = await txnHandle.createTemp('RECOVERY_REQUIRED', 0o600, bytes);
  try {
    await txnHandle.rename(token, 'RECOVERY_REQUIRED', expectedIdentity);
  } catch (error) {
    await abortTempAfterFailure(txnHandle, token, error);
    throw error;
  }
  await txnHandle.fsync();
}
