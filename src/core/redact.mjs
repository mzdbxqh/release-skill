/**
 * Centralized redaction of sensitive filesystem paths in error outputs.
 *
 * Defect #3 fix: runtime error outputs (CLI text/JSON output and details
 * structures) must never carry absolute filesystem paths (the macOS Users
 * realm, the Linux home realm, the macOS private/var alias realm, temp
 * roots, tmpdir fixture roots). This module is the single redaction
 * authority consumed by the ReleaseError constructor choke point
 * (core/errors.mjs); producers may also apply it defense-in-depth.
 *
 * Semantics:
 * - Strings: tokens shaped like real absolute paths are replaced with the
 *   stable placeholder `<redacted-path>`. Three families are redacted
 *   fail-closed:
 *   (1) POSIX absolute paths (leading '/', at least two path segments) —
 *       unless the token classifies as a strict RFC 6901 JSON Pointer;
 *   (2) Windows drive-letter paths (X:\... and X:/...);
 *   (3) UNC paths (\\server\share...).
 *   Strict JSON Pointers (e.g. /frozenSnapshot/commitTimestamp,
 *   /units/0/version) are stable diagnostic coordinates, not filesystem
 *   paths, and are preserved verbatim. Relative fragments (no leading '/'),
 *   flag tokens (--unit), reason vocabulary (MISSING_VALUE), error codes,
 *   sha256 digests, stable field names, and fragment-anchored JSON pointers
 *   (#/required) are likewise preserved verbatim. Any other two-or-more
 *   segment '/'-led token stays redacted as the fail-closed default.
 * - Arrays and plain objects: recursed; every string value is redacted.
 * - Everything else (numbers, booleans, null, undefined, and non-plain
 *   objects such as Buffers/Dates/Maps) is returned untouched.
 *
 * Pure and zero-dependency: no imports from src/artifacts/* (no cycles, no
 * cross-layer coupling); node built-ins only (none required).
 *
 * @module core/redact
 */

/** Stable placeholder substituted for every redacted absolute path. */
export const REDACTED_PATH_PLACEHOLDER = '<redacted-path>';

// Absolute-path tokens. Three families, tried in order at each anchor point:
// (a) Windows drive-letter paths (C:\... or C:/...) — ordered before the
//     POSIX alternative so a drive-letter token reaching into the Users
//     realm collapses to a single placeholder instead of leaving a 'C:'
//     prefix behind;
// (b) UNC paths (\\server\share...);
// (c) POSIX absolute paths: a '/' anchored at the start of the string or
//     preceded by a delimiter (whitespace, quote, '=', ':', ',', '(', '[',
//     '{', '<'), running until whitespace or a quote. The left boundary keeps
//     redaction from firing inside relative fragments ('src/core/x.mjs'),
//     fragment-anchored JSON pointers ('#/required'), or protocol-relative
//     URLs ('https://x/y').
const PATH_TOKEN_RE =
  /(?<=^|[\s'"=:,([{<])(?:[A-Za-z]:[\\/][^\s'"]*|\\\\[^\s'"]+|\/[^\s'"]+)/g;

// Trailing prose punctuation that may cling to a token and must survive.
const TRAILING_PUNCT_RE = /^(.*?)([.!,;:)\]}>]*)$/;

// Filesystem root directories that mark a '/'-led token as a real absolute
// path even when every segment is identifier-shaped (e.g. a temp-root or
// Users-realm path whose segments are all plain identifiers): the Unix FHS
// hierarchy, macOS realms, and common ephemeral/CI checkout roots.
// Fail-closed backstop under the JSON Pointer classifier.
const KNOWN_FS_ROOTS = new Set([
  // Unix/Linux FHS
  'bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib64', 'media', 'mnt',
  'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var',
  // macOS realms
  'Applications', 'Library', 'Network', 'System', 'Users', 'Volumes',
  'cores', 'private',
  // common ephemeral / CI checkout roots
  'app', 'build', 'data', 'dist', 'workspace', 'workspaces',
]);

// Strict RFC 6901 reference-token shapes as used by diagnostic JSON Pointers
// in this system: identifier-like property names and array indexes (no
// leading zeros, per RFC 6901 array indexing).
const POINTER_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const POINTER_INDEX_RE = /^(?:0|[1-9][0-9]*)$/;

