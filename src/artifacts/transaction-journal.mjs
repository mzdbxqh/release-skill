/**
 * Transaction journal for durable apply operations.
 *
 * Manages write-ahead logging, state transitions, and crash recovery
 * for artifact plan applications. ALL transactional filesystem writes go
 * through the safe-fs backend DirectoryHandle — no Node path-based writes.
 *
 * Documented exception — retention pruning: `pruneTerminalTransactionRecords`
 * is a best-effort maintenance path that uses `node:fs` to enumerate and
 * remove old TERMINAL records. The safe-fs handle exposes neither directory
 * enumeration nor recursive removal, and a retention failure must never abort
 * or roll back a transaction, so this single helper deliberately bypasses the
 * handle. It is scoped strictly to the current process's transactions root and
 * never prunes non-terminal (recovery-relevant) records. See that helper.
 *
 * @module artifacts/transaction-journal
 */

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
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

// ---------------------------------------------------------------------------
// Retention policy constants
// ---------------------------------------------------------------------------

/**
 * Terminal transaction states that are safe to prune under the retention
 * policy. These are the states with NO outgoing transitions in
 * VALID_TRANSITIONS that the recovery protocol does NOT depend on.
 *
 * `RECOVERY_CONFLICT` also has no outgoing transitions but is deliberately
 * EXCLUDED: it signals a rollback conflict that requires a human decision
 * (see the state-machine discipline in AGENTS.md), so its record must be kept
 * as evidence. Every other non-terminal state (PREPARED, APPLYING, APPLIED,
 * VERIFYING, RECOVERY_REQUIRED, ROLLING_BACK) is recovery-relevant and is
 * never pruned either.
 */
export const PRUNABLE_TERMINAL_STATES = Object.freeze(new Set(['COMMITTED', 'ROLLED_BACK']));

/**
 * Default retention cap: the maximum number of TERMINAL (COMMITTED /
 * ROLLED_BACK) transaction records retained under `.release-skill/transactions/`.
 *
 * When the number of terminal records exceeds this cap, the oldest terminal
 * records (by journal `createdAt`, falling back to directory mtime) are removed
 * until exactly the cap remains. Non-terminal records are never counted against
 * the cap and never pruned. Override per call via the `retentionMax` option on
 * `createTransactionJournal` / `pruneTerminalTransactionRecords`.
 */
export const DEFAULT_TRANSACTION_RETENTION_MAX = 50;

// ---------------------------------------------------------------------------
// Terminal receipt convergence constants
// ---------------------------------------------------------------------------

/**
 * The explicitly versioned terminal-receipt schema version written by
 * `convergeTerminalRecord`. Receipts carry `terminalReceiptVersion >= 1`;
 * readers fail closed on unknown versions.
 */
export const TERMINAL_RECEIPT_VERSION = 1;

/**
 * Fixed, payload-independent upper bound (bytes) for the serialized terminal
 * receipt (`journal.json` of a converged COMMITTED / ROLLED_BACK record).
 *
 * Rationale: a receipt is a few KB of audit JSON even for a large write set
 * (100 entries x ~300B of digests/metadata ~ 30KB); 256KB is ~8x headroom over
 * that, >=3 orders of magnitude below the observed ~228MB defect records in
 * the read-only `.release-skill/transactions/` evidence, and bounds the
 * worst-case retention footprint to 50 x 256KB = 12.8MB (vs the ~11GB the
 * count-only retention cap permits for payload-sized records). Receipts are
 * never allowed to scale with payload bytes: the whole record is digests,
 * counts, and small audit metadata only — never old/new file bodies,
 * serialized Buffers, or canonicalPlan payload bytes.
 */
export const TERMINAL_RECEIPT_SIZE_CAP = 256 * 1024;

/**
 * Maximum admissible growth of the whole terminal txn directory when the
 * payload grows by several MB. Proves the record no longer scales with
 * payload bytes while admitting per-entry audit growth. Pairs with
 * TERMINAL_RECEIPT_SIZE_CAP (see that constant's rationale).
 */
export const TERMINAL_RECEIPT_DELTA_CAP = 64 * 1024;

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

/**
 * Closed field set of the explicitly versioned terminal receipt (schema
 * version 1). A receipt is what a terminal (COMMITTED / ROLLED_BACK) record's
 * `journal.json` is atomically rewritten into by `convergeTerminalRecord`:
 * small audit metadata only — never old/new file bodies, serialized Buffers,
 * or canonicalPlan payload bytes. `oldManifest` survives as a digest-only
 * summary (no `bytes`); `canonicalPlan` survives with artifact-plan v1
 * `newEntry.bytes` stripped (docs-refresh v1 plans never carry bytes).
 */
const RECEIPT_SCHEMA_FIELDS = new Set([
  'terminalReceiptVersion',
  'transactionId',
  'planDigest',
  'canonicalPlan',
  'planSummary',
  'oldManifest',
  'newManifest',
  'state',
  'transitions',
  'entries',
  'createdAt',
  'updatedAt',
]);
const RECEIPT_ENTRY_FIELDS = new Set(['id', 'path', 'status', 'appliedAt', 'digest']);
const RECEIPT_DIGEST_FIELDS = new Set(['path', 'kind', 'sha256', 'size', 'mode']);
const RECEIPT_PLAN_SUMMARY_FIELDS = new Set(['apiVersion', 'operation']);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const PLAN_SCHEMA_FIELDS = new Set([
  'apiVersion', 'operation', 'bindings', 'safeToWrite', 'targetUnchanged',
  'nextAction', 'artifacts', 'planDigest',
]);
const ARTIFACT_SCHEMA_FIELDS = new Set([
  'id', 'path', 'oldEntry', 'newEntry', 'status', 'safeToWrite',
]);

