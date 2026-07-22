/**
 * Pure parser for the structured release-notes source
 * (2026-07-21-release-docs-refresh-protocol §3).
 *
 * `parseReleaseNotes(bytes, options)` maps YAML and JSON bytes to one closed
 * canonical model. It is a pure function: no file reads, no network, no
 * subprocesses. It fails closed on:
 *
 * - oversized input (`maxBytes`, default 1 MiB), empty input;
 * - invalid UTF-8, NUL bytes, BOM;
 * - JSON duplicate keys (strict scanner; escape-form aware) and YAML
 *   duplicate keys;
 * - YAML anchors, aliases, merge keys (`<<`), explicit/custom tags,
 *   non-scalar keys, and multi-document streams;
 * - unknown fields at every level of the closed data model;
 * - version drift versus `expectedVersion`, malformed `YYYY-MM-DD` dates
 *   (including impossible calendar dates such as 2026-02-30);
 * - extra locales, empty summaries, unknown change categories, empty or
 *   non-string change entries, no non-empty category, empty upgradeNotes.
 *
 * Missing configured locales throw the stable code
 * `RELEASE_DOCS_TRANSLATION_MISSING` naming the missing locales precisely;
 * content is never substituted from another locale. All other violations
 * throw `RELEASE_DOCS_INVALID` with a machine-readable `details.reason`.
 * Error details never carry note body text.
 *
 * @module src/docs/notes
 */

import YAML from 'yaml';
import {
  ReleaseError,
  RELEASE_DOCS_INVALID,
  RELEASE_DOCS_TRANSLATION_MISSING,
} from '../core/errors.mjs';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Fixed change-category set, in the stable output order (protocol §3). */
export const RELEASE_NOTES_CATEGORIES = Object.freeze([
  'security',
  'breaking',
  'added',
  'changed',
  'deprecated',
  'removed',
  'fixed',
]);

