/**
 * Deterministic pure renderer refreshing managed regions and version
 * markers in a multilingual README from canonical release notes
 * (2026-07-21-release-docs-refresh-protocol §4.1,
 * 2026-07-21-readme-release-renderer).
 *
 * `renderReadmeRelease({ bytes, target, notes })` maps the raw README
 * bytes, one canonicalized README target, and canonical release notes to a
 * deeply frozen projection carrying the candidate bytes. It is a pure
 * function: no file reads or writes, no network, no subprocesses.
 *
 * Byte-protection contract:
 * - Only the bytes between each declared managed start/end marker pair and
 *   the machine version values are replaced; the markers themselves and
 *   every byte outside the declared ranges are preserved verbatim.
 * - Generated content uses the file's unique existing newline style; mixed
 *   CRLF/bare-LF files and bare CR fail closed with STRUCTURE_INVALID.
 *   Files without any newline default to LF.
 * - Rendering the same input twice is byte-idempotent.
 * - Missing, duplicate, nested, crossed, reversed, corrupt, or undeclared
 *   managed markers; version-marker matches that are absent, ambiguous,
 *   empty, multiline, NUL-bearing, region-overlapping, or mutually
 *   overlapping; and body values that would inject managed structure all
 *   fail closed with STRUCTURE_INVALID without returning candidate bytes.
 * - A missing target locale fails closed with
 *   RELEASE_DOCS_TRANSLATION_MISSING naming the locale precisely; content
 *   is never substituted from another locale. `en` and `zh-CN` use fixed
 *   built-in labels; every other locale uses the English canonical labels
 *   (no translation is ever invoked).
 * - Malformed target/notes shapes fail closed with RELEASE_DOCS_INVALID.
 *   Error details never carry note body text, credentials, or paths; the
 *   projection carries no path at all.
 *
 * @module src/docs/readme-renderer
 */

import { parseManagedRegions } from '../artifacts/merge/regions.mjs';
import { RELEASE_NOTES_CATEGORIES } from './notes.mjs';
import {
  ReleaseError,
  RELEASE_DOCS_INVALID,
  RELEASE_DOCS_TRANSLATION_MISSING,
  STRUCTURE_INVALID,
} from '../core/errors.mjs';

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/** Version placeholder required inside every versionMarker pattern. */
const VERSION_PLACEHOLDER = '{version}';

/** Generic prefixes shared by all managed-region markers. */
const MANAGED_START_PREFIX = '<!-- release-skill:managed:start id=';
const MANAGED_END_PREFIX = '<!-- release-skill:managed:end id=';

/**
 * Byte prefix no rendered body value may contain: it would inject managed
 * or version-marker structure and break byte-idempotent re-rendering.
 */
const RESERVED_STRUCTURE_PREFIX = '<!-- release-skill:';

/** Fixed built-in category labels for locales with first-class support. */
const CATEGORY_LABELS = Object.freeze({
  en: Object.freeze({
    security: 'Security',
    breaking: 'Breaking Changes',
    added: 'Added',
    changed: 'Changed',
    deprecated: 'Deprecated',
    removed: 'Removed',
    fixed: 'Fixed',
  }),
  'zh-CN': Object.freeze({
    security: '安全',
    breaking: '破坏性变更',
    added: '新增',
    changed: '变更',
    deprecated: '弃用',
    removed: '移除',
    fixed: '修复',
  }),
});

/** Fixed built-in upgrade-notes labels for locales with first-class support. */
const UPGRADE_NOTES_LABELS = Object.freeze({
  en: 'Upgrade Notes',
  'zh-CN': '升级说明',
});

/**
 * Stable label fallback for every other locale: the English canonical
 * labels. Body content always comes from the requested locale and is never
 * substituted; only labels fall back, and translation is never invoked.
 */
const FALLBACK_LABEL_LOCALE = 'en';

const CATEGORY_SET = new Set(RELEASE_NOTES_CATEGORIES);

// ---------------------------------------------------------------------------
// Error helpers (details must never include note body text or paths)
// ---------------------------------------------------------------------------

function structureError(message, details = {}) {
  throw new ReleaseError(STRUCTURE_INVALID, message, details);
}

function docsError(message, details = {}) {
  throw new ReleaseError(RELEASE_DOCS_INVALID, message, details);
}

