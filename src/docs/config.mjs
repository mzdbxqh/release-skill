/**
 * Runtime semantic validation for the releaseDocuments configuration block
 * (2026-07-21-release-docs-refresh-protocol §2).
 *
 * The JSON Schema layer provides the first lexical protection; this module
 * performs the closed-world semantic checks that cannot be expressed there:
 *
 * - every changelog/readme target locale is declared in `locales`;
 * - locale identifiers, region ids, and versionMarker ids are unique under
 *   exact, case-fold, and Unicode NFC comparison;
 * - changelog/readme target paths share one canonical namespace: each path
 *   is canonicalized through the existing `canonicalArtifactPath` helper
 *   (NFC, no traversal/absolute/backslash/NUL/empty segments) and duplicate
 *   or case/Unicode-colliding targets are rejected;
 * - every versionMarker pattern contains exactly one `{version}` placeholder
 *   with non-empty fixed bytes on both sides and no CR/LF/NUL bytes
 *   (2026-07-21-readme-release-renderer §2);
 * - every object level is closed: unknown fields fail closed;
 * - the input object is never mutated; a deeply frozen canonical object is
 *   returned on success.
 *
 * Pure and independently callable: no file reads, no YAML parsing, no
 * network, no subprocesses. All violations throw `ReleaseError` with the
 * stable code `RELEASE_DOCS_INVALID`; unsafe paths record the original
 * `PATH_UNSAFE` cause in `details.cause`.
 *
 * @module src/docs/config
 */

import { canonicalArtifactPath } from '../artifacts/path-key.mjs';
import { ReleaseError, RELEASE_DOCS_INVALID } from '../core/errors.mjs';

// ---------------------------------------------------------------------------
// Closed key sets (mirror the authoritative release-project schema)
// ---------------------------------------------------------------------------

const ROOT_KEYS = Object.freeze(['notesSource', 'locales', 'changelogs', 'readmes']);
const CHANGELOG_KEYS = Object.freeze(['path', 'locale']);
const README_KEYS = Object.freeze(['path', 'locale', 'regions', 'versionMarkers']);
const MARKER_KEYS = Object.freeze(['id', 'pattern']);