// Closed canonical-plan schema for the docs-refresh v1 transaction authority
// (2026-07-21-release-docs-refresh-protocol §6). No bytes, no
// absolute paths: only canonical relative paths and digests.
const DOCS_REFRESH_PLAN_FIELDS = new Set([
  'apiVersion', 'operation', 'unitId', 'version', 'refreshDigest', 'files',
]);
const DOCS_REFRESH_FILE_FIELDS = new Set([
  'id', 'path', 'kind', 'locale', 'oldDigest', 'newDigest', 'change',
]);
const DOCS_REFRESH_UNIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

/**
 * Select the per-entry authority items of a canonical plan by apiVersion:
 * artifact-plan v1 plans carry `artifacts`, docs-refresh v1 plans carry
 * `files`. Unknown apiVersions fail closed.
 *
 * @param {object} canonicalPlan — validated journal canonicalPlan.
 * @returns {object[]} The per-entry authority items (id/path carriers).
 */
function canonicalPlanItems(canonicalPlan) {
  if (canonicalPlan?.apiVersion === 'release-skill.dev/artifact-plan/v1') {
    return canonicalPlan.artifacts;
  }
  if (canonicalPlan?.apiVersion === 'release-skill.dev/docs-refresh/v1') {
    return canonicalPlan.files;
  }
  return failSchema('journal canonicalPlan apiVersion is unsupported');
}

/**
 * Validate the closed artifact-plan v1 canonicalPlan authority against the
 * journal and its manifests. Behaviour is byte-for-byte the pre-refactor
 * validateCanonicalPlanBinding body.
 */
