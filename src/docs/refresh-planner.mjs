/**
 * Deterministic pure planner for the two-phase release-document refresh
 * protocol (2026-07-21-release-docs-refresh-protocol §5,
 * 2026-07-21-release-docs-refresh-planner).
 *
 * `createReleaseDocsRefreshPlan({ unitId, version, config, notes,
 * notesSourceDigest, oldFiles })` maps the canonicalized
 * releaseDocuments configuration, canonical release notes, the notes-source
 * byte digest, the release unit identifier, the canonical version, and the
 * old bytes of every configured target to one deeply frozen plan. It
 * renders each candidate through the existing README and CHANGELOG
 * renderers; it never reads or writes files, never touches the network,
 * and never spawns subprocesses.
 *
 * Target matching is exact and fail closed: every configured changelog and
 * readme target must have exactly one input entry keyed by its canonical
 * path with a matching kind and locale; missing, duplicate, extra, or
 * kind/locale-mismatched entries fail closed with RELEASE_DOCS_INVALID.
 *
 * Digest binding contract:
 * - `inputDigest` (`sha256:<64hex>`) binds the canonical notes object and
 *   the original notes-source byte digest.
 * - `refreshDigest` (`sha256:<64hex>`) binds the protocol version, unitId,
 *   version, inputDigest, the canonical releaseDocuments configuration
 *   projection, and the sorted per-file path/kind/locale/oldDigest/
 *   newDigest/change. It never binds absolute paths, times, display text,
 *   candidate bodies, or input array order.
 *
 * The internal plan keeps share-protected copies of `oldBytes`/`newBytes`
 * for the later write phase; mutating caller-held input buffers after
 * planning cannot change plan candidates or digests.
 *
 * `projectReleaseDocsRefreshDisplay(plan)` derives the safe display
 * projection: it never carries candidate bytes, note body text, or
 * absolute paths, and it carries the exact `nextCommand.argv` string
 * arrays (dry-run always; the write arguments — `--write`,
 * `--confirm-refresh <refreshDigest>`, `--ack-local-document-write` —
 * only when the plan has changes; never on a clean plan). No shell string
 * is ever produced.
 *
 * Both the plan and the projection are deeply frozen; renderer failures
 * (STRUCTURE_INVALID, RELEASE_DOCS_CONFLICT, RELEASE_DOCS_TRANSLATION_MISSING)
 * propagate with their own stable codes, and malformed planner inputs fail
 * closed with RELEASE_DOCS_INVALID. Error details never carry note body
 * text, credentials, or absolute paths.
 *
 * @module src/docs/refresh-planner
 */

import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import { ReleaseError, RELEASE_DOCS_INVALID } from '../core/errors.mjs';
import { renderChangelogRelease } from './changelog-renderer.mjs';
import { renderReadmeRelease } from './readme-renderer.mjs';

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/** Protocol version bound into every refreshDigest. */
export const RELEASE_DOCS_REFRESH_PROTOCOL_VERSION = 1;

/** Canonical digest form used for every digest in the refresh protocol. */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Release unit identifier (mirrors the authoritative schema pattern). */
const UNIT_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Allowed target kinds, one per renderer. */
const KINDS = new Set(['changelog', 'readme']);

/** Allowed plan statuses. */
const STATUSES = new Set(['changes', 'clean']);

/** Allowed per-file change kinds (union of both renderers' vocabularies). */
const CHANGES = new Set(['insert', 'update', 'none']);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function invalid(message, details = {}) {
  throw new ReleaseError(RELEASE_DOCS_INVALID, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deeply freeze a plain object/array structure. Typed arrays (Buffer) are
 * skipped: the JS specification forbids freezing non-empty ArrayBuffer
 * views, so byte buffers are instead guaranteed immutable by always being
 * freshly composed copies that share no mutable state with inputs.
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

function assertDigest(value, field) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    invalid(`${field} must be a sha256:<64 lowercase hex> digest`, { field });
  }
}