/** BCP 47-style stable locale identifier (mirrors the schema pattern). */
const LOCALE_PATTERN = /^[a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Managed-region id and versionMarker id (mirrors the schema pattern). */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Version placeholder required inside every versionMarker pattern. */
const VERSION_PLACEHOLDER = '{version}';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function invalid(message, details = {}) {
  throw new ReleaseError(RELEASE_DOCS_INVALID, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Stable collision key: NFC + en-US case-fold (same semantics as canonicalArtifactPath). */
function foldKey(value) {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

/**
 * Reject unknown keys on a closed object level.
 * @param {object} obj
 * @param {readonly string[]} allowed
 * @param {string} where  Human-readable location for error details.
 */
function assertClosed(obj, allowed, where) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      invalid(`releaseDocuments: unknown field "${key}" in ${where}`, { where, key });
    }
  }
}

/**
 * Track exact and folded keys for one namespace; fail closed on duplicates
 * or case/Unicode collisions.
 */
class UniqueNamespace {
  constructor(kind, where) {
    this.kind = kind;
    this.where = where;
    this.exact = new Set();
    this.folded = new Map();
  }

  /**
   * @param {string} canonical  Already-canonicalized (NFC) value.
   * @returns {string} the canonical value.
   */
  register(canonical) {
    if (this.exact.has(canonical)) {
      invalid(`releaseDocuments: duplicate ${this.kind} "${canonical}" in ${this.where}`, {
        where: this.where,
        kind: this.kind,
        value: canonical,
      });
    }
    this.exact.add(canonical);
    const key = foldKey(canonical);
    const existing = this.folded.get(key);
    if (existing !== undefined && existing !== canonical) {
      invalid(
        `releaseDocuments: case/Unicode collision in ${this.kind}: "${canonical}" and "${existing}" in ${this.where}`,
        { where: this.where, kind: this.kind, value: canonical, existing },
      );
    }
    this.folded.set(key, canonical);
    return canonical;
  }
}

/**
 * Canonicalize one configured path through the shared artifact path helper,
 * converting PATH_UNSAFE into RELEASE_DOCS_INVALID with the original cause.
 *
 * @param {unknown} raw
 * @param {string} where
 * @returns {string} canonical NFC path
 */
function canonicalPath(raw, where) {
  if (typeof raw !== 'string' || raw.length === 0) {
    invalid(`releaseDocuments: ${where} must be a non-empty string`, { where, path: raw });
  }
  try {
    return canonicalArtifactPath(raw).path;
  } catch (err) {
    invalid(`releaseDocuments: unsafe path in ${where}: ${err.message}`, {
      where,
      path: raw,
      cause: err.code ?? 'PATH_UNSAFE',
    });
  }
}

/**
 * Validate a versionMarker pattern (2026-07-21-readme-release-renderer §2):
 * exactly one `{version}` placeholder with non-empty fixed bytes on both
 * sides, and no CR, LF, or NUL byte anywhere.
 *
 * @param {string} pattern  Already checked to be a non-empty string.
 * @param {string} where  Human-readable location for error details.
 */
function assertVersionPattern(pattern, where) {
  if (/[\r\n\0]/.test(pattern)) {
    invalid('releaseDocuments: versionMarker pattern must not contain CR, LF, or NUL', { where });
  }
  const start = pattern.indexOf(VERSION_PLACEHOLDER);
  const next = start === -1 ? -1 : pattern.indexOf(VERSION_PLACEHOLDER, start + VERSION_PLACEHOLDER.length);
  if (start === -1 || next !== -1) {
    invalid('releaseDocuments: versionMarker pattern must contain exactly one {version} placeholder', { where });
  }
  if (start === 0) {
    invalid('releaseDocuments: versionMarker pattern must have non-empty bytes before {version}', { where });
  }
  if (start + VERSION_PLACEHOLDER.length === pattern.length) {
    invalid('releaseDocuments: versionMarker pattern must have non-empty bytes after {version}', { where });
  }
}

/**
 * Recursively freeze a plain object/array structure built from primitives.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a parsed `releaseDocuments` configuration block and return its
 * canonical, deeply frozen form.
 *
 * The input object is never mutated; all returned containers are fresh
 * copies. On any semantic violation a `ReleaseError` with code
 * `RELEASE_DOCS_INVALID` is thrown.
 *
 * @param {unknown} config  Parsed releaseDocuments block (schema-checked or not).
 * @returns {Readonly<{
 *   notesSource: string,
 *   locales: readonly string[],
 *   changelogs: ReadonlyArray<{ path: string, locale: string }>,
 *   readmes: ReadonlyArray<{
 *     path: string,
 *     locale: string,
 *     regions: readonly string[],
 *     versionMarkers?: ReadonlyArray<{ id: string, pattern: string }>,
 *   }>,
 * }>}
 * @throws {ReleaseError} RELEASE_DOCS_INVALID on any semantic violation.
 */
export function normalizeReleaseDocumentsConfig(config) {
  if (!isPlainObject(config)) {
    invalid('releaseDocuments must be an object', { actual: Array.isArray(config) ? 'array' : typeof config });
  }

  assertClosed(config, ROOT_KEYS, 'releaseDocuments');
  for (const key of ROOT_KEYS) {
    if (!(key in config)) {
      invalid(`releaseDocuments: missing required field "${key}"`, { field: key });
    }
  }

  const { notesSource, locales, changelogs, readmes } = config;

  // --- notesSource: canonical path (placeholder/suffix checked at load time) ---
  const canonicalNotesSource = canonicalPath(notesSource, 'releaseDocuments.notesSource');

  // --- locales: non-empty, well-formed, unique (exact + case-fold + NFC) ---
  if (!Array.isArray(locales) || locales.length === 0) {
    invalid('releaseDocuments: locales must be a non-empty array', { field: 'locales' });
  }
  const localeNamespace = new UniqueNamespace('locale', 'releaseDocuments.locales');
  const declaredLocales = new Set();
  for (const locale of locales) {
    if (typeof locale !== 'string' || !LOCALE_PATTERN.test(locale)) {
      invalid('releaseDocuments: invalid locale identifier', { field: 'locales', locale });
    }
    localeNamespace.register(locale);
    declaredLocales.add(locale);
  }

  // --- shared target-path namespace across changelogs and readmes ---
  const targetNamespace = new UniqueNamespace('target path', 'releaseDocuments');

  // --- changelogs ---
  if (!Array.isArray(changelogs) || changelogs.length === 0) {
    invalid('releaseDocuments: changelogs must be a non-empty array', { field: 'changelogs' });
  }
  const canonicalChangelogs = changelogs.map((item, index) => {
    const where = `releaseDocuments.changelogs[${index}]`;
    if (!isPlainObject(item)) invalid(`releaseDocuments: changelog item must be an object`, { where });
    assertClosed(item, CHANGELOG_KEYS, where);
    for (const key of CHANGELOG_KEYS) {
      if (!(key in item)) invalid(`releaseDocuments: changelog item missing "${key}"`, { where, field: key });
    }
    const path = targetNamespace.register(canonicalPath(item.path, `${where}.path`));
    const { locale } = item;
    if (typeof locale !== 'string' || !declaredLocales.has(locale)) {
      invalid(`releaseDocuments: changelog locale is not declared in locales`, { where, locale });
    }
    return { path, locale };
  });

  // --- readmes ---
  if (!Array.isArray(readmes) || readmes.length === 0) {
    invalid('releaseDocuments: readmes must be a non-empty array', { field: 'readmes' });
  }
  const canonicalReadmes = readmes.map((item, index) => {
    const where = `releaseDocuments.readmes[${index}]`;
    if (!isPlainObject(item)) invalid('releaseDocuments: readme item must be an object', { where });
    assertClosed(item, README_KEYS, where);
    for (const key of ['path', 'locale', 'regions']) {
      if (!(key in item)) invalid(`releaseDocuments: readme item missing "${key}"`, { where, field: key });
    }
    const path = targetNamespace.register(canonicalPath(item.path, `${where}.path`));
    const { locale } = item;
    if (typeof locale !== 'string' || !declaredLocales.has(locale)) {
      invalid('releaseDocuments: readme locale is not declared in locales', { where, locale });
    }

    // regions: non-empty, well-formed, unique (exact + case-fold + NFC)
    const { regions } = item;
    if (!Array.isArray(regions) || regions.length === 0) {
      invalid('releaseDocuments: regions must be a non-empty array', { where });
    }
    const regionNamespace = new UniqueNamespace('region', where);
    const canonicalRegions = regions.map((region) => {
      if (typeof region !== 'string' || !ID_PATTERN.test(region)) {
        invalid('releaseDocuments: invalid region id', { where, region });
      }
      return regionNamespace.register(region);
    });

    const canonical = { path, locale, regions: canonicalRegions };

    // versionMarkers: optional; when present non-empty with unique ids
    if ('versionMarkers' in item) {
      const { versionMarkers } = item;
      if (!Array.isArray(versionMarkers) || versionMarkers.length === 0) {
        invalid('releaseDocuments: versionMarkers must be a non-empty array when present', { where });
      }
      const markerNamespace = new UniqueNamespace('versionMarker id', where);
      canonical.versionMarkers = versionMarkers.map((marker, markerIndex) => {
        const markerWhere = `${where}.versionMarkers[${markerIndex}]`;
        if (!isPlainObject(marker)) {
          invalid('releaseDocuments: versionMarker item must be an object', { where: markerWhere });
        }
        assertClosed(marker, MARKER_KEYS, markerWhere);
        for (const key of MARKER_KEYS) {
          if (!(key in marker)) {
            invalid(`releaseDocuments: versionMarker item missing "${key}"`, { where: markerWhere, field: key });
          }
        }
        const { id, pattern } = marker;
        if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
          invalid('releaseDocuments: invalid versionMarker id', { where: markerWhere, id });
        }
        if (typeof pattern !== 'string' || pattern.length === 0) {
          invalid('releaseDocuments: versionMarker pattern must be a non-empty string', { where: markerWhere });
        }
        assertVersionPattern(pattern, markerWhere);
        return { id: markerNamespace.register(id), pattern };
      });
    }

    return canonical;
  });

  return deepFreeze({
    notesSource: canonicalNotesSource,
    locales: [...locales],
    changelogs: canonicalChangelogs,
    readmes: canonicalReadmes,
  });
}