function validateArtifactPlanAuthority(journal, oldItems, newItems) {
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

/**
 * Validate the closed docs-refresh v1 canonicalPlan authority against the
 * journal and its manifests: closed field sets, refresh operation, safe
 * unitId, non-empty version, refreshDigest bound to journal.planDigest, and
 * per-file identity agreement with both manifests (canonical relative paths
 * only; digests only; never bytes).
 */
function validateDocsRefreshAuthority(journal, oldItems, newItems) {
  const plan = journal.canonicalPlan;
  assertClosedObject(plan, DOCS_REFRESH_PLAN_FIELDS, 'journal canonicalPlan');
  for (const field of DOCS_REFRESH_PLAN_FIELDS) {
    if (!Object.hasOwn(plan, field)) failSchema(`journal canonicalPlan missing required field: ${field}`);
  }
  if (plan.operation !== 'refresh') {
    failSchema('journal canonicalPlan operation must be refresh');
  }
  if (typeof plan.unitId !== 'string' || !DOCS_REFRESH_UNIT_ID_RE.test(plan.unitId)) {
    failSchema('journal canonicalPlan unitId is invalid');
  }
  if (typeof plan.version !== 'string' || plan.version.length === 0) {
    failSchema('journal canonicalPlan version is invalid');
  }
  if (typeof plan.refreshDigest !== 'string'
      || !DIGEST_RE.test(plan.refreshDigest)
      || plan.refreshDigest !== journal.planDigest) {
    failSchema('journal canonicalPlan refreshDigest does not match journal planDigest');
  }
  if (!Array.isArray(plan.files)
      || plan.files.length !== oldItems.length
      || plan.files.length !== newItems.length) {
    failSchema('journal canonicalPlan files do not match manifest length');
  }

  const seenIds = new Set();
  for (let i = 0; i < plan.files.length; i++) {
    const file = plan.files[i];
    const label = `journal canonicalPlan.files[${i}]`;
    assertClosedObject(file, DOCS_REFRESH_FILE_FIELDS, label);
    for (const field of DOCS_REFRESH_FILE_FIELDS) {
      if (!Object.hasOwn(file, field)) failSchema(`${label} missing required field: ${field}`);
    }
    if (typeof file.id !== 'string' || file.id.length === 0) failSchema(`${label} has invalid id`);
    if (seenIds.has(file.id)) failSchema(`${label} has duplicate id`);
    seenIds.add(file.id);
    const canonical = canonicalArtifactPath(file.path);
    if (canonical.path !== file.path
        || canonical.path !== oldItems[i].path
        || canonical.path !== newItems[i].path) {
      failSchema(`${label} path does not match manifests`);
    }
    if (oldItems[i].kind !== 'regular') {
      failSchema(`${label} old manifest entry is not regular`);
    }
    if (normaliseDigest(file.oldDigest, `${label}.oldDigest`) !== oldItems[i].digest) {
      failSchema(`${label} oldDigest does not match manifest identity`);
    }
    if (normaliseDigest(file.newDigest, `${label}.newDigest`) !== newItems[i].digest) {
      failSchema(`${label} newDigest does not match manifest identity`);
    }
    if (file.kind !== 'changelog' && file.kind !== 'readme') {
      failSchema(`${label} has invalid kind`);
    }
    if (typeof file.locale !== 'string' || file.locale.length === 0) {
      failSchema(`${label} has invalid locale`);
    }
    if (file.change !== 'insert' && file.change !== 'update') {
      failSchema(`${label} has invalid change`);
    }
  }
}

/**
 * Dispatch canonicalPlan authority validation by apiVersion. The
 * artifact-plan v1 branch preserves the pre-refactor behaviour exactly; the
 * docs-refresh v1 branch validates the closed docs-refresh authority.
 */
function validateCanonicalPlanAuthority(journal, oldItems, newItems) {
  const plan = journal.canonicalPlan;
  if (plan.apiVersion === 'release-skill.dev/artifact-plan/v1') {
    validateArtifactPlanAuthority(journal, oldItems, newItems);
    return;
  }
  if (plan.apiVersion === 'release-skill.dev/docs-refresh/v1') {
    validateDocsRefreshAuthority(journal, oldItems, newItems);
    return;
  }
  failSchema('journal canonicalPlan apiVersion is unsupported');
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
 * Replay the journal transition chain and validate its structure, legality,
 * and continuity. Shared verbatim by the full-journal and terminal-receipt
 * validation branches: both persist the complete transition chain, so both
 * replay it the same way.
 *
 * @param {object} journal — journal or receipt object.
 * @param {number} manifestLength — newManifest length for entryIndex bounds.
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE / INVALID_STATE_TRANSITION.
 */
function validateTransitionChain(journal, manifestLength) {
  if (!Array.isArray(journal.transitions)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal transitions is not an array');
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
          || t.entryIndex >= manifestLength) {
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
}

/**
 * Validate a journal object against the closed schema.
 *
 * P0-7: Validates all required fields, transitions/entries structure,
 * index ranges, path uniqueness, transactionId/path safety, and legal
 * state transitions. Rejects from:null pseudo-transitions and metadata
 * overwriting reserved fields.
 *
 * Two closed shapes are accepted:
 *  - the FULL journal (the recovery authority for non-terminal states, and
 *    the pre-convergence terminal record left behind by a crash/IO failure
 *    at 'before-terminal-receipt-write'); and
 *  - the explicitly versioned TERMINAL RECEIPT (carries
 *    `terminalReceiptVersion`), which is legal ONLY for
 *    PRUNABLE_TERMINAL_STATES — a receipt-shaped record in any non-terminal
 *    state is invalid, and a receipt never carries file bodies, serialized
 *    Buffers, or canonicalPlan payload bytes.
 *
 * @param {object} journal — journal object.
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE on unknown fields or
 *   invalid structure.
 */
function validateJournalSchema(journal) {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal is not an object');
  }

  // Terminal records converge to an explicitly versioned receipt. The
  // presence of the version marker routes to the closed receipt schema.
  if (Object.hasOwn(journal, 'terminalReceiptVersion')) {
    validateTerminalReceiptSchema(journal);
    return;
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

  if (!Array.isArray(journal.entries)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'journal entries is not an array');
  }

  validateTransitionChain(journal, journal.newManifest.length);

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
  validateCanonicalPlanAuthority(journal, oldItems, newItems);
  const planItems = canonicalPlanItems(journal.canonicalPlan);

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
    if (e.id !== planItems[i].id
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
// Terminal receipt (explicitly versioned convergence of terminal records)
// ---------------------------------------------------------------------------

/**
 * Validate a manifest item of a terminal receipt: identical identity fields
 * to the full journal, but NEVER bytes. The closed field set rejects any
 * `bytes` key, which is the AC-1 payload-independence guarantee — a receipt
 * keeps path/kind/sha256/size/mode digests only.
 */
function validateReceiptManifestItem(item, role, index) {
  const label = `receipt ${role}Manifest[${index}]`;
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
  const allowed = new Set(['path', 'kind', 'sha256', 'size', 'mode']);
  assertClosedObject(item, allowed, label); // closed: `bytes` is rejected
  for (const required of allowed) {
    if (!Object.hasOwn(item, required)) failSchema(`${label} missing required field: ${required}`);
  }
  const digest = normaliseDigest(item.sha256, label);
  if (!Number.isSafeInteger(item.size) || item.size < 0) failSchema(`${label} has invalid size`);
  const mode = normaliseMode(item.mode, label);
  return Object.freeze({ path: canonical.path, kind: 'regular', digest, size: item.size, mode });
}

/**
 * Validate the artifact-plan v1 canonicalPlan authority of a terminal
 * receipt: the closed plan schema with `newEntry.bytes` stripped. Identity
 * (digest/size/mode) must still agree with both manifests; the plan digest
 * binding field must equal the journal planDigest. The digest is NOT
 * recomputed: receipt canonicalPlans deliberately omit newEntry bytes, so the
 * full-journal digest recomputation does not apply — planDigest remains the
 * binding authority.
 */
function validateArtifactPlanReceiptAuthority(journal, oldItems, newItems) {
  const plan = journal.canonicalPlan;
  assertClosedObject(plan, PLAN_SCHEMA_FIELDS, 'receipt canonicalPlan');
  for (const field of PLAN_SCHEMA_FIELDS) {
    if (!Object.hasOwn(plan, field)) failSchema(`receipt canonicalPlan missing required field: ${field}`);
  }
  if (typeof plan.planDigest !== 'string' || plan.planDigest !== journal.planDigest) {
    failSchema('receipt canonicalPlan planDigest does not bind the journal planDigest');
  }
  if (plan.apiVersion !== 'release-skill.dev/artifact-plan/v1'
      || !['inspect', 'status', 'apply'].includes(plan.operation)
      || plan.safeToWrite !== true || plan.targetUnchanged !== true) {
    failSchema('receipt canonicalPlan is not an applyable v1 plan');
  }
  const bindingFields = new Set([
    'repositoryIdentity', 'policyDigest', 'baseManifestDigest',
    'currentManifestDigest', 'producerClosureDigest',
  ]);
  assertClosedObject(plan.bindings, bindingFields, 'receipt canonicalPlan.bindings');
  for (const field of bindingFields) {
    if (!DIGEST_RE.test(plan.bindings[field])) {
      failSchema(`receipt canonicalPlan binding ${field} is invalid`);
    }
  }
  assertClosedObject(plan.nextAction, new Set(['command']), 'receipt canonicalPlan.nextAction');
  if (typeof plan.nextAction.command !== 'string'
      || !/\bartifacts apply\b/.test(plan.nextAction.command)) {
    failSchema('receipt canonicalPlan nextAction is not apply');
  }
  if (!Array.isArray(plan.artifacts) || plan.artifacts.length !== newItems.length) {
    failSchema('receipt canonicalPlan artifacts do not match manifest length');
  }

  for (let i = 0; i < plan.artifacts.length; i++) {
    const artifact = plan.artifacts[i];
    const label = `receipt canonicalPlan.artifacts[${i}]`;
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
      // Receipt form: digests only — NEVER bytes (closed field set).
      const entryFields = new Set(['kind', 'sha256', 'size', 'mode']);
      assertClosedObject(entry, entryFields, `${label}.${role}`);
      for (const field of entryFields) {
        if (!Object.hasOwn(entry, field)) failSchema(`${label}.${role} missing required field: ${field}`);
      }
      if (normaliseDigest(entry.sha256, `${label}.${role}`) !== manifest.digest
          || entry.size !== manifest.size
          || normaliseMode(entry.mode, `${label}.${role}`) !== manifest.mode) {
        failSchema(`${label}.${role} does not match manifest identity`);
      }
    }
  }
}

/**
 * Dispatch receipt canonicalPlan authority validation by apiVersion. The
 * docs-refresh v1 plans never carry bytes, so the full authority validator
 * applies verbatim (refreshDigest must bind the journal planDigest); the
 * artifact-plan v1 branch validates the bytes-stripped receipt form.
 */
function validateReceiptCanonicalPlanAuthority(journal, oldItems, newItems) {
  const plan = journal.canonicalPlan;
  if (plan.apiVersion === 'release-skill.dev/artifact-plan/v1') {
    validateArtifactPlanReceiptAuthority(journal, oldItems, newItems);
    return;
  }
  if (plan.apiVersion === 'release-skill.dev/docs-refresh/v1') {
    validateDocsRefreshAuthority(journal, oldItems, newItems);
    return;
  }
  failSchema('receipt canonicalPlan apiVersion is unsupported');
}

/**
 * Validate the closed terminal receipt schema (version 1).
 *
 * A receipt is legal ONLY for PRUNABLE_TERMINAL_STATES (COMMITTED /
 * ROLLED_BACK): a receipt-shaped record in any non-terminal state fails
 * closed, because non-terminal records must keep the full recovery authority
 * (oldManifest bytes + backups). The transition chain replays to `state`,
 * every field set is closed, manifests carry digests only (never bytes), and
 * per-entry audit metadata carries id/path/status/appliedAt plus a
 * path/kind/sha256/size/mode digest summary bound to the new manifest.
 *
 * @param {object} journal — receipt-shaped journal object.
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE / INVALID_STATE_TRANSITION.
 */
function validateTerminalReceiptSchema(journal) {
  for (const key of Object.keys(journal)) {
    if (!RECEIPT_SCHEMA_FIELDS.has(key)) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `terminal receipt has unknown field: ${key}`,
      );
    }
  }
  for (const field of RECEIPT_SCHEMA_FIELDS) {
    if (!Object.hasOwn(journal, field)) {
      throw new ReleaseError(TRANSACTION_INCOMPLETE, `terminal receipt missing required field: ${field}`);
    }
  }

  if (!Number.isInteger(journal.terminalReceiptVersion) || journal.terminalReceiptVersion < 1) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'terminal receipt must carry an explicit integer version >= 1',
    );
  }
  if (journal.terminalReceiptVersion !== TERMINAL_RECEIPT_VERSION) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      `terminal receipt version ${journal.terminalReceiptVersion} is unsupported`,
    );
  }

  if (typeof journal.transactionId !== 'string' || journal.transactionId.length === 0) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'terminal receipt missing transactionId');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(journal.transactionId)) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'terminal receipt transactionId contains unsafe characters',
      { transactionId: journal.transactionId },
    );
  }
  if (typeof journal.planDigest !== 'string' || !DIGEST_RE.test(journal.planDigest)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'terminal receipt missing planDigest');
  }

  // Receipts exist ONLY for terminal states; a receipt shape in any
  // non-terminal state is invalid (recovery authority must stay full).
  if (!PRUNABLE_TERMINAL_STATES.has(journal.state)) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      `terminal receipt is illegal for non-terminal state: ${journal.state}`,
    );
  }

  validateTransitionChain(journal, journal.newManifest.length);

  if (!journal.canonicalPlan || typeof journal.canonicalPlan !== 'object'
      || Array.isArray(journal.canonicalPlan)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'terminal receipt canonicalPlan must be an object');
  }
  if (!Array.isArray(journal.oldManifest) || !Array.isArray(journal.newManifest)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'terminal receipt manifests must be arrays');
  }
  if (journal.oldManifest.length !== journal.newManifest.length) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'terminal receipt manifest lengths differ');
  }

  const manifestPaths = new Set();
  const oldItems = [];
  const newItems = [];
  for (let i = 0; i < journal.newManifest.length; i++) {
    const validatedOld = validateReceiptManifestItem(journal.oldManifest[i], 'old', i);
    const validatedNew = validateReceiptManifestItem(journal.newManifest[i], 'new', i);
    if (validatedOld.path !== validatedNew.path) {
      throw new ReleaseError(TRANSACTION_INCOMPLETE, `terminal receipt manifest[${i}] paths differ`);
    }
    oldItems.push(validatedOld);
    newItems.push(validatedNew);
    const { collisionKey } = canonicalArtifactPath(validatedNew.path);
    if (manifestPaths.has(collisionKey)) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `terminal receipt manifest path is duplicated: ${journal.newManifest[i].path}`,
      );
    }
    manifestPaths.add(collisionKey);
  }

  validateReceiptCanonicalPlanAuthority(journal, oldItems, newItems);
  const planItems = canonicalPlanItems(journal.canonicalPlan);

  assertClosedObject(journal.planSummary, RECEIPT_PLAN_SUMMARY_FIELDS, 'terminal receipt planSummary');
  if (typeof journal.planSummary.apiVersion !== 'string'
      || typeof journal.planSummary.operation !== 'string') {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'terminal receipt planSummary fields must be strings');
  }
  if (journal.planSummary.apiVersion !== journal.canonicalPlan.apiVersion
      || journal.planSummary.operation !== journal.canonicalPlan.operation) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'terminal receipt planSummary does not match canonicalPlan authority',
    );
  }

  if (!Array.isArray(journal.entries)) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'terminal receipt entries is not an array');
  }
  if (journal.entries.length > journal.newManifest.length) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'terminal receipt entries exceed manifest length');
  }
  const seenPaths = new Set();
  for (let i = 0; i < journal.entries.length; i++) {
    const e = journal.entries[i];
    if (e === null || e === undefined) {
      // Write-ahead null gaps survive convergence for partially-applied
      // rollback chains (ROLLED_BACK before every entry was applied).
      continue;
    }
    if (typeof e !== 'object' || Array.isArray(e)) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `terminal receipt entries[${i}] is not an object or null`,
      );
    }
    for (const key of Object.keys(e)) {
      if (!RECEIPT_ENTRY_FIELDS.has(key)) {
        throw new ReleaseError(
          TRANSACTION_INCOMPLETE,
          `terminal receipt entries[${i}] has unknown field: ${key}`,
        );
      }
    }
    if (typeof e.id !== 'string' || e.id.length === 0 || typeof e.path !== 'string') {
      throw new ReleaseError(TRANSACTION_INCOMPLETE, `terminal receipt entries[${i}] missing id/path`);
    }
    const entryPath = canonicalArtifactPath(e.path);
    if (e.id !== planItems[i].id || entryPath.path !== newItems[i].path) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `terminal receipt entries[${i}] does not match canonical plan authority`,
      );
    }
    if (seenPaths.has(entryPath.collisionKey)) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `terminal receipt entries has duplicate path: ${e.path}`,
      );
    }
    seenPaths.add(entryPath.collisionKey);
    if (!['pending', 'applied'].includes(e.status)) {
      throw new ReleaseError(TRANSACTION_INCOMPLETE, `terminal receipt entries[${i}] has invalid status`);
    }
    if (typeof e.appliedAt !== 'string' || !Number.isFinite(Date.parse(e.appliedAt))) {
      throw new ReleaseError(TRANSACTION_INCOMPLETE, `terminal receipt entries[${i}] has invalid appliedAt`);
    }

    // Per-entry digest summary bound to the new manifest — never bytes.
    const digest = e.digest;
    const digestLabel = `terminal receipt entries[${i}].digest`;
    assertClosedObject(digest, RECEIPT_DIGEST_FIELDS, digestLabel);
    const digestPath = canonicalArtifactPath(digest.path);
    if (digestPath.path !== newItems[i].path) {
      throw new ReleaseError(TRANSACTION_INCOMPLETE, `${digestLabel} path does not match manifest`);
    }
    if (newItems[i].kind === 'absent') {
      if (digest.kind !== 'absent') {
        throw new ReleaseError(TRANSACTION_INCOMPLETE, `${digestLabel} kind does not match manifest`);
      }
    } else {
      if (digest.kind !== 'regular') {
        throw new ReleaseError(TRANSACTION_INCOMPLETE, `${digestLabel} kind does not match manifest`);
      }
      for (const required of ['sha256', 'size', 'mode']) {
        if (!Object.hasOwn(digest, required)) {
          throw new ReleaseError(TRANSACTION_INCOMPLETE, `${digestLabel} missing required field: ${required}`);
        }
      }
      if (normaliseDigest(digest.sha256, digestLabel) !== newItems[i].digest
          || digest.size !== newItems[i].size
          || normaliseMode(digest.mode, digestLabel) !== newItems[i].mode) {
        throw new ReleaseError(TRANSACTION_INCOMPLETE, `${digestLabel} does not match manifest identity`);
      }
    }
  }

  if (typeof journal.createdAt !== 'string' || !Number.isFinite(Date.parse(journal.createdAt))) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'terminal receipt createdAt must be a timestamp');
  }
  if (typeof journal.updatedAt !== 'string' || !Number.isFinite(Date.parse(journal.updatedAt))) {
    throw new ReleaseError(TRANSACTION_INCOMPLETE, 'terminal receipt updatedAt must be a timestamp');
  }

  if (journal.state === 'COMMITTED') {
    if (journal.entries.length !== journal.newManifest.length
        || journal.entries.some((entry) => !entry || entry.status !== 'applied')) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        'terminal receipt state COMMITTED requires every manifest entry to be applied',
      );
    }
  }
}

