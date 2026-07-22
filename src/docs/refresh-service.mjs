/**
 * Release-document refresh service: the two-phase local closed loop
 * (2026-07-21-release-docs-command-and-prepare-gate §2/§3,
 * 2026-07-21-release-docs-refresh-protocol).
 *
 * `planReleaseDocsRefreshForUnit({ root, config, unit, version,
 * backendFactory })` is the shared read-only planning primitive (used by the
 * prepare freshness gate and by this service): it selects the unit's
 * releaseDocuments block, reads the notes source through
 * `loadReleaseNotesSource`, reads EVERY configured target through the
 * exported `readSafeFileThroughHandles` safe-read primitive (root handle,
 * per-segment openat/O_NOFOLLOW, regular file, nlink === 1, size cap, stable
 * identity — no absolute-path fs fallback; fail closed when the backend is
 * unavailable), captures the permission mode of each target from the same
 * stable readFile, and returns the deeply frozen `{ plan, display, modes }`
 * triple. It performs ZERO workspace/control-plane writes: no `.release-skill`
 * directory, no lock, no plan file, no journal, no probe.
 *
 * `runReleaseDocsRefresh({ root, unitId, write, confirmRefresh,
 * ackLocalDocumentWrite, explicitVersion, backendFactory, faultInjector,
 * clock })`:
 * - dry-run (write falsy): selects the unique unit from `loadProjectConfig`
 *   (UNIT_NOT_FOUND / UNIT_DUPLICATE fail closed), resolves the authoritative
 *   version from `unit.version.source` (an explicitVersion is only a
 *   consistency assertion — mismatch fails closed with GATE_FAILED), and
 *   returns the safe display projection. Zero writes.
 * - write (write === true): requires ALL THREE authorizations — `write`,
 *   an exact `confirmRefresh` digest match, and
 *   `ackLocalDocumentWrite === true` — validated before ANY I/O. Under the
 *   exclusive project lock it reloads config/version/notes/targets and
 *   re-plans; a diverging refreshDigest converges to RELEASE_DOCS_REFRESH_STALE
 *   with zero target writes; a clean plan is a zero-write no-op. Otherwise it
 *   commits every changed target through the generic
 *   `applyWriteSetUnderLock` transaction core (multi-file preflight CAS
 *   before the first write, per-entry re-CAS, durable journal/backup,
 *   RECOVERY_REQUIRED recovery with the unique recover command), then
 *   re-plans read-only under the lock and requires `clean`. A mid-flight
 *   failure restores the exact old bytes under the still-held lock (the
 *   journal stays RECOVERY_REQUIRED and the unique recover command remains
 *   authoritative).
 *
 * All user-visible output carries canonical relative paths only: never
 * `/Users/...`, never note/old body text, never credentials, never full
 * diffs, never serialized buffers.
 *
 * @module src/docs/refresh-service
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

import { loadSafeFs } from '../artifacts/safe-fs.mjs';
import { acquireProjectLock } from '../artifacts/project-lock.mjs';
import { applyWriteSetUnderLock } from '../artifacts/transaction.mjs';
import { loadProjectConfig } from '../core/config.mjs';
import {
  ReleaseError,
  MISSING_PARAMETERS,
  PATH_UNSAFE,
  RELEASE_DOCS_INVALID,
  RELEASE_DOCS_REFRESH_STALE,
  TRANSACTION_INCOMPLETE,
} from '../core/errors.mjs';
import { resolveUnitVersion } from '../commands/prepare.mjs';

import { normalizeReleaseDocumentsConfig } from './config.mjs';
import { loadReleaseNotesSource, readSafeFileThroughHandles } from './notes-loader.mjs';
import { DEFAULT_MAX_NOTES_BYTES } from './notes.mjs';
import {
  createReleaseDocsRefreshPlan,
  projectReleaseDocsRefreshDisplay,
} from './refresh-planner.mjs';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/**
 * Deeply freeze a plain object/array structure. Typed arrays (Buffer) are
 * skipped: the JS specification forbids freezing non-empty ArrayBuffer
 * views; byte buffers stay immutable by always being fresh copies.
 */