/** Default notes-source size limit (1 MiB). */
export const DEFAULT_MAX_NOTES_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const CATEGORY_SET = new Set(RELEASE_NOTES_CATEGORIES);
const ROOT_KEYS = new Set(['version', 'date', 'locales']);
const ENTRY_KEYS = new Set(['summary', 'changes', 'upgradeNotes']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SUPPORTED_FORMATS = new Set(['yaml', 'yml', 'json']);

// ---------------------------------------------------------------------------
// Error helpers (details must never include note body text)
// ---------------------------------------------------------------------------

function invalid(reason, message, details = {}) {
  throw new ReleaseError(RELEASE_DOCS_INVALID, message, { reason, ...details });
}

function translationMissing(missingLocales) {
  throw new ReleaseError(
    RELEASE_DOCS_TRANSLATION_MISSING,
    `release notes are missing configured locales: ${missingLocales.join(', ')}`,
    { reason: 'MISSING_LOCALE', locales: missingLocales },
  );
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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

/**
 * Validate a YYYY-MM-DD string against the real calendar
 * (rejects e.g. 2026-02-30, which YAML/JS would silently roll over).
 * @param {string} text
 * @returns {boolean}
 */
function isValidCalendarDate(text) {
  if (!DATE_PATTERN.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Normalise a parsed `date` value to a strict YYYY-MM-DD string.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeDate(value) {
  if (typeof value === 'string') {
    if (isValidCalendarDate(value)) return value;
    invalid('INVALID_DATE', 'release notes date must be a YYYY-MM-DD calendar date', { date: value });
  }
  if (value instanceof Date) {
    // YAML 1.1-style timestamp resolution: accept only exact UTC midnight.
    let iso;
    try {
      iso = value.toISOString();
    } catch {
      invalid('INVALID_DATE', 'release notes date is not a representable date', {});
    }
    if (!iso.endsWith('T00:00:00.000Z')) {
      invalid('INVALID_DATE', 'release notes date must be a YYYY-MM-DD calendar date', {});
    }
    const text = iso.slice(0, 10);
    if (!isValidCalendarDate(text)) {
      invalid('INVALID_DATE', 'release notes date must be a YYYY-MM-DD calendar date', { date: text });
    }
    return text;
  }
  return invalid('INVALID_DATE', 'release notes date must be a YYYY-MM-DD string', {});
}

// ---------------------------------------------------------------------------
// YAML strictness: AST walk
// ---------------------------------------------------------------------------

/**
 * Walk a YAML AST and collect security/strictness violations.
 * Violation kinds: 'alias', 'merge', 'anchor', 'tag', 'complex-key'.
 *
 * @param {import('yaml').Node | null | undefined} node
 * @param {Set<string>} found
 */
function collectYamlViolations(node, found) {
  if (node === null || node === undefined || typeof node !== 'object') return;

  if (node.constructor?.name === 'Alias' || node.type === 'ALIAS') {
    found.add('alias');
    return;
  }
  if (node.anchor !== undefined) found.add('anchor');
  if (node.tag !== undefined) found.add('tag');

  if (node.items && Array.isArray(node.items)) {
    for (const item of node.items) {
      if (item && typeof item === 'object' && 'key' in item) {
        // Pair inside a map.
        const key = item.key;
        if (key && typeof key === 'object') {
          const isScalarKey = key.type === 'SCALAR' || key.constructor?.name === 'Scalar';
          if (!isScalarKey) {
            found.add('complex-key');
          } else if (key.value === '<<') {
            found.add('merge');
          } else if (typeof key.value !== 'string') {
            found.add('complex-key');
          }
        } else if (typeof key !== 'string') {
          found.add('complex-key');
        } else if (key === '<<') {
          found.add('merge');
        }
        collectYamlViolations(key, found);
        collectYamlViolations(item.value, found);
      } else {
        // Bare node inside a sequence.
        collectYamlViolations(item, found);
      }
    }
  }
}

const YAML_VIOLATION_ORDER = [
  ['alias', 'ALIAS', 'YAML aliases are not allowed in release notes'],
  ['merge', 'MERGE_KEY', 'YAML merge keys (<<) are not allowed in release notes'],
  ['anchor', 'ANCHOR', 'YAML anchors are not allowed in release notes'],
  ['tag', 'CUSTOM_TAG', 'explicit or custom YAML tags are not allowed in release notes'],
  ['complex-key', 'COMPLEX_KEY', 'non-scalar or non-string YAML keys are not allowed in release notes'],
];

/**
 * Parse YAML text strictly into a plain object.
 * @param {string} text
 * @returns {unknown}
 */
function parseStrictYaml(text) {
  const docs = YAML.parseAllDocuments(text, { uniqueKeys: true, merge: false });
  if (docs.length === 0) {
    invalid('EMPTY_SOURCE', 'release notes source is empty', {});
  }
  if (docs.length > 1) {
    invalid('MULTI_DOCUMENT', 'release notes must contain exactly one YAML document', { documents: docs.length });
  }
  const doc = docs[0];

  const duplicate = doc.errors.find((err) => err.message && err.message.includes('unique'));
  if (duplicate) {
    invalid('DUPLICATE_KEY', 'duplicate keys are not allowed in release notes', {
      line: duplicate.line ?? null,
    });
  }
  if (doc.errors.length > 0) {
    invalid('PARSE_FAILED', 'release notes YAML cannot be parsed', {
      line: doc.errors[0].line ?? null,
    });
  }
  if (!doc.contents) {
    invalid('EMPTY_SOURCE', 'release notes source is empty', {});
  }

  const violations = new Set();
  collectYamlViolations(doc.contents, violations);
  for (const [kind, reason, message] of YAML_VIOLATION_ORDER) {
    if (violations.has(kind)) invalid(reason, message, {});
  }

  return doc.toJS();
}

// ---------------------------------------------------------------------------
// JSON strictness: syntax + duplicate-key scanner
// ---------------------------------------------------------------------------

/**
 * Scan valid JSON text for duplicate object keys.
 *
 * Assumes `text` has already passed `JSON.parse`, so the grammar is valid;
 * the scanner only tracks container scopes and string tokens. Keys are
 * decoded (escape-aware) before comparison so `"a"` and `"a"` collide.
 *
 * @param {string} text
 */
function assertJsonNoDuplicateKeys(text) {
  const scopes = []; // Set<string> for objects, null for arrays
  const length = text.length;
  let i = 0;
  while (i < length) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      i += 1;
      while (i < length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '"') break;
        i += 1;
      }
      const raw = text.slice(start, i + 1);
      i += 1;
      // A string followed by ':' inside an object scope is a key.
      let k = i;
      while (k < length && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n' || text[k] === '\r')) k += 1;
      if (text[k] === ':' && scopes.length > 0 && scopes[scopes.length - 1] !== null) {
        let key = raw;
        try { key = JSON.parse(raw); } catch { /* valid JSON guarantees success */ }
        const set = scopes[scopes.length - 1];
        if (set.has(key)) {
          invalid('DUPLICATE_KEY', 'duplicate keys are not allowed in release notes', { key });
        }
        set.add(key);
      }
      continue;
    }
    if (c === '{') { scopes.push(new Set()); i += 1; continue; }
    if (c === '}') { scopes.pop(); i += 1; continue; }
    if (c === '[') { scopes.push(null); i += 1; continue; }
    if (c === ']') { scopes.pop(); i += 1; continue; }
    i += 1;
  }
}

/**
 * Parse JSON text strictly into a plain object.
 * @param {string} text
 * @returns {unknown}
 */
function parseStrictJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid('PARSE_FAILED', 'release notes JSON cannot be parsed', {});
  }
  assertJsonNoDuplicateKeys(text);
  return parsed;
}