/**
 * Strip payload bytes from a validated canonicalPlan for receipt persistence.
 *
 * artifact-plan v1 plans embed `newEntry.bytes` (the full new file body) —
 * the receipt keeps the digest identity ({kind, sha256, size, mode}) and
 * drops the bytes. docs-refresh v1 plans never carry bytes and pass through
 * unchanged.
 */
function stripCanonicalPlanBytes(canonicalPlan) {
  if (canonicalPlan.apiVersion === 'release-skill.dev/artifact-plan/v1') {
    return {
      ...canonicalPlan,
      artifacts: canonicalPlan.artifacts.map((artifact) => {
        const stripped = { ...artifact };
        if (stripped.newEntry && stripped.newEntry.kind === 'regular') {
          const { bytes: _dropped, ...digestIdentity } = stripped.newEntry;
          stripped.newEntry = digestIdentity;
        }
        return stripped;
      }),
    };
  }
  return canonicalPlan;
}

/**
 * Build the explicitly versioned terminal receipt from a validated FULL
 * terminal journal. The receipt keeps: transactionId, planDigest, state, the
 * complete transition chain, createdAt/updatedAt, digest-only manifests, the
 * bytes-stripped canonicalPlan, a planSummary{apiVersion, operation}, and
 * per-entry audit metadata (id/path/status/appliedAt + a
 * path/kind/sha256/size/mode digest summary). It never keeps old/new file
 * bodies, serialized Buffers, or canonicalPlan payload bytes.
 *
 * @param {object} journal — validated full terminal journal.
 * @returns {object} The receipt (plain JSON-serialisable object).
 */