function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === 'object') {
    if (ArrayBuffer.isView(value)) return value;
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

/**
 * Render a permission mode captured by a stable readFile (a number such as
 * 0o644 === 420) as the six-digit octal string the transaction entry schema
 * expects ('000644'); the last three digits drive CAS and journal checks.
 */
function modeToString(mode) {
  if (typeof mode === 'string' && mode.length > 0) return mode;
  if (Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o777) {
    return mode.toString(8).padStart(6, '0');
  }
  return '000644';
}

/**
 * Select the unique release unit by id from the loaded project config.
 * Unknown and duplicated ids fail closed with precise stable errors.
 */
function selectUnit(config, unitId) {
  const units = Array.isArray(config?.releaseUnits) ? config.releaseUnits : [];
  const matches = units.filter((unit) => unit?.id === unitId);
  if (matches.length === 0) {
    throw new ReleaseError(
      RELEASE_DOCS_INVALID,
      `release unit "${unitId}" was not found in the project configuration`,
      { reason: 'UNIT_NOT_FOUND', unitId, available: units.map((unit) => unit?.id) },
    );
  }
  if (matches.length > 1) {
    throw new ReleaseError(
      RELEASE_DOCS_INVALID,
      `release unit "${unitId}" is declared more than once in the project configuration`,
      { reason: 'UNIT_DUPLICATE', unitId },
    );
  }
  return matches[0];
}

// ---------------------------------------------------------------------------
// Read-only planning primitive (shared by the service and the prepare gate)
// ---------------------------------------------------------------------------

/**
 * Plan the release-document refresh for one release unit, read-only.
 *
 * Reads the notes source and every configured target exclusively through
 * the safe-fs backend handle API; performs ZERO workspace or control-plane
 * writes (no `.release-skill`, no lock, no plan file, no journal, no probe).
 *
 * @param {object} options
 * @param {string} options.root — Absolute project root.
 * @param {object} [options.config] — Loaded project config (reserved for
 *   gate/service context; the unit object below is authoritative).
 * @param {object} options.unit — Release unit object from config.releaseUnits.
 * @param {string} options.version — Already-resolved authoritative version.
 * @param {() => Promise<object>} [options.backendFactory] — Safe-fs backend
 *   factory (default loadSafeFs); fail closed when unavailable.
 * @returns {Promise<Readonly<{ plan: object, display: object, modes: Map<string, number> }>>}
 *   Deeply frozen triple; `modes` maps canonical target paths to the
 *   permission mode captured by the same stable readFile (write-phase
 *   internal only — never part of the display projection).
 * @throws {ReleaseError} RELEASE_DOCS_INVALID (unit/config/semantic),
 *   PATH_UNSAFE (path/race), SAFE_WRITE_UNAVAILABLE (backend), plus
 *   STRUCTURE_INVALID / RELEASE_DOCS_CONFLICT / RELEASE_DOCS_TRANSLATION_MISSING
 *   propagated from the renderers/parser.
 */
export async function planReleaseDocsRefreshForUnit({
  root,
  config,
  unit,
  version,
  backendFactory,
} = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new ReleaseError(RELEASE_DOCS_INVALID, 'root must be a non-empty string', {
      reason: 'INVALID_OPTIONS',
      field: 'root',
    });
  }
  if (!unit || typeof unit !== 'object' || Array.isArray(unit)) {
    throw new ReleaseError(RELEASE_DOCS_INVALID, 'unit must be a release unit object', {
      reason: 'INVALID_OPTIONS',
      field: 'unit',
    });
  }
  if (typeof unit.id !== 'string' || unit.id.length === 0) {
    throw new ReleaseError(RELEASE_DOCS_INVALID, 'unit.id must be a non-empty string', {
      reason: 'INVALID_OPTIONS',
      field: 'unit.id',
    });
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new ReleaseError(RELEASE_DOCS_INVALID, 'version must be a non-empty string', {
      reason: 'INVALID_OPTIONS',
      field: 'version',
    });
  }
  if (unit.releaseDocuments === undefined || unit.releaseDocuments === null) {
    throw new ReleaseError(
      RELEASE_DOCS_INVALID,
      `release unit "${unit.id}" does not configure releaseDocuments`,
      { reason: 'RELEASE_DOCUMENTS_NOT_CONFIGURED', unitId: unit.id },
    );
  }
  if (typeof unit.source !== 'string' || unit.source.length === 0) {
    throw new ReleaseError(RELEASE_DOCS_INVALID, 'unit.source must be a non-empty string', {
      reason: 'INVALID_OPTIONS',
      field: 'unit.source',
    });
  }

  const unitRoot = resolve(root, unit.source);

  // One backend instance per planning pass; fail closed when unavailable —
  // there is no absolute-path fallback.
  const backend = await (backendFactory ?? loadSafeFs)();
  const sharedFactory = async () => backend;

  // 1. Structured notes source through the existing safe loader.
  const notesSource = await loadReleaseNotesSource({
    unitRoot,
    config: unit.releaseDocuments,
    version,
    backendFactory: sharedFactory,
  });

  // 2. Closed semantic normalization, then every target through the same
  //    safe-read primitive (regular file, nlink === 1, size cap, identity).
  const normalized = normalizeReleaseDocumentsConfig(unit.releaseDocuments);
  const targets = [
    ...normalized.changelogs.map((entry) => ({ path: entry.path, kind: 'changelog', locale: entry.locale })),
    ...normalized.readmes.map((entry) => ({ path: entry.path, kind: 'readme', locale: entry.locale })),
  ];

  const oldFiles = [];
  const modes = new Map();
  for (const target of targets) {
    const read = await readSafeFileThroughHandles(
      backend,
      unitRoot,
      target.path,
      DEFAULT_MAX_NOTES_BYTES,
      undefined,
      'release document target',
    );
    oldFiles.push({
      path: target.path,
      kind: target.kind,
      locale: target.locale,
      bytes: read.bytes,
    });
    modes.set(target.path, read.mode);
  }

  // 3. Pure deterministic planning + safe display projection.
  const plan = createReleaseDocsRefreshPlan({
    unitId: unit.id,
    version,
    config: normalized,
    notes: notesSource.notes,
    notesSourceDigest: notesSource.bytesDigest,
    oldFiles,
  });
  const display = projectReleaseDocsRefreshDisplay(plan);

  return deepFreeze({ plan, display, modes });
}