function translationMissing(locale) {
  throw new ReleaseError(
    RELEASE_DOCS_TRANSLATION_MISSING,
    `release notes are missing locale: ${locale}`,
    { reason: 'MISSING_LOCALE', locales: [locale] },
  );
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deeply freeze a plain object/array structure. Typed arrays (Buffer) are
 * skipped: the JS specification forbids freezing non-empty ArrayBuffer
 * views, so candidate bytes are instead guaranteed immutable by always
 * being a freshly composed copy that shares no mutable state with inputs.
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

/** Split one canonical body value into logical lines at any CR/LF style. */
function valueLines(value) {
  return value.split(/\r\n|\r|\n/);
}

// ---------------------------------------------------------------------------
// Input validation (fail closed; never mutate inputs)
// ---------------------------------------------------------------------------

/**
 * Validate a canonical README target and derive its marker split form.
 *
 * @param {unknown} target
 * @returns {{ locale: string, regions: string[], markers: Array<{ id: string, prefix: string, suffix: string }> }}
 */
function validateTarget(target) {
  if (!isPlainObject(target)) {
    docsError('readme target must be an object', { field: 'target' });
  }
  if (typeof target.path !== 'string' || target.path.length === 0) {
    docsError('readme target path must be a non-empty string', { field: 'target.path' });
  }
  if (typeof target.locale !== 'string' || target.locale.length === 0) {
    docsError('readme target locale must be a non-empty string', { field: 'target.locale' });
  }
  if (!Array.isArray(target.regions) || target.regions.length === 0) {
    docsError('readme target regions must be a non-empty array', { field: 'target.regions' });
  }
  for (const region of target.regions) {
    if (typeof region !== 'string' || region.length === 0) {
      docsError('readme target region ids must be non-empty strings', { field: 'target.regions' });
    }
  }

  const markers = [];
  if ('versionMarkers' in target) {
    const { versionMarkers } = target;
    if (!Array.isArray(versionMarkers) || versionMarkers.length === 0) {
      docsError('readme target versionMarkers must be a non-empty array when present', {
        field: 'target.versionMarkers',
      });
    }
    for (const marker of versionMarkers) {
      if (!isPlainObject(marker)) {
        docsError('readme versionMarker must be an object', { field: 'target.versionMarkers' });
      }
      if (typeof marker.id !== 'string' || marker.id.length === 0) {
        docsError('readme versionMarker id must be a non-empty string', { field: 'target.versionMarkers' });
      }
      const { pattern } = marker;
      if (typeof pattern !== 'string' || pattern.length === 0) {
        docsError('readme versionMarker pattern must be a non-empty string', {
          markerId: marker.id,
        });
      }
      if (/[\r\n\0]/.test(pattern)) {
        docsError('readme versionMarker pattern must not contain CR, LF, or NUL', {
          markerId: marker.id,
        });
      }
      const start = pattern.indexOf(VERSION_PLACEHOLDER);
      const next =
        start === -1 ? -1 : pattern.indexOf(VERSION_PLACEHOLDER, start + VERSION_PLACEHOLDER.length);
      if (
        start === -1 ||
        next !== -1 ||
        start === 0 ||
        start + VERSION_PLACEHOLDER.length === pattern.length
      ) {
        docsError(
          'readme versionMarker pattern must contain exactly one {version} placeholder with non-empty fixed bytes on both sides',
          { markerId: marker.id },
        );
      }
      markers.push({
        id: marker.id,
        prefix: pattern.slice(0, start),
        suffix: pattern.slice(start + VERSION_PLACEHOLDER.length),
      });
    }
  }

  return { locale: target.locale, regions: [...target.regions], markers };
}

/**
 * Validate canonical release notes and extract the target locale's closed
 * entry. A missing locale is a precise translation failure; content is
 * never substituted from another locale.
 *
 * @param {unknown} notes
 * @param {string} locale
 * @returns {{
 *   version: string,
 *   date: string,
 *   summary: string,
 *   changes: Record<string, string[]>,
 *   upgradeNotes: string | undefined,
 *   categories: string[],
 * }}
 */
function validateNotes(notes, locale) {
  if (!isPlainObject(notes)) {
    docsError('release notes must be an object', { field: 'notes' });
  }
  const { version, date, locales } = notes;
  if (typeof version !== 'string' || version.length === 0) {
    docsError('release notes version must be a non-empty string', { field: 'notes.version' });
  }
  if (/[\r\n\0]/.test(version)) {
    docsError('release notes version must not contain CR, LF, or NUL', { field: 'notes.version' });
  }
  if (typeof date !== 'string' || date.length === 0) {
    docsError('release notes date must be a non-empty string', { field: 'notes.date' });
  }
  if (!isPlainObject(locales)) {
    docsError('release notes locales must be an object', { field: 'notes.locales' });
  }
  if (!Object.hasOwn(locales, locale)) {
    translationMissing(locale);
  }
  const entry = locales[locale];
  if (!isPlainObject(entry)) {
    docsError('release notes locale entry must be an object', { locale });
  }

  if (typeof entry.summary !== 'string' || entry.summary.trim().length === 0) {
    docsError('release notes summary must be a non-empty string', { locale });
  }
  const summary = entry.summary.trim();

  if (!isPlainObject(entry.changes)) {
    docsError('release notes changes must be a mapping of categories', { locale });
  }
  const changes = {};
  let totalEntries = 0;
  for (const category of RELEASE_NOTES_CATEGORIES) {
    if (!Object.hasOwn(entry.changes, category)) continue;
    const items = entry.changes[category];
    if (!Array.isArray(items)) {
      docsError('release notes change category must be an array', { locale, category });
    }
    const clean = [];
    for (const item of items) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        docsError('release notes change entries must be non-empty strings', { locale, category });
      }
      clean.push(item.trim());
    }
    if (clean.length > 0) {
      changes[category] = clean;
      totalEntries += clean.length;
    }
  }
  for (const key of Object.keys(entry.changes)) {
    if (!CATEGORY_SET.has(key)) {
      docsError('release notes contain an unknown change category', { locale, category: key });
    }
  }
  if (totalEntries === 0) {
    docsError('release notes must contain at least one non-empty change category', { locale });
  }

  let upgradeNotes;
  if (Object.hasOwn(entry, 'upgradeNotes')) {
    if (typeof entry.upgradeNotes !== 'string' || entry.upgradeNotes.trim().length === 0) {
      docsError('release notes upgradeNotes must be a non-empty string when present', { locale });
    }
    upgradeNotes = entry.upgradeNotes.trim();
  }

  const categories = RELEASE_NOTES_CATEGORIES.filter(
    (category) => (changes[category]?.length ?? 0) > 0,
  );

  return { version, date, summary, changes, upgradeNotes, categories };
}