function buildTerminalReceipt(journal) {
  const oldManifest = journal.oldManifest.map((item) => {
    if (item.kind === 'absent') {
      return { path: item.path, kind: 'absent', absent: true };
    }
    return {
      path: item.path, kind: 'regular',
      sha256: item.sha256, size: item.size, mode: item.mode,
    };
  });
  const newManifest = journal.newManifest.map((item) => {
    if (item.kind === 'absent') return { path: item.path, kind: 'absent' };
    return {
      path: item.path, kind: 'regular',
      sha256: item.sha256, size: item.size, mode: item.mode,
    };
  });
  const entries = journal.entries.map((entry, index) => {
    if (entry === null || entry === undefined) return null;
    const manifestItem = journal.newManifest[index];
    const digest = manifestItem.kind === 'absent'
      ? { path: manifestItem.path, kind: 'absent' }
      : {
        path: manifestItem.path, kind: 'regular',
        sha256: manifestItem.sha256, size: manifestItem.size, mode: manifestItem.mode,
      };
    return {
      id: entry.id, path: entry.path, status: entry.status,
      appliedAt: entry.appliedAt, digest,
    };
  });
  const canonicalPlan = stripCanonicalPlanBytes(journal.canonicalPlan);
  return {
    terminalReceiptVersion: TERMINAL_RECEIPT_VERSION,
    transactionId: journal.transactionId,
    planDigest: journal.planDigest,
    canonicalPlan,
    planSummary: {
      apiVersion: canonicalPlan.apiVersion,
      operation: canonicalPlan.operation,
    },
    oldManifest,
    newManifest,
    state: journal.state,
    transitions: journal.transitions.map((transition) => ({ ...transition })),
    entries,
    createdAt: journal.createdAt,
    // The receipt replaces the full journal atomically; updatedAt records
    // the convergence instant (the full chain's own timestamps are preserved
    // verbatim in `transitions`).
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Remove recovery residue a terminal record no longer needs: the
 * `RECOVERY_REQUIRED` marker and the `backups/` directory (backups are named
 * `<entryIndex>.bak`). Called ONLY after the receipt has atomically and
 * durably replaced `journal.json` — the receipt is the authority first;
 * cleanup second.
 */
async function removeTerminalRecoveryResidue(txnHandle, journal) {
  const marker = await txnHandle.readEntry('RECOVERY_REQUIRED');
  if (!(marker === null || marker?.kind === 'absent')) {
    await txnHandle.unlink('RECOVERY_REQUIRED');
  }

  const backupsEntry = await txnHandle.readEntry('backups');
  if (backupsEntry === null || backupsEntry?.kind === 'absent') {
    await txnHandle.fsync();
    return;
  }

  const backupCount = Math.max(journal.newManifest.length, journal.entries.length);
  const backupsHandle = await txnHandle.openDir('backups');
  try {
    for (let i = 0; i < backupCount; i += 1) {
      const name = `${i}.bak`;
      const bak = await backupsHandle.readEntry(name);
      if (!(bak === null || bak?.kind === 'absent')) {
        await backupsHandle.unlink(name);
      }
    }
  } finally {
    await backupsHandle.close();
  }
  await txnHandle.rmdir('backups');
  await txnHandle.fsync();
}

/**
 * Converge a terminal (COMMITTED / ROLLED_BACK) transaction record to the
 * explicitly versioned small receipt (AC-1 terminal bounding) — a
 * POST-TERMINAL phase that preserves the durable ordering:
 *
 *   full terminal journal durable
 *     -> 'before-terminal-receipt-write' (fault point)
 *     -> receipt atomically replaces journal.json (writeJsonViaHandle:
 *        createTemp + fsync + rename + fsync)
 *     -> 'after-terminal-receipt-write' (fault point)
 *     -> backups/*.bak and RECOVERY_REQUIRED marker removed.
 *
 * Crash consistency (AC-2): a hard crash (INJECTED_CRASH) at either fault
 * point propagates verbatim and leaves the latest durable state untouched —
 * either the complete verifiable full journal (pre-receipt) or the complete
 * verifiable small receipt (post-receipt); both re-read COMMITTED /
 * ROLLED_BACK, never RECOVERY_REQUIRED / ROLLING_BACK.
 *
 * Honesty (AC-2): an ordinary failure (e.g. EIO) is wrapped as
 * TRANSACTION_INCOMPLETE with `terminalReceiptPersisted`,
 * `targetApplied` (true for COMMITTED — the target WAS applied+verified and
 * the complete verifiable full journal is retained at its latest durable
 * state; convergence never rewrites COMMITTED back), `transactionId`, and
 * `recover` guidance. Re-running convergence completes the record.
 *
 * @param {object} options
 * @param {object} options.txnHandle — DirectoryHandle for the transaction dir.
 * @param {string} options.transactionId — transaction ID.
 * @param {Function} [options.faultInjector] — fault injection for testing.
 * @param {string} [options.recoverCommand] — caller-supplied recover command.
 * @returns {Promise<object>} The validated receipt (or the journal unchanged
 *   if the record is not terminal).
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE on convergence failure.
 */
export async function convergeTerminalRecord({
  txnHandle,
  transactionId,
  faultInjector,
  recoverCommand,
} = {}) {
  const journal = await readJournal(txnHandle, transactionId);
  if (!PRUNABLE_TERMINAL_STATES.has(journal.state)) {
    // Non-terminal records keep the FULL recovery authority — never converge.
    return journal;
  }

  const recover = typeof recoverCommand === 'string' && recoverCommand.length > 0
    ? recoverCommand
    : `release-skill artifacts recover --transaction ${transactionId}`;
  let receiptPersisted = false;
  try {
    if (faultInjector) await faultInjector('before-terminal-receipt-write');

    const receipt = buildTerminalReceipt(journal);
    // Fail closed on an invalid or oversized receipt BEFORE the atomic
    // replace: the full journal must remain untouched in that case.
    validateTerminalReceiptSchema(receipt);
    if (receipt.transactionId !== transactionId) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        'terminal receipt transactionId does not match its directory authority',
      );
    }
    const serializedLength = Buffer.byteLength(JSON.stringify(receipt, null, 2), 'utf8');
    if (serializedLength > TERMINAL_RECEIPT_SIZE_CAP) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `terminal receipt exceeds the fixed size cap: ${serializedLength} > ${TERMINAL_RECEIPT_SIZE_CAP}`,
        { serializedLength, cap: TERMINAL_RECEIPT_SIZE_CAP },
      );
    }

    await writeJsonViaHandle(txnHandle, 'journal.json', receipt);
    receiptPersisted = true;

    if (faultInjector) await faultInjector('after-terminal-receipt-write');

    await removeTerminalRecoveryResidue(txnHandle, journal);
    return receipt;
  } catch (error) {
    // Hard-crash semantics: the recovery protocol must not rewrite the last
    // durable state; propagate the injected crash verbatim.
    if (error?.code === 'INJECTED_CRASH' || error?.name === 'InjectedCrash') {
      throw error;
    }
    const wrapped = new ReleaseError(
      TRANSACTION_INCOMPLETE,
      `terminal receipt convergence failed after the transaction reached ${journal.state}: `
      + (receiptPersisted
        ? 'the small terminal receipt is durable but residue cleanup did not complete'
        : 'the complete verifiable journal is retained on disk at its latest durable state')
      + `. ${recover}`,
      {
        transactionId,
        terminalReceiptPersisted: receiptPersisted,
        // COMMITTED means the target WAS applied and verified before
        // convergence; convergence failure must never lie about that.
        targetApplied: journal.state === 'COMMITTED',
        recover,
        phase: receiptPersisted ? 'terminal-residue-cleanup' : 'terminal-receipt-write',
        cause: error?.code || null,
        causeMessage: error?.message || null,
      },
    );
    // Marker for the transaction coordinator: this failure must bypass the
    // RECOVERY_REQUIRED protocol (the durable state is already terminal and
    // verifiable; re-running convergence completes the record).
    wrapped.terminalReceiptConvergenceFailed = true;
    wrapped.transactionId = transactionId;
    throw wrapped;
  }
}