// JSON Pointer syntax and POSIX absolute-path syntax overlap. Preserve only
// the diagnostic pointer roots emitted by the plan/unit validators that need
// stable public diagnostics. A broad camelCase/array-index heuristic would
// incorrectly disclose real paths such as a custom mount with identifier-like
// segments, violating the fail-closed contract.
const DIAGNOSTIC_POINTER_ROOTS = new Set([
  'frozenSnapshot',
  'units',
]);

/**
 * Classify a '/'-led, >= 2-segment token as a strict RFC 6901 JSON Pointer
 * (a stable diagnostic coordinate such as /units/0/frozenSnapshot/commitTimestamp
 * or /frozenSnapshot/commitTimestamp) rather than a filesystem path.
 *
 * Conservative by design (fail-closed): the token qualifies only when its
 * first segment belongs to an explicit diagnostic namespace and every segment
 * is an identifier-like reference token or array index. Any other
 * two-or-more-segment token is treated as a path and redacted.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isStrictJsonPointer(token) {
  const segments = token.slice(1).split('/');
  if (segments.length < 2) return false;
  if (KNOWN_FS_ROOTS.has(segments[0])) return false;
  if (!DIAGNOSTIC_POINTER_ROOTS.has(segments[0])) return false;
  for (const segment of segments) {
    if (!POINTER_INDEX_RE.test(segment) && !POINTER_IDENTIFIER_RE.test(segment)) {
      // Dots (file extensions), hyphens, tildes, escapes, empty segments:
      // not a strict diagnostic pointer — fall back to path redaction.
      return false;
    }
  }
  return true;
}

/**
 * Whether a token looks like a POSIX absolute path with >= 2 segments
 * (e.g. a Users-realm path, a private/var-folders path, or a temp-root
 * path) that is NOT a strict JSON Pointer. Single-segment tokens such as
 * '/tmp', schema instance fragments such as '/:', and strict JSON Pointers
 * such as '/frozenSnapshot/commitTimestamp' are left alone.
 *
 * @param {string} token
 * @returns {boolean}
 */
function looksLikeAbsolutePath(token) {
  if (typeof token !== 'string' || token.length < 3) return false;
  if (!token.startsWith('/') || token.startsWith('//')) return false;
  if (!token.slice(1).includes('/')) return false;
  return !isStrictJsonPointer(token);
}

/**
 * Whether a token is a Windows drive-letter absolute path (X:\... or X:/...).
 * Drive-letter tokens are unambiguously filesystem paths and always redact.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isWindowsDrivePath(token) {
  return /^[A-Za-z]:[\\/]/.test(token);
}

/**
 * Whether a token is a UNC path (\\server\share...). UNC tokens are
 * unambiguously filesystem paths and always redact.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isUncPath(token) {
  return token.startsWith('\\\\');
}

/**
 * Replace absolute-path tokens in a string with the redaction placeholder.
 *
 * @param {string} input
 * @returns {string}
 */
function redactString(input) {
  return input.replace(PATH_TOKEN_RE, (raw) => {
    const match = TRAILING_PUNCT_RE.exec(raw);
    const core = match[1];
    const tail = match[2];
    if (isWindowsDrivePath(core) || isUncPath(core) || looksLikeAbsolutePath(core)) {
      return `${REDACTED_PATH_PLACEHOLDER}${tail}`;
    }
    return raw;
  });
}

/**
 * Deep-redact sensitive absolute paths from any error-output value.
 *
 * Strings have absolute-path tokens replaced with `<redacted-path>`;
 * arrays and plain objects are recursed; all other values (numbers,
 * booleans, null, undefined, and non-plain objects such as Buffers, Dates,
 * Maps, Sets, or Error instances) are returned untouched.
 *
 * @param {unknown} value — message string, details object, or nested value.
 * @returns {unknown} Redacted copy (plain objects/arrays are rebuilt;
 *   scalars and non-plain objects pass through).
 */
export function redactSensitivePaths(value) {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactSensitivePaths);
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      // Buffer, TypedArray, Date, Map, Set, class instances: leave untouched.
      return value;
    }
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = redactSensitivePaths(val);
    }
    return out;
  }
  return value;
}