// ---------------------------------------------------------------------------
// Closed data-model validation
// ---------------------------------------------------------------------------

/**
 * Validate one locale entry and build its canonical form.
 *
 * @param {unknown} entry
 * @param {string} locale
 * @returns {{ summary: string, changes: object, upgradeNotes?: string }}
 */
function normalizeLocaleEntry(entry, locale) {
  if (!isPlainObject(entry)) {
    invalid('ENTRY_NOT_OBJECT', `release notes locale entry must be a mapping`, { locale });
  }
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) {
      invalid('UNKNOWN_FIELD', `unknown field in release notes locale entry`, { locale, field: key });
    }
  }
  for (const key of ['summary', 'changes']) {
    if (!Object.hasOwn(entry, key)) {
      invalid('MISSING_FIELD', `release notes locale entry missing required field`, { locale, field: key });
    }
  }

  // summary
  const { summary } = entry;
  if (typeof summary !== 'string') {
    invalid('INVALID_SUMMARY', 'release notes summary must be a string', { locale });
  }
  const trimmedSummary = summary.trim();
  if (trimmedSummary.length === 0) {
    invalid('EMPTY_SUMMARY', 'release notes summary must not be empty', { locale });
  }

  // changes
  const { changes } = entry;
  if (!isPlainObject(changes)) {
    invalid('CHANGES_NOT_OBJECT', 'release notes changes must be a mapping of categories', { locale });
  }
  const canonicalChanges = {};
  let totalEntries = 0;
  for (const category of RELEASE_NOTES_CATEGORIES) {
    if (!Object.hasOwn(changes, category)) continue;
    const items = changes[category];
    if (!Array.isArray(items)) {
      invalid('CHANGES_CATEGORY_NOT_ARRAY', 'release notes change category must be an array', { locale, category });
    }
    const trimmedItems = [];
    for (const item of items) {
      if (typeof item !== 'string') {
        invalid('INVALID_CHANGE_ENTRY', 'release notes change entries must be strings', { locale, category });
      }
      const trimmed = item.trim();
      if (trimmed.length === 0) {
        invalid('EMPTY_CHANGE_ENTRY', 'release notes change entries must not be empty', { locale, category });
      }
      trimmedItems.push(trimmed);
    }
    totalEntries += trimmedItems.length;
    if (trimmedItems.length > 0) canonicalChanges[category] = trimmedItems;
  }
  for (const key of Object.keys(changes)) {
    if (!CATEGORY_SET.has(key)) {
      invalid('UNKNOWN_CATEGORY', 'release notes contain an unknown change category', { locale, category: key });
    }
  }
  if (totalEntries === 0) {
    invalid('EMPTY_CHANGES', 'release notes must contain at least one non-empty change category', { locale });
  }

  const canonical = { summary: trimmedSummary, changes: canonicalChanges };

  // upgradeNotes (optional)
  if (Object.hasOwn(entry, 'upgradeNotes')) {
    const { upgradeNotes } = entry;
    if (typeof upgradeNotes !== 'string') {
      invalid('INVALID_UPGRADE_NOTES', 'release notes upgradeNotes must be a string', { locale });
    }
    const trimmedNotes = upgradeNotes.trim();
    if (trimmedNotes.length === 0) {
      invalid('EMPTY_UPGRADE_NOTES', 'release notes upgradeNotes must not be empty when present', { locale });
    }
    canonical.upgradeNotes = trimmedNotes;
  }

  return canonical;
}

/**
 * Validate the parsed plain-object model and build the canonical form.
 *
 * @param {unknown} root
 * @param {{ expectedVersion: string, locales: string[] }} options
 * @returns {object} canonical notes object (not yet frozen)
 */