// ---------------------------------------------------------------------------
// Retention (terminal-record pruning)
// ---------------------------------------------------------------------------

/**
 * Prune the oldest TERMINAL transaction records beyond a retention cap.
 *
 * Maintenance path — deliberately tolerant and best-effort. Transaction
 * journals are written exclusively through the safe-fs DirectoryHandle, but
 * that handle exposes neither directory enumeration nor recursive removal,
 * which retention needs. This helper therefore uses best-effort `node:fs`
 * operations scoped strictly to the current process's transactions root, and
 * it NEVER throws: a retention failure must not abort or roll back a
 * transaction (see the module docstring for the documented exception).
 *
 * Safety rules (all enforced below):
 *  - Only directory entries named `txn-*` are ever considered.
 *  - A record is prunable only if its `journal.json` parses AND its `state`
 *    is a member of PRUNABLE_TERMINAL_STATES (COMMITTED / ROLLED_BACK).
 *    Both durable terminal shapes parse here: the full journal and the
 *    converged terminal receipt — both keep `state` and `createdAt`
 *    (receipts additionally carry `terminalReceiptVersion`, which this
 *    tolerant scan ignores).
 *  - Unreadable, corrupt, or journal-less records are treated as
 *    NON-terminal and always kept, so recovery evidence is never destroyed.
 *  - Non-terminal states are never counted against the cap and never pruned.
 *  - Removal is oldest-first by journal `createdAt` (directory mtime
 *    fallback; unknown age sorts last so it is pruned last).
 *  - Fast path: if the total `txn-*` record count is within the cap, the
 *    helper returns after a single directory read without opening any
 *    journal.json (which can be MB-sized), since nothing can need pruning.
 *
 * @param {string} transactionsRoot — absolute path to the transactions dir.
 * @param {object} [options]
 * @param {number} [options.retentionMax=DEFAULT_TRANSACTION_RETENTION_MAX]
 *   Non-negative integer cap on retained terminal records.
 * @returns {Promise<{considered:number, terminal:number, pruned:string[], errors:string[]}>}
 *   Best-effort summary; `errors` collects per-record failures (never thrown).
 */