/** Canonical byte-order comparison of two paths. */
function comparePaths(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------------------
// Input validation (fail closed; never mutate inputs)
// ---------------------------------------------------------------------------

/**
 * Validate the canonicalized releaseDocuments configuration shape and build
 * the exact target map keyed by canonical path. The config is expected to
 * come from normalizeReleaseDocumentsConfig; every semantic violation here
 * is a fail-closed RELEASE_DOCS_INVALID.
 *
 * @param {unknown} config
 * @returns {{ targets: Map<string, { kind: string, locale: string, target: object }>, locales: string[] }}
 */
function validateConfig(config) {
  if (!isPlainObject(config)) {
    invalid('releaseDocuments config must be an object', { field: 'config' });
  }
  if (typeof config.notesSource !== 'string' || config.notesSource.length === 0) {
    invalid('releaseDocuments config notesSource must be a non-empty string', {
      field: 'config.notesSource',
    });
  }
  if (!Array.isArray(config.locales) || config.locales.length === 0) {
    invalid('releaseDocuments config locales must be a non-empty array', { field: 'config.locales' });
  }
  for (const locale of config.locales) {
    if (typeof locale !== 'string' || locale.length === 0) {
      invalid('releaseDocuments config locale identifiers must be non-empty strings', {
        field: 'config.locales',
      });
    }
  }

  /** @type {Map<string, { kind: string, locale: string, target: object }>} */
  const targets = new Map();
  const register = (kind, target, where) => {
    if (!isPlainObject(target)) {
      invalid(`releaseDocuments ${kind} target must be an object`, { where });
    }
    if (typeof target.path !== 'string' || target.path.length === 0) {
      invalid(`releaseDocuments ${kind} target path must be a non-empty string`, { where });
    }
    if (typeof target.locale !== 'string' || target.locale.length === 0) {
      invalid(`releaseDocuments ${kind} target locale must be a non-empty string`, { where });
    }
    if (targets.has(target.path)) {
      invalid('releaseDocuments config has a duplicate target path', { where, path: target.path });
    }
    targets.set(target.path, { kind, locale: target.locale, target });
  };

  if (!Array.isArray(config.changelogs) || config.changelogs.length === 0) {
    invalid('releaseDocuments config changelogs must be a non-empty array', {
      field: 'config.changelogs',
    });
  }
  config.changelogs.forEach((target, index) =>
    register('changelog', target, `config.changelogs[${index}]`),
  );

  if (!Array.isArray(config.readmes) || config.readmes.length === 0) {
    invalid('releaseDocuments config readmes must be a non-empty array', {
      field: 'config.readmes',
    });
  }
  config.readmes.forEach((target, index) => {
    const where = `config.readmes[${index}]`;
    if (!Array.isArray(target.regions) || target.regions.length === 0) {
      invalid('releaseDocuments readme target regions must be a non-empty array', { where });
    }
    for (const region of target.regions) {
      if (typeof region !== 'string' || region.length === 0) {
        invalid('releaseDocuments readme region ids must be non-empty strings', { where });
      }
    }
    if ('versionMarkers' in target) {
      const { versionMarkers } = target;
      if (!Array.isArray(versionMarkers) || versionMarkers.length === 0) {
        invalid('releaseDocuments readme versionMarkers must be a non-empty array when present', {
          where,
        });
      }
      for (const marker of versionMarkers) {
        if (
          !isPlainObject(marker) ||
          typeof marker.id !== 'string' ||
          marker.id.length === 0 ||
          typeof marker.pattern !== 'string' ||
          marker.pattern.length === 0
        ) {
          invalid('releaseDocuments readme versionMarker must carry a non-empty id and pattern', {
            where,
          });
        }
      }
    }
    register('readme', target, where);
  });

  return { targets, locales: [...config.locales] };
}

/**
 * Validate the per-target old-byte inputs against the exact configured
 * target set: every entry must match one configured path with matching
 * kind and locale; duplicates, extras, and mismatches fail closed.
 *
 * @param {unknown} oldFiles
 * @param {Map<string, { kind: string, locale: string, target: object }>} targets
 * @returns {Map<string, Uint8Array>} old bytes keyed by canonical path
 */
function validateOldFiles(oldFiles, targets) {
  if (!Array.isArray(oldFiles)) {
    invalid('oldFiles must be an array of per-target inputs', { field: 'oldFiles' });
  }
  /** @type {Map<string, Uint8Array>} */
  const bytesByPath = new Map();
  oldFiles.forEach((entry, index) => {
    const where = `oldFiles[${index}]`;
    if (!isPlainObject(entry)) {
      invalid('oldFiles entries must be objects', { where });
    }
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      invalid('oldFiles entry path must be a non-empty string', { where });
    }
    if (typeof entry.kind !== 'string' || !KINDS.has(entry.kind)) {
      invalid('oldFiles entry kind must be "changelog" or "readme"', { where, kind: entry.kind });
    }
    if (typeof entry.locale !== 'string' || entry.locale.length === 0) {
      invalid('oldFiles entry locale must be a non-empty string', { where });
    }
    if (!(entry.bytes instanceof Uint8Array)) {
      invalid('oldFiles entry bytes must be a Uint8Array/Buffer', { where });
    }
    if (bytesByPath.has(entry.path)) {
      invalid('oldFiles contains a duplicate target path', { where, path: entry.path });
    }
    const expected = targets.get(entry.path);
    if (expected === undefined) {
      invalid('oldFiles contains a target that is not configured', { where, path: entry.path });
    }
    if (expected.kind !== entry.kind) {
      invalid('oldFiles entry kind does not match the configured target', {
        where,
        path: entry.path,
        expected: expected.kind,
        actual: entry.kind,
      });
    }
    if (expected.locale !== entry.locale) {
      invalid('oldFiles entry locale does not match the configured target', {
        where,
        path: entry.path,
        expected: expected.locale,
        actual: entry.locale,
      });
    }
    bytesByPath.set(entry.path, entry.bytes);
  });
  for (const path of targets.keys()) {
    if (!bytesByPath.has(path)) {
      invalid('oldFiles is missing an input for a configured target', {
        reason: 'MISSING_TARGET',
        path,
      });
    }
  }
  return bytesByPath;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Plan the release-document refresh for one release unit.
 *
 * Pure function: no file reads or writes, no network, no subprocesses.
 * Inputs are never mutated; the returned plan (including every array and
 * nested object) is deeply frozen, and the internal byte copies share no
 * mutable state with caller-held buffers.
 *
 * @param {object} input
 * @param {string} input.unitId  Release unit identifier.
 * @param {string} input.version  Canonical release version; must equal
 *   `notes.version`.
 * @param {object} input.config  Canonicalized releaseDocuments
 *   configuration as produced by normalizeReleaseDocumentsConfig.
 * @param {object} input.notes  Canonical release notes as produced by
 *   parseReleaseNotes ({ version, date, locales }).
 * @param {string} input.notesSourceDigest  `sha256:<64hex>` digest of the
 *   original notes-source bytes.
 * @param {Array<{ path: string, kind: 'changelog' | 'readme', locale: string, bytes: Uint8Array }>} input.oldFiles
 *   Old bytes for exactly the configured targets, keyed by canonical path.
 * @returns {Readonly<{
 *   status: 'changes' | 'clean',
 *   unitId: string,
 *   version: string,
 *   locales: readonly string[],
 *   inputDigest: string,
 *   refreshDigest: string,
 *   files: ReadonlyArray<{
 *     path: string,
 *     kind: 'changelog' | 'readme',
 *     locale: string,
 *     oldDigest: string,
 *     newDigest: string,
 *     change: 'insert' | 'update' | 'none',
 *     changed: boolean,
 *     summary: { oldSize: number, newSize: number, delta: number },
 *     oldBytes: Buffer,
 *     newBytes: Buffer,
 *   }>,
 * }>} deeply frozen plan; files are sorted by canonical path byte order
 * @throws {ReleaseError} RELEASE_DOCS_INVALID on malformed inputs
 *   (missing/duplicate/extra/mismatched targets, malformed digests,
 *   version drift); STRUCTURE_INVALID / RELEASE_DOCS_CONFLICT /
 *   RELEASE_DOCS_TRANSLATION_MISSING propagate from the renderers.
 */
export function createReleaseDocsRefreshPlan({
  unitId,
  version,
  config,
  notes,
  notesSourceDigest,
  oldFiles,
} = {}) {
  if (typeof unitId !== 'string' || !UNIT_ID_PATTERN.test(unitId)) {
    invalid('unitId must be a release unit identifier', { field: 'unitId' });
  }
  if (typeof version !== 'string' || version.length === 0) {
    invalid('version must be a non-empty string', { field: 'version' });
  }
  if (!isPlainObject(notes)) {
    invalid('release notes must be an object', { field: 'notes' });
  }
  if (typeof notes.version !== 'string' || notes.version !== version) {
    invalid('release notes version does not match the release version', {
      reason: 'VERSION_DRIFT',
      field: 'notes.version',
    });
  }
  assertDigest(notesSourceDigest, 'notesSourceDigest');

  const { targets, locales } = validateConfig(config);
  const bytesByPath = validateOldFiles(oldFiles, targets);

  // Render every target through the existing deterministic renderers.
  const files = [];
  for (const [path, entry] of targets) {
    const oldBytes = Buffer.from(bytesByPath.get(path));
    const rendered =
      entry.kind === 'changelog'
        ? renderChangelogRelease({ bytes: oldBytes, target: entry.target, notes })
        : renderReadmeRelease({ bytes: oldBytes, target: entry.target, notes });
    const newBytes = Buffer.from(rendered.bytes);
    const changed = !oldBytes.equals(newBytes);
    const change = entry.kind === 'changelog' ? rendered.change : changed ? 'update' : 'none';
    files.push({
      path,
      kind: entry.kind,
      locale: entry.locale,
      oldDigest: `sha256:${sha256Hex(oldBytes)}`,
      newDigest: `sha256:${sha256Hex(newBytes)}`,
      change,
      changed,
      summary: {
        oldSize: oldBytes.length,
        newSize: newBytes.length,
        delta: newBytes.length - oldBytes.length,
      },
      oldBytes,
      newBytes,
    });
  }
  files.sort((a, b) => comparePaths(a.path, b.path));

  const inputDigest = `sha256:${sha256Hex(canonicalJson({ notes, notesSourceDigest }))}`;
  const refreshDigest = `sha256:${sha256Hex(
    canonicalJson({
      protocolVersion: RELEASE_DOCS_REFRESH_PROTOCOL_VERSION,
      unitId,
      version,
      inputDigest,
      config,
      files: files.map((file) => ({
        path: file.path,
        kind: file.kind,
        locale: file.locale,
        oldDigest: file.oldDigest,
        newDigest: file.newDigest,
        change: file.change,
      })),
    }),
  )}`;

  const status = files.some((file) => file.changed) ? 'changes' : 'clean';
  return deepFreeze({ status, unitId, version, locales, inputDigest, refreshDigest, files });
}

/**
 * Project the safe, displayable view of a refresh plan.
 *
 * Pure function. The projection never carries candidate bytes, note body
 * text, or absolute paths, and it carries the exact `nextCommand.argv`
 * string arrays: the dry-run argv always; the write argv (dry-run argv
 * plus `--write`, `--confirm-refresh <refreshDigest>`, and
 * `--ack-local-document-write`) only when the plan has changes; `null`
 * (never a write suggestion) on a clean plan. No shell string is ever
 * produced.
 *
 * @param {object} plan  A plan produced by createReleaseDocsRefreshPlan.
 * @returns {Readonly<{
 *   status: 'changes' | 'clean',
 *   unitId: string,
 *   version: string,
 *   locales: readonly string[],
 *   inputDigest: string,
 *   refreshDigest: string,
 *   files: ReadonlyArray<{
 *     path: string,
 *     kind: 'changelog' | 'readme',
 *     locale: string,
 *     oldDigest: string,
 *     newDigest: string,
 *     change: 'insert' | 'update' | 'none',
 *     changed: boolean,
 *     summary: { oldSize: number, newSize: number, delta: number },
 *   }>,
 *   nextCommand: { argv: readonly string[], writeArgv: readonly string[] | null },
 * }>} deeply frozen display projection
 * @throws {ReleaseError} RELEASE_DOCS_INVALID on malformed plan shapes.
 */
export function projectReleaseDocsRefreshDisplay(plan) {
  if (!isPlainObject(plan)) {
    invalid('plan must be an object', { field: 'plan' });
  }
  if (typeof plan.status !== 'string' || !STATUSES.has(plan.status)) {
    invalid('plan status must be "changes" or "clean"', { field: 'plan.status' });
  }
  if (typeof plan.unitId !== 'string' || !UNIT_ID_PATTERN.test(plan.unitId)) {
    invalid('plan unitId must be a release unit identifier', { field: 'plan.unitId' });
  }
  if (typeof plan.version !== 'string' || plan.version.length === 0) {
    invalid('plan version must be a non-empty string', { field: 'plan.version' });
  }
  if (!Array.isArray(plan.locales)) {
    invalid('plan locales must be an array', { field: 'plan.locales' });
  }
  for (const locale of plan.locales) {
    if (typeof locale !== 'string' || locale.length === 0) {
      invalid('plan locale identifiers must be non-empty strings', { field: 'plan.locales' });
    }
  }
  assertDigest(plan.inputDigest, 'plan.inputDigest');
  assertDigest(plan.refreshDigest, 'plan.refreshDigest');
  if (!Array.isArray(plan.files)) {
    invalid('plan files must be an array', { field: 'plan.files' });
  }

  const files = plan.files.map((file, index) => {
    const where = `plan.files[${index}]`;
    if (!isPlainObject(file)) {
      invalid('plan file entries must be objects', { where });
    }
    if (typeof file.path !== 'string' || file.path.length === 0) {
      invalid('plan file path must be a non-empty string', { where });
    }
    if (typeof file.kind !== 'string' || !KINDS.has(file.kind)) {
      invalid('plan file kind must be "changelog" or "readme"', { where });
    }
    if (typeof file.locale !== 'string' || file.locale.length === 0) {
      invalid('plan file locale must be a non-empty string', { where });
    }
    assertDigest(file.oldDigest, `${where}.oldDigest`);
    assertDigest(file.newDigest, `${where}.newDigest`);
    if (typeof file.change !== 'string' || !CHANGES.has(file.change)) {
      invalid('plan file change must be "insert", "update", or "none"', { where });
    }
    if (typeof file.changed !== 'boolean') {
      invalid('plan file changed must be a boolean', { where });
    }
    if (
      !isPlainObject(file.summary) ||
      typeof file.summary.oldSize !== 'number' ||
      typeof file.summary.newSize !== 'number' ||
      typeof file.summary.delta !== 'number'
    ) {
      invalid('plan file summary must carry numeric oldSize, newSize, and delta', { where });
    }
    // Whitelisted copy: candidate bytes never reach the projection.
    return {
      path: file.path,
      kind: file.kind,
      locale: file.locale,
      oldDigest: file.oldDigest,
      newDigest: file.newDigest,
      change: file.change,
      changed: file.changed,
      summary: {
        oldSize: file.summary.oldSize,
        newSize: file.summary.newSize,
        delta: file.summary.delta,
      },
    };
  });

  const argv = ['release-skill', 'docs', 'refresh', '--unit', plan.unitId];
  const writeArgv =
    plan.status === 'changes'
      ? [...argv, '--write', '--confirm-refresh', plan.refreshDigest, '--ack-local-document-write']
      : null;

  return deepFreeze({
    status: plan.status,
    unitId: plan.unitId,
    version: plan.version,
    locales: [...plan.locales],
    inputDigest: plan.inputDigest,
    refreshDigest: plan.refreshDigest,
    files,
    nextCommand: { argv, writeArgv },
  });
}