/**
 * Fail closed if any rendered body value could inject managed structure or
 * marker bytes; preserving byte-idempotent re-rendering requires it.
 *
 * @param {string[]} values
 */
function assertBodySafe(values) {
  for (const value of values) {
    if (value.includes(RESERVED_STRUCTURE_PREFIX)) {
      structureError('release notes body must not contain managed structure markers', {
        reason: 'BODY_INJECTS_STRUCTURE',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Byte-level structure detection
// ---------------------------------------------------------------------------

/**
 * Detect the file's unique existing newline style.
 *
 * @param {Buffer} bytes
 * @returns {string} '\n' or '\r\n'
 * @throws {ReleaseError} STRUCTURE_INVALID on bare CR or mixed CRLF/LF.
 */
function detectEol(bytes) {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === 0x0a) {
      lf += 1;
    } else if (byte === 0x0d) {
      cr += 1;
      if (bytes[i + 1] === 0x0a) crlf += 1;
    }
  }
  const bareLf = lf - crlf;
  const bareCr = cr - crlf;
  if (bareCr > 0) {
    structureError('README contains bare CR line endings', { reason: 'MIXED_LINE_ENDINGS' });
  }
  if (crlf > 0 && bareLf > 0) {
    structureError('README mixes CRLF and LF line endings', { reason: 'MIXED_LINE_ENDINGS' });
  }
  return crlf > 0 ? '\r\n' : '\n';
}

/**
 * Build managed-region declarations for one target.
 *
 * @param {string[]} regions
 * @returns {Array<{ id: string, start: string, end: string }>}
 */
function managedDeclarations(regions) {
  return regions.map((id) => ({
    id,
    start: `${MANAGED_START_PREFIX}${id} -->`,
    end: `${MANAGED_END_PREFIX}${id} -->`,
  }));
}

/**
 * Fail closed on corrupt or undeclared managed-region markers: every
 * generic marker prefix occurrence must begin an exact declared marker.
 *
 * @param {Buffer} bytes
 * @param {Array<{ id: string, start: string, end: string }>} declarations
 */
function assertNoUnknownManagedMarkers(bytes, declarations) {
  for (const kind of ['start', 'end']) {
    const prefix = kind === 'start' ? MANAGED_START_PREFIX : MANAGED_END_PREFIX;
    let offset = 0;
    while (offset <= bytes.length) {
      const idx = bytes.indexOf(prefix, offset, 'utf8');
      if (idx < 0) break;
      const known = declarations.some((decl) => {
        const marker = kind === 'start' ? decl.start : decl.end;
        return bytes.indexOf(marker, idx, 'utf8') === idx;
      });
      if (!known) {
        structureError('README contains a corrupt or undeclared managed region marker', {
          reason: 'UNKNOWN_MANAGED_MARKER',
          offset: idx,
        });
      }
      offset = idx + 1;
    }
  }
}

/**
 * Find every version-marker match: a prefix occurrence followed by the
 * suffix, with the machine value in between.
 *
 * @param {Buffer} bytes
 * @param {string} prefix
 * @param {string} suffix
 * @returns {Array<{ prefixStart: number, valueStart: number, valueEnd: number, suffixEnd: number }>}
 */
function findVersionMarkerMatches(bytes, prefix, suffix) {
  const matches = [];
  const prefixLength = Buffer.byteLength(prefix, 'utf8');
  const suffixLength = Buffer.byteLength(suffix, 'utf8');
  let offset = 0;
  while (offset <= bytes.length) {
    const prefixStart = bytes.indexOf(prefix, offset, 'utf8');
    if (prefixStart < 0) break;
    const suffixStart = bytes.indexOf(suffix, prefixStart + prefixLength, 'utf8');
    if (suffixStart >= 0) {
      matches.push({
        prefixStart,
        valueStart: prefixStart + prefixLength,
        valueEnd: suffixStart,
        suffixEnd: suffixStart + suffixLength,
      });
    }
    offset = prefixStart + 1;
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Body rendering
// ---------------------------------------------------------------------------

/**
 * Render the region body as logical lines (newline-style agnostic).
 * Category order follows RELEASE_NOTES_CATEGORIES; labels come from the
 * built-in locale tables with the English canonical fallback.
 *
 * @param {{ summary: string, changes: Record<string, string[]>, upgradeNotes?: string }} entry
 * @param {string} locale
 * @param {string} version
 * @param {string} date
 * @returns {string[]}
 */
function renderBodyLines(entry, locale, version, date) {
  const labels = CATEGORY_LABELS[locale] ?? CATEGORY_LABELS[FALLBACK_LABEL_LOCALE];
  const upgradeLabel = UPGRADE_NOTES_LABELS[locale] ?? UPGRADE_NOTES_LABELS[FALLBACK_LABEL_LOCALE];

  const lines = [];
  lines.push(`**${version}** (${date})`);
  lines.push('');
  lines.push(...valueLines(entry.summary));
  for (const category of RELEASE_NOTES_CATEGORIES) {
    const items = entry.changes[category];
    if (!items || items.length === 0) continue;
    lines.push('');
    lines.push(`**${labels[category]}**`);
    lines.push('');
    for (const item of items) {
      const itemLines = valueLines(item);
      lines.push(`- ${itemLines[0]}`);
      for (let i = 1; i < itemLines.length; i += 1) {
        lines.push(`  ${itemLines[i]}`);
      }
    }
  }
  if (entry.upgradeNotes !== undefined) {
    lines.push('');
    lines.push(`**${upgradeLabel}**`);
    lines.push('');
    lines.push(...valueLines(entry.upgradeNotes));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the refreshed README candidate bytes from raw bytes, one
 * canonical README target, and canonical release notes.
 *
 * Pure function: no file reads or writes, no network, no subprocesses.
 * Inputs are never mutated; the returned projection (including the
 * candidate bytes and every array) is deeply frozen.
 *
 * @param {object} input
 * @param {Uint8Array} input.bytes  Raw README bytes.
 * @param {object} input.target  Canonical README target
 *   ({ path, locale, regions, versionMarkers? }) as produced by
 *   normalizeReleaseDocumentsConfig.
 * @param {object} input.notes  Canonical release notes as produced by
 *   parseReleaseNotes ({ version, date, locales }).
 * @returns {Readonly<{
 *   kind: 'readme',
 *   locale: string,
 *   version: string,
 *   date: string,
 *   categories: readonly string[],
 *   regions: readonly string[],
 *   changed: boolean,
 *   bytes: Buffer,
 * }>} deeply frozen projection with candidate bytes
 * @throws {ReleaseError} STRUCTURE_INVALID on any byte-structure violation
 *   (no candidate bytes are ever returned on failure);
 *   RELEASE_DOCS_TRANSLATION_MISSING when the target locale is absent;
 *   RELEASE_DOCS_INVALID on malformed target/notes shapes.
 */
export function renderReadmeRelease({ bytes, target, notes } = {}) {
  if (!(bytes instanceof Uint8Array)) {
    structureError('readme bytes must be a Uint8Array/Buffer', { reason: 'INVALID_BYTES' });
  }
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  const { locale, regions, markers } = validateTarget(target);
  const { version, date, summary, changes, upgradeNotes, categories } = validateNotes(notes, locale);

  assertBodySafe([summary, upgradeNotes ?? '', ...Object.values(changes).flat()]);

  const eol = detectEol(input);

  // Managed regions: parse via the shared byte-level parser after rejecting
  // corrupt or undeclared markers the parser cannot see.
  const declarations = managedDeclarations(regions);
  assertNoUnknownManagedMarkers(input, declarations);
  const ranges = parseManagedRegions(input, declarations);

  // One shared body for every declared region, in the file's newline style.
  const bodyLines = renderBodyLines({ summary, changes, upgradeNotes }, locale, version, date);
  const innerBytes = Buffer.concat([
    Buffer.from(eol, 'utf8'),
    Buffer.from(bodyLines.join(eol), 'utf8'),
    Buffer.from(eol, 'utf8'),
  ]);

  /** @type {Array<{ id: string, start: number, end: number }>} */
  const protectedSpans = [];
  /** @type {Array<{ start: number, end: number, replacement: Buffer }>} */
  const edits = [];

  for (const decl of declarations) {
    const range = ranges.get(decl.id);
    protectedSpans.push({ id: `region:${decl.id}`, start: range.start, end: range.end });
    edits.push({
      start: range.start + Buffer.byteLength(decl.start, 'utf8'),
      end: range.end - Buffer.byteLength(decl.end, 'utf8'),
      replacement: innerBytes,
    });
  }

  // Version markers: exactly one match, non-empty single-line value, no
  // overlap with managed regions or other markers.
  const versionBytes = Buffer.from(version, 'utf8');
  for (const marker of markers) {
    const matches = findVersionMarkerMatches(input, marker.prefix, marker.suffix);
    if (matches.length === 0) {
      structureError(`version marker '${marker.id}' has no match in README`, {
        reason: 'VERSION_MARKER_NO_MATCH',
        markerId: marker.id,
      });
    }
    if (matches.length > 1) {
      structureError(`version marker '${marker.id}' matches more than once in README`, {
        reason: 'VERSION_MARKER_AMBIGUOUS',
        markerId: marker.id,
        matches: matches.length,
      });
    }
    const match = matches[0];
    if (match.valueStart === match.valueEnd) {
      structureError(`version marker '${marker.id}' has an empty machine value`, {
        reason: 'VERSION_MARKER_EMPTY_VALUE',
        markerId: marker.id,
      });
    }
    const value = input.subarray(match.valueStart, match.valueEnd);
    if (value.includes(0x0d) || value.includes(0x0a) || value.includes(0x00)) {
      structureError(`version marker '${marker.id}' machine value spans lines or contains NUL`, {
        reason: 'VERSION_MARKER_MULTILINE_VALUE',
        markerId: marker.id,
      });
    }
    protectedSpans.push({
      id: `versionMarker:${marker.id}`,
      start: match.prefixStart,
      end: match.suffixEnd,
    });
    edits.push({
      start: match.valueStart,
      end: match.valueEnd,
      replacement: versionBytes,
    });
  }

  // No two protected spans may overlap: regions never do (parser-guaranteed),
  // so this catches marker/region and marker/marker intersections.
  const sortedSpans = [...protectedSpans].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sortedSpans.length; i += 1) {
    if (sortedSpans[i].start < sortedSpans[i - 1].end) {
      structureError('managed regions and version markers must not overlap', {
        reason: 'OVERLAPPING_RANGES',
        spans: [sortedSpans[i - 1].id, sortedSpans[i].id],
      });
    }
  }

  // Apply all edits in descending byte order so earlier offsets stay valid.
  let out = input;
  const sortedEdits = [...edits].sort((a, b) => b.start - a.start);
  for (const edit of sortedEdits) {
    out = Buffer.concat([out.subarray(0, edit.start), edit.replacement, out.subarray(edit.end)]);
  }

  const changed = !input.equals(out);

  return deepFreeze({
    kind: 'readme',
    locale,
    version,
    date,
    categories,
    regions: [...regions],
    changed,
    bytes: out,
  });
}