export async function pruneTerminalTransactionRecords(transactionsRoot, {
  retentionMax = DEFAULT_TRANSACTION_RETENTION_MAX,
} = {}) {
  const summary = { considered: 0, terminal: 0, pruned: [], errors: [] };
  try {
    if (typeof transactionsRoot !== 'string' || transactionsRoot.length === 0) return summary;
    if (!Number.isInteger(retentionMax) || retentionMax < 0) return summary;

    let entries;
    try {
      entries = await readdir(transactionsRoot, { withFileTypes: true });
    } catch (scanErr) {
      // Missing or unreadable transactions root => nothing to prune.
      summary.errors.push(`scan: ${scanErr?.code || scanErr?.message || 'readdir-failed'}`);
      return summary;
    }

    // Consider only transaction-record directories.
    const txnDirs = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('txn-'));
    summary.considered = txnDirs.length;

    // Fast path: terminal records are a subset of all records, so if the total
    // record count is already within the cap, nothing can need pruning. Skip
    // reading any journal.json (non-terminal recovery records can still be
    // MB-sized; converged terminal records are bounded receipts) in the common
    // below-cap case; only pay the per-record read cost once accumulation
    // exceeds the cap.
    if (txnDirs.length <= retentionMax) return summary;

    const terminal = [];
    for (const entry of txnDirs) {
      const recordDir = join(transactionsRoot, entry.name);

      let state = null;
      let createdAt = null;
      try {
        const raw = await readFile(join(recordDir, 'journal.json'), 'utf8');
        const journal = JSON.parse(raw);
        if (journal && typeof journal === 'object') {
          state = typeof journal.state === 'string' ? journal.state : null;
          createdAt = typeof journal.createdAt === 'string' ? journal.createdAt : null;
        }
      } catch {
        // Unreadable/corrupt journal => keep (never prune ambiguous records).
        state = null;
      }
      if (!PRUNABLE_TERMINAL_STATES.has(state)) continue;

      let sortTime = Date.parse(createdAt);
      if (!Number.isFinite(sortTime)) {
        try {
          const dirStat = await stat(recordDir);
          sortTime = dirStat.mtimeMs;
        } catch {
          sortTime = Number.MAX_SAFE_INTEGER; // unknown age => prune last
        }
      }
      summary.terminal += 1;
      terminal.push({ name: entry.name, dir: recordDir, sortTime });
    }

    if (terminal.length <= retentionMax) return summary;

    terminal.sort((a, b) => (a.sortTime - b.sortTime) || (a.name < b.name ? -1 : 1));
    const excess = terminal.length - retentionMax;
    for (let i = 0; i < excess; i += 1) {
      const victim = terminal[i];
      try {
        await rm(victim.dir, { recursive: true, force: true, maxRetries: 0 });
        summary.pruned.push(victim.name);
      } catch (rmErr) {
        summary.errors.push(`${victim.name}: ${rmErr?.code || rmErr?.message || 'rm-failed'}`);
      }
    }
  } catch (err) {
    summary.errors.push(`retention: ${err?.code || err?.message || 'unexpected'}`);
  }
  return summary;
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
 * @param {object} options.rootHandle — open safe-fs handle for the repo root.
 * @param {string} [options.root] — repository root path. When provided, the
 *   retention policy prunes the oldest terminal records beyond the cap before
 *   the new record is created. Omit to skip retention (rootHandle-only path).
 * @param {string} options.transactionId — unique transaction ID.
 * @param {string} options.planDigest — canonical plan digest.
 * @param {object} options.canonicalPlan — decoded plan (with Buffer bytes).
 * @param {object[]} options.oldManifest — snapshot of old entries with
 *   backup bytes (for absent entries, `absent: true`).
 * @param {object[]} options.newManifest — snapshot of new entries.
 * @param {number} [options.retentionMax] — override the retention cap
 *   (defaults to DEFAULT_TRANSACTION_RETENTION_MAX).
 * @returns {Promise<{ journal: object, txnHandle: object }>}
 */
