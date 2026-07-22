/**
 * Deterministic pure renderer refreshing the current-version managed entry
 * in a multilingual CHANGELOG from canonical release notes
 * (2026-07-21-release-docs-refresh-protocol §4.2,
 * 2026-07-21-changelog-release-renderer).
 *
 * `renderChangelogRelease({ bytes, target, notes })` maps the raw CHANGELOG
 * bytes, one canonicalized changelog target ({ path, locale }), and
 * canonical release notes to a deeply frozen projection carrying the
 * candidate bytes. It is a pure function: no file reads or writes, no
 * network, no subprocesses.
 *
 * Managed-entry protocol:
 * - Entries are enclosed by
 *   `<!-- release-skill:changelog:start version=V locale=L baseline=sha256:<64hex> -->`
 *   and `<!-- release-skill:changelog:end version=V locale=L -->`.
 *   `baseline` is the SHA-256 of the canonical body bytes between the two
 *   comments (comments excluded; the single leading and trailing file-EOL
 *   adjacent to the comments are structural and excluded as well). Body
 *   newlines use the file's unique existing newline style.
 * - When the current version has no managed entry and no same-version
 *   heading, one blank line, the canonical managed entry, and one blank
 *   line are inserted right after the single H1 line; every byte outside
 *   the insertion is preserved verbatim.
 * - When a managed current entry exists, its markers must be unique,
 *   same-version, same-locale, complete, and neither nested nor crossed,
 *   and the current body digest must equal the recorded baseline; only
 *   then is the whole entry replaced. Human edits fail closed without
 *   being overwritten.
 * - Unmanaged same-version headings, multiple same-version headings, and
 *   corrupt or mismatched current-version markers fail closed as
 *   conflicts; the renderer never degrades a corrupt state into an insert.
 *
 * Byte-protection contract:
 * - Only the current-version managed entry is inserted or replaced; other
 *   versions' managed entries, old unmanaged entries, preamble, link
 *   definitions, and human notes are preserved verbatim.
 * - Generated content uses the file's unique existing newline style; mixed
 *   CRLF/bare-LF files and bare CR fail closed with STRUCTURE_INVALID.
 *   Files without any newline default to LF.
 * - The file must have exactly one H1; zero or multiple H1s fail closed
 *   with STRUCTURE_INVALID.
 * - Rendering the same input twice is byte-idempotent.
 * - Any corrupt, nested, crossed, or metadata-mismatched release-skill
 *   changelog marker fails closed without returning candidate bytes.
 *   Global (non-current) marker corruption fails with STRUCTURE_INVALID;
 *   current-version marker corruption or conflict fails with
 *   RELEASE_DOCS_CONFLICT.
 * - A missing target locale fails closed with
 *   RELEASE_DOCS_TRANSLATION_MISSING naming the locale precisely; content
 *   is never substituted from another locale. `en` and `zh-CN` use fixed
 *   built-in labels; every other locale uses the English canonical labels
 *   (no translation is ever invoked).
 * - Malformed target/notes shapes fail closed with RELEASE_DOCS_INVALID.
 *   Error details never carry note body text, credentials, or paths; the
 *   projection carries no path at all.
 *
 * Human/same-version conflicts (unmanaged same-version headings, corrupt or
 * mismatched current-version markers, baseline mismatches after hand edits)
 * fail closed with the stable RELEASE_DOCS_CONFLICT code (protocol §7) and a
 * machine-readable `details.reason`.
 *
 * @module src/docs/changelog-renderer
 */

import { RELEASE_NOTES_CATEGORIES } from './notes.mjs';
import { sha256Hex } from '../core/digest.mjs';
import {
  ReleaseError,
  RELEASE_DOCS_CONFLICT,
  RELEASE_DOCS_INVALID,
  RELEASE_DOCS_TRANSLATION_MISSING,
  STRUCTURE_INVALID,
} from '../core/errors.mjs';

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/** Generic byte prefix shared by every changelog managed-entry marker. */
const MARKER_PREFIX = '<!-- release-skill:changelog:';