// ---------------------------------------------------------------------------
// Mid-flight failure: restore the exact old bytes under the held lock
// ---------------------------------------------------------------------------

/**
 * Restore one target to its exact old bytes through the safe-fs backend
 * handle API (stable read → identity-bound createTemp+rename → fsync).
 * Fails closed; handles are closed in reverse order.
 */
async function restoreOneTarget(backend, unitRoot, file, mode) {
  const segments = file.path.split('/');
  const handleStack = [];
  let primaryError = null;

  try {
    handleStack.push(await backend.openRoot(unitRoot));
    for (let i = 0; i < segments.length - 1; i += 1) {
      handleStack.push(await handleStack[handleStack.length - 1].openDir(segments[i]));
    }
    const parent = handleStack[handleStack.length - 1];
    const leaf = segments[segments.length - 1];

    // Stable read of the current state: its identity authorizes the
    // identity-bound rename (and tells us whether a write is needed at all).
    const current = await parent.readFile(leaf);
    const oldBytes = Buffer.from(file.oldBytes);
    const alreadyOld = current !== null
      && current !== undefined
      && Buffer.isBuffer(current.bytes)
      && current.bytes.equals(oldBytes);

    if (!alreadyOld) {
      const writeMode = Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o777 ? mode : 0o644;
      const token = await parent.createTemp(leaf, writeMode, oldBytes);
      try {
        await parent.rename(token, leaf, current ?? undefined);
      } catch (renameError) {
        try {
          await parent.abortTemp(token);
        } catch {
          // Best effort: the primary rename error is authoritative.
        }
        throw renameError;
      }
      await parent.fsync();
    }
  } catch (err) {
    primaryError = err;
  }

  const closeFailures = [];
  for (let i = handleStack.length - 1; i >= 0; i -= 1) {
    try {
      await handleStack[i].close();
    } catch (closeErr) {
      closeFailures.push(closeErr?.code ?? 'CLOSE_FAILED');
    }
  }
  if (primaryError) throw primaryError;
  if (closeFailures.length > 0) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'release document restore handle close failed',
      { closeFailures },
    );
  }
}

