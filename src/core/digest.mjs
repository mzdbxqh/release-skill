/**
 * Deterministic canonical JSON serialisation and SHA-256 digest.
 *
 * `canonicalJson` recursively sorts object keys (deep-first) while preserving
 * array element order, then serialises the result as a UTF-8 JSON string.
 * Two objects with the same logical content but different key insertion order
 * always produce the identical output.
 *
 * `sha256Hex` computes the SHA-256 hash of a UTF-8 string (or Buffer) and
 * returns the lowercase hex encoding.
 *
 * @module digest
 */

import { createHash } from 'node:crypto';

/**
 * Recursively sort every object key in depth-first order and serialise as
 * a deterministic UTF-8 JSON string.
 *
 * Rules:
 * - Object keys are sorted lexicographically (same order as `Array.sort()`).
 * - Array element order is preserved.
 * - Primitives (`null`, booleans, numbers, strings) pass through unchanged.
 * - `undefined` values in objects are omitted (matching `JSON.stringify`).
 * - `undefined` values inside arrays become `null` (matching `JSON.stringify`).
 * - `BigInt` values throw (matching `JSON.stringify`).
 * - `Date` objects are serialised via `.toISOString()` (matching
 *   `JSON.stringify`).
 *
 * @param {*} obj - Any JSON-serialisable value.
 * @returns {string} A UTF-8 JSON string whose key ordering is deterministic.
 */
export function canonicalJson(obj) {
  return JSON.stringify(canonicalise(obj));
}

/**
 * Compute the SHA-256 digest of a UTF-8 string or Buffer.
 *
 * @param {string | Buffer} input - The data to hash.
 * @returns {string} Lowercase hexadecimal SHA-256 digest (64 hex chars).
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

// ---- internal helpers (not exported) ----

/**
 * Deep-clone a value while sorting all object keys lexicographically.
 *
 * @param {*} value
 * @returns {*}
 */
function canonicalise(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalise(item));
  }

  // Date gets its own branch so we can call toISOString() before the
  // typeof === 'object' check swallows it.
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Buffer gets its own branch: toJSON() returns {type:'Buffer', data:[...]}
  // which matches JSON.stringify and survives a JSON roundtrip.
  if (Buffer.isBuffer(value)) {
    return canonicalise(value.toJSON());
  }

  if (typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      // Skip undefined object properties (mirrors JSON.stringify behaviour).
      if (v === undefined) continue;
      sorted[key] = canonicalise(v);
    }
    return sorted;
  }

  // Primitives: string, number, boolean, null.
  return value;
}