/**
 * Well-formed marker grammar (single line):
 * - start: `<!-- release-skill:changelog:start version=V locale=L baseline=sha256:<64 lowercase hex> -->`
 * - end:   `<!-- release-skill:changelog:end version=V locale=L -->`
 * Version/locale tokens carry no whitespace or angle brackets; a start
 * marker without baseline or an end marker with baseline is corrupt.
 */
const WELL_FORMED_MARKER =
  /^<!-- release-skill:changelog:(start|end) version=([^\s<>]+) locale=([^\s<>]+)( baseline=sha256:([0-9a-f]{64}))? -->$/;

/** Max bytes scanned for a marker's closing `-->` before declaring corrupt. */
const MARKER_MAX_BYTES = 512;

/**
 * Byte prefix no rendered body value may contain: it would inject managed
 * marker structure and break byte-idempotent re-rendering.
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

/**
 * Characters a version/date may not contain: they would corrupt the
 * `## [version] - date` heading or the space-separated marker metadata.
 */
const UNSAFE_TOKEN_CHARS = /[\s[\]<>\0]/;

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

/**
 * Human/same-version conflict failure (protocol §7): unmanaged same-version
 * content, corrupt/mismatched current-version markers, or hand-edited
 * baselines. Details carry a machine-readable `reason`, never body text.
 */