/**
 * Restore every changed target to its exact old bytes under the still-held
 * project lock after a mid-flight transaction failure. Returns true only
 * when every target is back at its old bytes; any failure resolves false so
 * the caller surfaces the original RECOVERY_REQUIRED error unchanged.
 */
async function tryRestoreOldBytes(backend, unitRoot, changedFiles, modes) {
  try {
    for (const file of changedFiles) {
      await restoreOneTarget(backend, unitRoot, file, modes.get(file.path));
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public command entry: dry-run projection and authorized atomic write
// ---------------------------------------------------------------------------

/**
 * Run the two-phase release-document refresh for one release unit.
 *
 * Dry-run (write falsy): read-only, zero workspace/control-plane writes,
 * returns the safe display projection plus the authoritative version.
 *
 * Write (write === true): requires the exact `confirmRefresh` digest AND
 * `ackLocalDocumentWrite === true` (validated before any I/O); re-plans
 * everything under the exclusive project lock; commits changed targets
 * through the durable transaction core; re-plans read-only afterwards and
 * requires a clean result.
 *
 * @param {object} options
 * @param {string} options.root — Absolute project root.
 * @param {string} options.unitId — Release unit identifier.
 * @param {boolean} [options.write] — Explicit write authorization.
 * @param {string} [options.confirmRefresh] — Exact dry-run refreshDigest.
 * @param {boolean} [options.ackLocalDocumentWrite] — Explicit local document
 *   write acknowledgement.
 * @param {string} [options.explicitVersion] — Consistency assertion only;
 *   never overrides `unit.version.source`.
 * @param {() => Promise<object>} [options.backendFactory] — Safe-fs backend
 *   factory (default loadSafeFs).
 * @param {Function} [options.faultInjector] — Test-only fault injection for
 *   the transaction core.
 * @param {Function} [options.clock] — Test-only clock.
 * @returns {Promise<object>} Frozen dry-run/write/clean result.
 * @throws {ReleaseError} MISSING_PARAMETERS (24), RELEASE_DOCS_INVALID (42),
 *   RELEASE_DOCS_REFRESH_STALE (45), GATE_FAILED (13), PATH_UNSAFE (28),
 *   SAFE_WRITE_UNAVAILABLE (39), PLAN_STALE (36), TRANSACTION_INCOMPLETE (38).
 */
export async function runReleaseDocsRefresh({
  root,
  unitId,
  write = false,
  confirmRefresh,
  ackLocalDocumentWrite = false,
  explicitVersion,
  backendFactory,
  faultInjector,
  clock,
} = {}) {
  // 1. Parameters precede everything.
  if (typeof root !== 'string' || root.length === 0) {
    throw new ReleaseError(MISSING_PARAMETERS, 'root is required', { field: 'root' });
  }
  if (typeof unitId !== 'string' || unitId.length === 0) {
    throw new ReleaseError(MISSING_PARAMETERS, 'unitId is required', { field: 'unitId' });
  }

  // 2. Write authorization precedes ALL I/O (defense in depth: the CLI
  //    validates the same three-way binding before invoking the service).
  if (write) {
    const missing = [];
    if (typeof confirmRefresh !== 'string' || confirmRefresh.length === 0) {
      missing.push('confirmRefresh');
    }
    if (ackLocalDocumentWrite !== true) {
      missing.push('ackLocalDocumentWrite');
    }
    if (missing.length > 0) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        'docs refresh --write requires the exact confirmRefresh digest and an explicit local document write acknowledgement',
        { reason: 'MISSING_WRITE_PARAMETERS', missing },
      );
    }
  }

  // 3. One backend instance per invocation; fail closed when unavailable.
  const backend = await (backendFactory ?? loadSafeFs)();
  const sharedFactory = async () => backend;

  // -----------------------------------------------------------------
  // DRY-RUN — read-only, zero writes
  // -----------------------------------------------------------------
  if (!write) {
    const { config } = await loadProjectConfig({ root });
    const unit = selectUnit(config, unitId);
    const version = await resolveUnitVersion(unit, root, explicitVersion);
    const { display } = await planReleaseDocsRefreshForUnit({
      root,
      config,
      unit,
      version,
      backendFactory: sharedFactory,
    });

    const result = {
      command: 'docs-refresh',
      mode: 'dry-run',
      status: display.status,
      unitId,
      locales: [...display.locales],
      inputDigest: display.inputDigest,
      refreshDigest: display.refreshDigest,
      files: display.files,
      nextCommand: display.nextCommand,
    };
    // The authoritative version is exposed to callers but kept off the
    // enumerable projection surface; the CLI re-adds it to its JSON shape.
    Object.defineProperty(result, 'version', {
      value: version,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return Object.freeze(result);
  }

  // -----------------------------------------------------------------
  // WRITE — exclusive lock, under-lock re-plan, transactional commit
  // -----------------------------------------------------------------
  // The project lock keeps its own wall-clock owner timestamps (its clock
  // contract requires ISO-8601); the injected test clock is reserved for the
  // deterministic transaction-id generation inside the transaction core.
  const lock = await acquireProjectLock({
    root,
    command: 'docs refresh',
    mode: 'exclusive',
  });

  let result;
  let primaryError;
  try {
    result = await lock.capture(async () => {
      // Reload everything under the exclusive lock and re-plan from
      // scratch: config, authoritative version, notes source, all targets.
      const { config } = await loadProjectConfig({ root });
      const unit = selectUnit(config, unitId);
      const version = await resolveUnitVersion(unit, root, explicitVersion);
      const { plan, modes } = await planReleaseDocsRefreshForUnit({
        root,
        config,
        unit,
        version,
        backendFactory: sharedFactory,
      });

      // Exact refreshDigest confirmation. ANY concurrent change (config,
      // notes source, version, or any target) changes the digest and
      // converges here with ZERO target writes.
      if (plan.refreshDigest !== confirmRefresh) {
        throw new ReleaseError(
          RELEASE_DOCS_REFRESH_STALE,
          `release documents for unit "${unitId}" changed since the confirmed dry-run`,
          {
            unitId,
            version,
            expected: confirmRefresh,
            actual: plan.refreshDigest,
          },
        );
      }

      // Clean plans are a zero-write no-op even in write mode (no
      // transaction, no journal).
      if (plan.status === 'clean') {
        return Object.freeze({
          command: 'docs-refresh',
          mode: 'write',
          status: 'clean',
          refreshed: false,
          unitId,
          version,
          refreshDigest: plan.refreshDigest,
        });
      }

      // Build the write set (changed targets only; canonical path order)
      // and the closed docs-refresh v1 canonical plan (no bytes, no
      // absolute paths) persisted as the journal authority.
      //
      // The transaction core resolves write-set paths against the project
      // root (where the durable journal lives), while planning, target
      // reads/restores, and every user-facing projection stay unit-relative.
      // Prefix each unit-relative target path with the unit's canonical
      // project-relative location ('' when the unit sits at the root).
      const changedFiles = plan.files.filter((file) => file.changed);
      const unitRoot = resolve(root, unit.source);
      const unitLocation = relative(root, unitRoot);
      if (unitLocation === '..'
          || unitLocation.startsWith(`..${sep}`)
          || isAbsolute(unitLocation)) {
        throw new ReleaseError(
          PATH_UNSAFE,
          'release unit source escapes the project root',
          { reason: 'UNIT_SOURCE_ESCAPE', unitId },
        );
      }
      const unitPrefix = unitLocation === ''
        ? ''
        : `${unitLocation.split(sep).join('/')}/`;
      const projectPath = (targetPath) => `${unitPrefix}${targetPath}`;
      const writeSet = changedFiles.map((file) => ({
        id: `${file.kind}:${projectPath(file.path)}`,
        path: projectPath(file.path),
        oldEntry: {
          kind: 'regular',
          sha256: file.oldDigest,
          size: file.summary.oldSize,
          mode: modeToString(modes.get(file.path)),
        },
        newEntry: {
          kind: 'regular',
          bytes: Buffer.from(file.newBytes),
          sha256: file.newDigest,
          size: file.summary.newSize,
          mode: modeToString(modes.get(file.path)),
        },
      }));
      const canonicalPlan = {
        apiVersion: 'release-skill.dev/docs-refresh/v1',
        operation: 'refresh',
        unitId,
        version,
        refreshDigest: plan.refreshDigest,
        files: changedFiles.map((file) => ({
          id: `${file.kind}:${projectPath(file.path)}`,
          path: projectPath(file.path),
          kind: file.kind,
          locale: file.locale,
          oldDigest: file.oldDigest,
          newDigest: file.newDigest,
          change: file.change,
        })),
      };

      let applyResult;
      try {
        applyResult = await applyWriteSetUnderLock({
          root,
          writeSet,
          canonicalPlan,
          planDigest: plan.refreshDigest,
          safeFs: backend,
          faultInjector,
          clock,
          assertLockOwner: () => lock.assertOwner(),
        });
      } catch (err) {
        // Mid-flight failure: the transaction core has already entered the
        // durable RECOVERY_REQUIRED protocol (journal + marker + unique
        // recover command). Restore the exact old bytes under the
        // still-held lock so the workspace never keeps an undeclared
        // partial refresh; the journal state and the recover command
        // remain authoritative for reconciliation.
        if (err instanceof ReleaseError
            && err.code === TRANSACTION_INCOMPLETE
            && typeof err.details?.recover === 'string') {
          const restored = await tryRestoreOldBytes(
            backend,
            resolve(root, unit.source),
            changedFiles,
            modes,
          );
          if (restored) {
            const adjusted = new ReleaseError(TRANSACTION_INCOMPLETE, err.message, {
              ...err.details,
              targetUnchanged: true,
            });
            adjusted.transactionId = err.transactionId;
            throw adjusted;
          }
        }
        throw err;
      }

      // Post-write read-only re-plan under the lock: success requires a
      // clean plan (the freshly written bytes render to themselves).
      const { plan: recheckPlan } = await planReleaseDocsRefreshForUnit({
        root,
        config,
        unit,
        version,
        backendFactory: sharedFactory,
      });
      if (recheckPlan.status !== 'clean') {
        throw new ReleaseError(
          TRANSACTION_INCOMPLETE,
          'release documents are not clean after the transactional write',
          { reason: 'POST_WRITE_NOT_CLEAN', unitId, version },
        );
      }

      return Object.freeze({
        command: 'docs-refresh',
        mode: 'write',
        status: 'refreshed',
        refreshed: true,
        unitId,
        version,
        refreshDigest: plan.refreshDigest,
        transactionId: applyResult.transactionId,
        refreshedPaths: changedFiles.map((file) => file.path),
      });
    });
  } catch (error) {
    primaryError = error;
  }

  // Release the lock; mirror the artifact-apply combined-error pattern on
  // release failure — never swallow the business error.
  try {
    await lock.release();
  } catch (releaseError) {
    if (primaryError) {
      const combined = new ReleaseError(
        TRANSACTION_INCOMPLETE,
        'docs refresh failed and project lock release also failed',
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