function validateNotesModel(root, { expectedVersion, locales }) {
  if (!isPlainObject(root)) {
    invalid('ROOT_NOT_OBJECT', 'release notes root must be a mapping', {});
  }
  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.has(key)) {
      invalid('UNKNOWN_FIELD', 'unknown field in release notes root', { field: key });
    }
  }
  for (const key of ROOT_KEYS) {
    if (!Object.hasOwn(root, key)) {
      invalid('MISSING_FIELD', 'release notes missing required field', { field: key });
    }
  }

  // version: exact match against the expected version; never coerced.
  const { version } = root;
  if (typeof version !== 'string' || version.length === 0) {
    invalid('INVALID_VERSION', 'release notes version must be a non-empty string', {});
  }
  if (version !== expectedVersion) {
    invalid('VERSION_MISMATCH', 'release notes version does not match the expected version', {
      expected: expectedVersion,
      actual: version,
    });
  }

  // date: strict YYYY-MM-DD.
  const date = normalizeDate(root.date);

  // locales map: exactly the configured set; missing locales are precise
  // translation failures, never substituted.
  const localesMap = root.locales;
  if (!isPlainObject(localesMap)) {
    invalid('LOCALES_NOT_OBJECT', 'release notes locales must be a mapping keyed by locale', {});
  }
  const expectedSet = new Set(locales);
  for (const key of Object.keys(localesMap)) {
    if (!expectedSet.has(key)) {
      invalid('EXTRA_LOCALE', 'release notes contain a locale that is not configured', { locale: key });
    }
  }
  const missing = locales.filter((locale) => !Object.hasOwn(localesMap, locale));
  if (missing.length > 0) {
    translationMissing(missing);
  }

  const canonicalLocales = {};
  for (const locale of locales) {
    canonicalLocales[locale] = normalizeLocaleEntry(localesMap[locale], locale);
  }

  return { version, date, locales: canonicalLocales };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse structured release-notes bytes into the closed canonical model.
 *
 * Pure function: no file reads, no network, no subprocesses.
 *
 * @param {Uint8Array} bytes  Raw source bytes (YAML or JSON).
 * @param {object} options
 * @param {string} options.format  One of 'yaml', 'yml', 'json'.
 * @param {string} options.expectedVersion  Exact version the notes must declare.
 * @param {string[]} options.locales  Configured locales; each must appear exactly once.
 * @param {number} [options.maxBytes]  Input size limit (default 1 MiB).
 * @returns {Readonly<{
 *   version: string,
 *   date: string,
 *   locales: Record<string, {
 *     summary: string,
 *     changes: Record<string, readonly string[]>,
 *     upgradeNotes?: string,
 *   }>,
 * }>} deeply frozen canonical notes object
 * @throws {ReleaseError} RELEASE_DOCS_INVALID on structural/semantic violations;
 *   RELEASE_DOCS_TRANSLATION_MISSING when a configured locale is absent.
 */
export function parseReleaseNotes(bytes, options = {}) {
  // --- Options validation ---
  const { format, expectedVersion, locales } = options;
  if (!SUPPORTED_FORMATS.has(format)) {
    invalid('UNSUPPORTED_FORMAT', 'release notes format must be one of: yaml, yml, json', { format: String(format) });
  }
  if (typeof expectedVersion !== 'string' || expectedVersion.length === 0) {
    invalid('INVALID_OPTIONS', 'expectedVersion must be a non-empty string', {});
  }
  if (!Array.isArray(locales) || locales.length === 0) {
    invalid('INVALID_OPTIONS', 'locales must be a non-empty array', {});
  }
  const localeSet = new Set();
  for (const locale of locales) {
    if (typeof locale !== 'string' || locale.length === 0) {
      invalid('INVALID_OPTIONS', 'locale identifiers must be non-empty strings', {});
    }
    if (localeSet.has(locale)) {
      invalid('INVALID_OPTIONS', 'locale identifiers must be unique', { locale });
    }
    localeSet.add(locale);
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_NOTES_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    invalid('INVALID_OPTIONS', 'maxBytes must be a positive integer', {});
  }

  // --- Byte-level checks ---
  if (!(bytes instanceof Uint8Array)) {
    invalid('INVALID_OPTIONS', 'bytes must be a Uint8Array/Buffer', {});
  }
  if (bytes.length === 0) {
    invalid('EMPTY_SOURCE', 'release notes source is empty', {});
  }
  if (bytes.length > maxBytes) {
    invalid('INPUT_TOO_LARGE', 'release notes source exceeds the size limit', {
      size: bytes.length,
      maxBytes,
    });
  }

  let text;
  try {
    // ignoreBOM: true keeps a leading BOM in the decoded text so the strict
    // BOM check below can reject it (the decoder would strip it by default).
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    invalid('NOT_UTF8', 'release notes source is not valid UTF-8', {});
  }
  if (text.charCodeAt(0) === 0xfeff) {
    invalid('BOM', 'release notes source must not start with a byte order mark', {});
  }
  if (text.includes('\0')) {
    invalid('NUL_BYTE', 'release notes source must not contain NUL bytes', {});
  }

  // --- Format-specific strict parsing ---
  const parsed = format === 'json' ? parseStrictJson(text) : parseStrictYaml(text);

  // --- Closed data-model validation + canonicalization ---
  const canonical = validateNotesModel(parsed, { expectedVersion, locales: [...localeSet] });
  return deepFreeze(canonical);
}