function conflictError(message, details = {}) {
  throw new ReleaseError(RELEASE_DOCS_CONFLICT, message, details);
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Input validation (fail closed; never mutate inputs)
// ---------------------------------------------------------------------------

/**
 * Validate a canonical changelog target ({ path, locale }).
 *
 * @param {unknown} target
 * @returns {{ locale: string }}
 */
function validateTarget(target) {
  if (!isPlainObject(target)) {
    docsError('changelog target must be an object', { field: 'target' });
  }
  if (typeof target.path !== 'string' || target.path.length === 0) {
    docsError('changelog target path must be a non-empty string', { field: 'target.path' });
  }
  if (typeof target.locale !== 'string' || target.locale.length === 0) {
    docsError('changelog target locale must be a non-empty string', { field: 'target.locale' });
  }
  return { locale: target.locale };
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
  if (UNSAFE_TOKEN_CHARS.test(version)) {
    docsError('release notes version must not contain whitespace, brackets, angle brackets, or NUL', {
      field: 'notes.version',
    });
  }
  if (typeof date !== 'string' || date.length === 0) {
    docsError('release notes date must be a non-empty string', { field: 'notes.date' });
  }
  if (UNSAFE_TOKEN_CHARS.test(date)) {
    docsError('release notes date must not contain whitespace, brackets, angle brackets, or NUL', {
      field: 'notes.date',
    });
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
 * Fail closed if any rendered body value could inject managed markers or
 * heading structure; preserving byte-idempotent re-rendering and the
 * single-H1 invariant requires it.
 *
 * @param {{ summary: string, changes: Record<string, string[]>, upgradeNotes?: string }} entry
 */
function assertBodySafe(entry) {
  const allValues = [entry.summary, entry.upgradeNotes ?? '', ...Object.values(entry.changes).flat()];
  for (const value of allValues) {
    if (value.includes(RESERVED_STRUCTURE_PREFIX)) {
      structureError('release notes body must not contain managed structure markers', {
        reason: 'BODY_INJECTS_STRUCTURE',
      });
    }
  }
  // Summary and upgrade-notes lines render unindented; a '#' lead would
  // inject a heading (item lines are prefixed with '- ' or '  ').
  const unindented = [entry.summary, entry.upgradeNotes ?? ''];
  for (const value of unindented) {
    for (const line of valueLines(value)) {
      if (line.startsWith('#')) {
        structureError('release notes body must not contain heading lines', {
          reason: 'BODY_INJECTS_HEADING',
        });
      }
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
    structureError('CHANGELOG contains bare CR line endings', { reason: 'MIXED_LINE_ENDINGS' });
  }
  if (crlf > 0 && bareLf > 0) {
    structureError('CHANGELOG mixes CRLF and LF line endings', { reason: 'MIXED_LINE_ENDINGS' });
  }
  return crlf > 0 ? '\r\n' : '\n';
}

/** A line is an ATX H1 at column zero: '#', '# ' or '#\t' lead. */
function isH1Line(text) {
  return (
    text.length >= 1 &&
    text.charCodeAt(0) === 0x23 &&
    (text.length === 1 || text[1] === ' ' || text[1] === '\t')
  );
}

/**
 * Split decoded text at the uniform EOL and record each line's byte span.
 *
 * @param {string} text
 * @param {string} eol
 * @returns {Array<{ text: string, byteStart: number, byteLen: number, terminated: boolean }>}
 */
function splitLines(text, eol) {
  const lines = text.split(eol);
  const eolByteLen = Buffer.byteLength(eol, 'utf8');
  const infos = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const byteLen = Buffer.byteLength(lines[i], 'utf8');
    infos.push({ text: lines[i], byteStart: cursor, byteLen, terminated: i < lines.length - 1 });
    cursor += byteLen + eolByteLen;
  }
  return infos;
}

// ---------------------------------------------------------------------------
// Marker scanning and pairing
// ---------------------------------------------------------------------------

/**
 * Scan every release-skill changelog marker occurrence.
 *
 * A prefix occurrence that does not form an exact well-formed start/end
 * marker is corrupt. Corruption that names the current version fails
 * closed as a conflict (corrupt current-version marker); any other
 * corruption fails closed with STRUCTURE_INVALID. A corrupt state is never
 * treated as "current version absent".
 *
 * @param {Buffer} bytes
 * @param {string} version  Canonical target version (notes).
 * @returns {Array<{ kind: 'start' | 'end', version: string, locale: string, baseline?: string, start: number, end: number }>}
 */
function scanMarkers(bytes, version) {
  const prefixLen = Buffer.byteLength(MARKER_PREFIX, 'utf8');
  const currentVersionPattern = new RegExp(`version=${escapeRegExp(version)}(?=[\\s]|$)`);
  const markers = [];
  let offset = 0;
  while (offset <= bytes.length) {
    const idx = bytes.indexOf(MARKER_PREFIX, offset, 'utf8');
    if (idx < 0) break;
    const closeIdx = bytes.indexOf('-->', idx + prefixLen, 'utf8');
    const regionEnd =
      closeIdx < 0 || closeIdx - idx > MARKER_MAX_BYTES
        ? Math.min(idx + MARKER_MAX_BYTES, bytes.length)
        : closeIdx + 3;
    const regionText = bytes.toString('utf8', idx, regionEnd);
    const match = closeIdx >= 0 && closeIdx - idx <= MARKER_MAX_BYTES
      ? WELL_FORMED_MARKER.exec(regionText)
      : null;
    const wellFormed =
      match !== null &&
      ((match[1] === 'start' && match[5] !== undefined) ||
        (match[1] === 'end' && match[5] === undefined));
    if (!wellFormed) {
      if (currentVersionPattern.test(regionText)) {
        conflictError('CHANGELOG contains a corrupt current-version marker', {
          reason: 'CORRUPT_CURRENT_MARKER',
          offset: idx,
        });
      }
      structureError('CHANGELOG contains a corrupt managed-entry marker', {
        reason: 'CORRUPT_MARKER',
        offset: idx,
      });
    }
    markers.push({
      kind: match[1],
      version: match[2],
      locale: match[3],
      baseline: match[1] === 'start' ? match[5] : undefined,
      start: idx,
      end: idx + Buffer.byteLength(match[0], 'utf8'),
    });
    offset = idx + 1;
  }
  return markers;
}

/**
 * Pair markers into complete entries, failing closed on nesting, crossing,
 * metadata mismatch, and orphan markers.
 *
 * Pairing is two-phase so nested and crossed sequences are distinguished
 * precisely: each end marker binds to the nearest preceding unmatched start
 * with identical version+locale (a near-miss sharing version or locale is
 * a metadata-mismatch failure, not an orphan), then the resulting spans
 * must be strictly sequential — overlapping spans are nested when the
 * inner span closes first, crossed otherwise. Violations involving the
 * current version fail as conflicts; all others fail with STRUCTURE_INVALID.
 *
 * @param {Array<{ kind: string, version: string, locale: string, baseline?: string, start: number, end: number }>} markers
 * @param {string} version
 * @returns {Array<{ version: string, locale: string, baseline: string, start: number, bodyStart: number, bodyEnd: number, end: number }>}
 */
function pairMarkers(markers, version) {
  /** @type {Array<{ kind: string, version: string, locale: string, baseline?: string, start: number, end: number }>} */
  const openStarts = [];
  /** @type {Array<{ version: string, locale: string, baseline: string, start: number, bodyStart: number, bodyEnd: number, end: number }>} */
  const entries = [];

  for (const marker of markers) {
    if (marker.kind === 'start') {
      openStarts.push(marker);
      continue;
    }
    // Nearest preceding unmatched start with identical metadata.
    let foundIdx = -1;
    for (let i = openStarts.length - 1; i >= 0; i -= 1) {
      if (openStarts[i].version === marker.version && openStarts[i].locale === marker.locale) {
        foundIdx = i;
        break;
      }
    }
    if (foundIdx === -1) {
      // Near-miss: an open start shares version or locale -> mismatch.
      let nearIdx = -1;
      for (let i = openStarts.length - 1; i >= 0; i -= 1) {
        if (openStarts[i].version === marker.version || openStarts[i].locale === marker.locale) {
          nearIdx = i;
          break;
        }
      }
      if (nearIdx !== -1) {
        if (openStarts[nearIdx].version === version || marker.version === version) {
          conflictError('CHANGELOG current-version markers are crossed or metadata-mismatched', {
            reason: 'CURRENT_ENTRY_CROSSED',
            offset: marker.start,
          });
        }
        structureError('CHANGELOG managed-entry markers are crossed or metadata-mismatched', {
          reason: 'MARKER_CROSSED',
          offset: marker.start,
        });
      }
      // Orphan end marker.
      if (marker.version === version) {
        conflictError('CHANGELOG current-version end marker has no start marker', {
          reason: 'INCOMPLETE_CURRENT_ENTRY',
          offset: marker.start,
        });
      }
      structureError('CHANGELOG end marker has no start marker', {
        reason: 'INCOMPLETE_ENTRY',
        offset: marker.start,
      });
    }
    const open = openStarts[foundIdx];
    openStarts.splice(foundIdx, 1);
    entries.push({
      version: open.version,
      locale: open.locale,
      baseline: open.baseline,
      start: open.start,
      bodyStart: open.end,
      bodyEnd: marker.start,
      end: marker.end,
    });
  }

  // Orphan start markers.
  for (const open of openStarts) {
    if (open.version === version) {
      conflictError('CHANGELOG current-version start marker has no end marker', {
        reason: 'INCOMPLETE_CURRENT_ENTRY',
        offset: open.start,
      });
    }
    structureError('CHANGELOG start marker has no end marker', {
      reason: 'INCOMPLETE_ENTRY',
      offset: open.start,
    });
  }

  // Entries must be strictly sequential: overlapping spans are nested when
  // the inner span closes first, crossed otherwise.
  const sorted = [...entries].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i += 1) {
    const outer = sorted[i - 1];
    const inner = sorted[i];
    if (inner.start >= outer.end) continue;
    const involvesCurrent = outer.version === version || inner.version === version;
    if (inner.end > outer.end) {
      if (involvesCurrent) {
        conflictError('CHANGELOG current-version managed entries are crossed', {
          reason: 'CURRENT_ENTRY_CROSSED',
          offset: inner.start,
        });
      }
      structureError('CHANGELOG managed entries are crossed', {
        reason: 'MARKER_CROSSED',
        offset: inner.start,
      });
    }
    if (involvesCurrent) {
      conflictError('CHANGELOG current-version managed entries are nested', {
        reason: 'CURRENT_ENTRY_NESTED',
        offset: inner.start,
      });
    }
    structureError('CHANGELOG managed entries are nested', {
      reason: 'MARKER_NESTED',
      offset: inner.start,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Body rendering
// ---------------------------------------------------------------------------

/**
 * Render the canonical entry body as logical lines (newline-style
 * agnostic). Category order follows RELEASE_NOTES_CATEGORIES; labels come
 * from the built-in locale tables with the English canonical fallback.
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
  lines.push(`## [${version}] - ${date}`);
  lines.push('');
  lines.push(...valueLines(entry.summary));
  for (const category of RELEASE_NOTES_CATEGORIES) {
    const items = entry.changes[category];
    if (!items || items.length === 0) continue;
    lines.push('');
    lines.push(`### ${labels[category]}`);
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
    lines.push(`### ${upgradeLabel}`);
    lines.push('');
    lines.push(...valueLines(entry.upgradeNotes));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the refreshed CHANGELOG candidate bytes from raw bytes, one
 * canonical changelog target, and canonical release notes.
 *
 * Pure function: no file reads or writes, no network, no subprocesses.
 * Inputs are never mutated; the returned projection (including the
 * candidate bytes and every array) is deeply frozen.
 *
 * @param {object} input
 * @param {Uint8Array} input.bytes  Raw CHANGELOG bytes.
 * @param {object} input.target  Canonical changelog target ({ path, locale })
 *   as produced by normalizeReleaseDocumentsConfig.
 * @param {object} input.notes  Canonical release notes as produced by
 *   parseReleaseNotes ({ version, date, locales }).
 * @returns {Readonly<{
 *   kind: 'changelog',
 *   locale: string,
 *   version: string,
 *   date: string,
 *   categories: readonly string[],
 *   changed: boolean,
 *   change: 'insert' | 'update' | 'none',
 *   bytes: Buffer,
 * }>} deeply frozen projection with candidate bytes
 * @throws {ReleaseError} STRUCTURE_INVALID on any byte-structure or global
 *   marker violation (no candidate bytes are ever returned on failure);
 *   RELEASE_DOCS_CONFLICT on human/same-version conflicts;
 *   RELEASE_DOCS_TRANSLATION_MISSING when the target locale is absent;
 *   RELEASE_DOCS_INVALID on malformed target/notes shapes.
 */
export function renderChangelogRelease({ bytes, target, notes } = {}) {
  if (!(bytes instanceof Uint8Array)) {
    structureError('changelog bytes must be a Uint8Array/Buffer', { reason: 'INVALID_BYTES' });
  }
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  const { locale } = validateTarget(target);
  const { version, date, summary, changes, upgradeNotes, categories } = validateNotes(notes, locale);

  assertBodySafe({ summary, changes, upgradeNotes });

  const eol = detectEol(input);

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    structureError('CHANGELOG is not valid UTF-8', { reason: 'NOT_UTF8' });
  }

  const lines = splitLines(text, eol);
  const eolByteLen = Buffer.byteLength(eol, 'utf8');

  // Exactly one ATX H1 at column zero.
  const h1Lines = lines.filter((line) => isH1Line(line.text));
  if (h1Lines.length === 0) {
    structureError('CHANGELOG must contain exactly one level-1 heading', { reason: 'NO_H1' });
  }
  if (h1Lines.length > 1) {
    structureError('CHANGELOG must contain exactly one level-1 heading', {
      reason: 'MULTIPLE_H1',
      count: h1Lines.length,
    });
  }
  const h1 = h1Lines[0];

  // Global marker integrity, then current-version selection.
  const markers = scanMarkers(input, version);
  const entries = pairMarkers(markers, version);

  const sameVersionEntries = entries.filter((entry) => entry.version === version);
  if (sameVersionEntries.some((entry) => entry.locale !== locale)) {
    conflictError('CHANGELOG current-version entry has the wrong locale for this target', {
      reason: 'CURRENT_ENTRY_WRONG_LOCALE',
      version,
      locale,
    });
  }
  const exactEntries = sameVersionEntries.filter((entry) => entry.locale === locale);
  if (exactEntries.length > 1) {
    conflictError('CHANGELOG contains duplicate current-version managed entries', {
      reason: 'DUPLICATE_CURRENT_ENTRY',
      version,
      locale,
      count: exactEntries.length,
    });
  }
  const current = exactEntries.length === 1 ? exactEntries[0] : null;

  // Same-version heading scan: every `## [version]` line outside the
  // current managed entry span indicates a human or ambiguous conflict.
  const headingPrefix = `## [${version}]`;
  let outsideHeadings = 0;
  for (const line of lines) {
    if (!line.text.startsWith(headingPrefix)) continue;
    const insideCurrent =
      current !== null && line.byteStart >= current.start && line.byteStart < current.end;
    if (!insideCurrent) outsideHeadings += 1;
  }

  // Canonical entry bytes (baseline binds the body between the comments).
  const bodyLines = renderBodyLines({ summary, changes, upgradeNotes }, locale, version, date);
  const canonicalBody = bodyLines.join(eol);
  const baseline = sha256Hex(canonicalBody);
  const startMarker =
    `<!-- release-skill:changelog:start version=${version} locale=${locale} baseline=sha256:${baseline} -->`;
  const endMarker = `<!-- release-skill:changelog:end version=${version} locale=${locale} -->`;
  const entryBytes = Buffer.from(`${startMarker}${eol}${canonicalBody}${eol}${endMarker}`, 'utf8');

  let out;
  let change;
  if (current === null) {
    if (outsideHeadings === 1) {
      conflictError('CHANGELOG has an unmanaged heading for the current version', {
        reason: 'UNMANAGED_CURRENT_HEADING',
        version,
        locale,
      });
    }
    if (outsideHeadings >= 2) {
      conflictError('CHANGELOG has multiple headings for the current version', {
        reason: 'MULTIPLE_CURRENT_HEADINGS',
        version,
        locale,
        count: outsideHeadings,
      });
    }
    // Insert: one blank line, the managed entry, one blank line — right
    // after the H1 line. Every other byte is preserved by slicing.
    const insertAt = h1.terminated ? h1.byteStart + h1.byteLen + eolByteLen : input.length;
    const terminator = h1.terminated ? '' : eol;
    const insertion = Buffer.from(
      `${terminator}${eol}${startMarker}${eol}${canonicalBody}${eol}${endMarker}${eol}${eol}`,
      'utf8',
    );
    out = Buffer.concat([input.subarray(0, insertAt), insertion, input.subarray(insertAt)]);
    change = 'insert';
  } else {
    if (outsideHeadings >= 1) {
      conflictError('CHANGELOG has multiple headings for the current version', {
        reason: 'MULTIPLE_CURRENT_HEADINGS',
        version,
        locale,
        count: outsideHeadings + 1,
      });
    }
    // Baseline verification: bytes between the comments are exactly
    // EOL + canonical body + EOL; the body digest must match the marker.
    const between = input.subarray(current.bodyStart, current.bodyEnd);
    const eolBuf = Buffer.from(eol, 'utf8');
    let candidate = null;
    if (
      between.length >= 2 * eolBuf.length &&
      between.subarray(0, eolBuf.length).equals(eolBuf) &&
      between.subarray(between.length - eolBuf.length).equals(eolBuf)
    ) {
      candidate = between.subarray(eolBuf.length, between.length - eolBuf.length);
    }
    const digest = candidate === null ? null : sha256Hex(candidate);
    if (digest !== current.baseline) {
      conflictError('CHANGELOG current-version entry was modified by hand (baseline mismatch)', {
        reason: 'BASELINE_MISMATCH',
        version,
        locale,
      });
    }
    const oldSpan = input.subarray(current.start, current.end);
    change = oldSpan.equals(entryBytes) ? 'none' : 'update';
    out = Buffer.concat([input.subarray(0, current.start), entryBytes, input.subarray(current.end)]);
  }

  const changed = !input.equals(out);

  return deepFreeze({
    kind: 'changelog',
    locale,
    version,
    date,
    categories,
    changed,
    change,
    bytes: out,
  });
}