export async function createTransactionJournal({
  rootHandle,
  root,
  transactionId,
  planDigest,
  canonicalPlan,
  oldManifest,
  newManifest,
  retentionMax,
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

  // Retention: prune the oldest terminal records beyond the cap before creating
  // the new record. Best-effort — never blocks journal creation (see
  // pruneTerminalTransactionRecords). Operates only on this root's
  // `.release-skill/transactions`; skipped when `root` is not provided.
  if (typeof root === 'string' && root.length > 0) {
    await pruneTerminalTransactionRecords(
      join(root, '.release-skill', 'transactions'),
      { retentionMax },
    );
  }

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
 * Accepts both durable shapes: the full journal (recovery authority for
 * non-terminal states, and the pre-convergence record of a terminal state
 * left behind by a crash/IO failure at 'before-terminal-receipt-write') and
 * the explicitly versioned terminal receipt for converged COMMITTED /
 * ROLLED_BACK records. Terminal records are returned as validated receipts.
 *
 * @param {object} txnHandle — DirectoryHandle for the transaction directory.
 * @param {string} transactionId — for error context.
 * @returns {Promise<object>} Validated journal data (full journal or receipt).
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
 * When the transition lands a PRUNABLE_TERMINAL state (COMMITTED /
 * ROLLED_BACK) and `convergeTerminal` is not false, the record is converged
 * to the explicitly versioned terminal receipt after the transition journal
 * is durable (see convergeTerminalRecord). Callers that run their own
 * convergence phase with their own fault-point ordering (the
 * applyWriteSetUnderLock 'after-committed' durable point) pass
 * `convergeTerminal: false`.
 *
 * @param {object} options
 * @param {object} options.txnHandle — DirectoryHandle.
 * @param {string} options.transactionId — for error context.
 * @param {string|null} options.from — expected current state (null = skip
 *   check for initial write).
 * @param {string} options.to — target state.
 * @param {number} [options.entryIndex] — entry index for write-ahead.
 * @param {Function} [options.faultInjector] — fault injection forwarded to
 *   terminal convergence ('before-terminal-receipt-write' /
 *   'after-terminal-receipt-write').
 * @param {boolean} [options.convergeTerminal=true] — set false to defer
 *   terminal convergence to the caller.
 * @returns {Promise<object>} Updated journal — the validated terminal
 *   receipt when the transition landed a terminal state and convergence ran.
 * @throws {ReleaseError} INVALID_STATE_TRANSITION on invalid transition.
 */
export async function writeJournalTransition({
  txnHandle,
  transactionId,
  from,
  to,
  entryIndex,
  faultInjector,
  convergeTerminal = true,
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

  if (convergeTerminal && PRUNABLE_TERMINAL_STATES.has(journal.state)) {
    return await convergeTerminalRecord({ txnHandle, transactionId, faultInjector });
  }

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
