/**
 * JSON/JSONC format-preserving three-way merge.
 *
 * Locates target values by JSON Pointer in the raw byte stream and performs
 * minimal byte-range replacements.  Comments, key order, and untouched
 * whitespace are preserved byte-for-byte from the current side.
 *
 * For arrays with an identity key, elements are matched by that key and
 * merged per-element.  Without an identity key, two-side array modifications
 * are always CONFLICT (fail closed).
 *
 * No full-file parse or stringify is ever performed.
 *
 * @module artifacts/merge/json
 */

import { mergeText } from './text.mjs';

// ---------------------------------------------------------------------------
// JSONC-aware byte scanner
// ---------------------------------------------------------------------------

/**
 * Strip // and /* comments from a JSONC buffer, returning a clean JSON
 * buffer suitable for JSON.parse.  This is only used for structural
 * analysis — the original bytes are used for all output.
 *
 * @param {Buffer} buf
 * @returns {string}
 */
function stripJsoncComments(buf) {
  const text = buf.toString('utf8');
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '/' && i + 1 < text.length) {
      if (text[i + 1] === '/') {
        // Line comment — skip to end of line
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (text[i + 1] === '*') {
        // Block comment — skip to */
        i += 2;
        while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2; // skip */
        continue;
      }
    }
    if (text[i] === '"') {
      // String literal — copy verbatim including escapes
      out.push(text[i]);
      i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          out.push(text[i], text[i + 1] ?? '');
          i += 2;
          continue;
        }
        out.push(text[i]);
        if (text[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    out.push(text[i]);
    i++;
  }
  return out.join('');
}

/**
 * Try to parse JSONC content, returning the parsed value or null on failure.
 *
 * @param {Buffer} buf
 * @returns {*|null}
 */
function tryParseJsonc(buf) {
  try {
    return JSON.parse(stripJsoncComments(buf));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSONC-aware byte-range scanner
// ---------------------------------------------------------------------------

/**
 * Skip whitespace and // or /* comments from `src` starting at offset `i`.
 * Returns the new offset past whitespace and comments.
 *
 * @param {string} src
 * @param {number} i
 * @returns {number}
 */
function skipWsAndComments(src, i) {
  while (i < src.length) {
    // Skip whitespace
    if (/\s/.test(src[i])) { i++; continue; }
    // Skip // line comment
    if (src[i] === '/' && i + 1 < src.length && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    // Skip /* block comment */
    if (src[i] === '/' && i + 1 < src.length && src[i + 1] === '*') {
      i += 2;
      while (i + 1 < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Decode a single JSON Pointer component per RFC 6901.
 * ~1 → /  and  ~0 → ~
 *
 * @param {string} part
 * @returns {string}
 */
function decodePointerPart(part) {
  return part.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Find the byte range [start, end) of the value at a given JSON Pointer
 * path in the raw source.
 *
 * Uses a comment-aware brace/bracket-depth scanner that tracks strings and
 * escapes.  Returns null if the path is not found.
 *
 * @param {string} src - Source text (utf8 string)
 * @param {string} pointer - JSON Pointer (e.g. "/scripts/build")
 * @returns {{ start: number, end: number }|null}
 */
function locatePointer(src, pointer) {
  if (pointer === '') {
    return findValueRange(src, 0);
  }

  const parts = pointer.split('/').filter(Boolean);
  let pos = 0;

  for (let depth = 0; depth < parts.length; depth++) {
    const part = decodePointerPart(parts[depth]);
    const container = findValueRange(src, pos);
    if (!container) return null;
    const containerSrc = src.substring(container.start, container.end);

    if (containerSrc[0] === '{') {
      const memberRange = findObjectMember(src, container.start, part);
      if (!memberRange) return null;
      if (depth === parts.length - 1) {
        return memberRange.valueRange;
      }
      pos = memberRange.valueRange.start;
    } else if (containerSrc[0] === '[') {
      const index = parseInt(part, 10);
      if (Number.isNaN(index)) return null;
      const elementRange = findArrayElement(src, container.start, index);
      if (!elementRange) return null;
      if (depth === parts.length - 1) {
        return elementRange;
      }
      pos = elementRange.start;
    } else {
      return null;
    }
  }
  return null;
}

/**
 * Find the byte range of the JSON value starting at or after `offset`.
 * Comment-aware: skips // and /* comments as whitespace.
 *
 * @param {string} src
 * @param {number} offset
 * @returns {{ start: number, end: number }|null}
 */
function findValueRange(src, offset) {
  let i = skipWsAndComments(src, offset);
  if (i >= src.length) return null;

  const start = i;
  const ch = src[i];

  if (ch === '"') {
    // String — find closing quote
    i++;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '"') { i++; return { start, end: i }; }
      i++;
    }
    return null;
  }

  if (ch === '{' || ch === '[') {
    // Object or array — track depth, comment-aware
    const open = ch;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    while (i < src.length) {
      if (inString) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '"') inString = false;
        i++;
        continue;
      }
      // Skip comments when not inside a string
      if (src[i] === '/' && i + 1 < src.length && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (src[i] === '/' && i + 1 < src.length && src[i + 1] === '*') {
        i += 2;
        while (i + 1 < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (src[i] === '"') { inString = true; i++; continue; }
      if (src[i] === open) depth++;
      if (src[i] === close) { depth--; if (depth === 0) { i++; return { start, end: i }; } }
      i++;
    }
    return null;
  }

  // Primitive (number, boolean, null) — scan to next delimiter
  while (i < src.length && /[\w.\-+eE]/.test(src[i])) i++;
  return i > start ? { start, end: i } : null;
}

/**
 * Find a named member value range within an object starting at `objStart`.
 * Comment-aware: skips // and /* comments between tokens.
 *
 * @param {string} src
 * @param {number} objStart - Byte offset of the opening '{'
 * @param {string} key - Member key to find
 * @returns {{ keyRange: { start: number, end: number }, valueRange: { start: number, end: number } }|null}
 */
function findObjectMember(src, objStart, key) {
  let i = objStart + 1; // skip '{'

  while (i < src.length) {
    // Skip whitespace and comments
    i = skipWsAndComments(src, i);
    if (i >= src.length || src[i] === '}') return null;

    // Expect a key (string)
    if (src[i] !== '"') return null;
    const keyStart = i;
    i++;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '"') break;
      i++;
    }
    const keyEnd = i + 1; // include closing quote
    const memberKey = src.substring(keyStart + 1, keyEnd - 1);

    i = keyEnd;
    // Skip whitespace, comments, and colon
    i = skipWsAndComments(src, i);
    if (src[i] !== ':') return null;
    i++; // skip ':'

    // Find value
    const valueRange = findValueRange(src, i);
    if (!valueRange) return null;

    if (memberKey === key) {
      return { keyRange: { start: keyStart, end: keyEnd }, valueRange };
    }

    i = valueRange.end;
    // Skip comma
    i = skipWsAndComments(src, i);
    if (src[i] === ',') i++;
  }

  return null;
}

/**
 * Find the byte range of the nth element in an array starting at `arrStart`.
 * Comment-aware.
 *
 * @param {string} src
 * @param {number} arrStart - Byte offset of the opening '['
 * @param {number} index - Zero-based element index
 * @returns {{ start: number, end: number }|null}
 */
function findArrayElement(src, arrStart, index) {
  let i = arrStart + 1; // skip '['
  let count = 0;

  while (i < src.length) {
    i = skipWsAndComments(src, i);
    if (i >= src.length || src[i] === ']') return null;

    const range = findValueRange(src, i);
    if (!range) return null;

    if (count === index) return range;

    i = range.end;
    count++;
    // Skip comma
    i = skipWsAndComments(src, i);
    if (src[i] === ',') i++;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Identity-keyed array merge
// ---------------------------------------------------------------------------

/**
 * Merge an array at a given pointer using an identity key to match elements.
 *
 * Returns local element edits, CLEAN, or CONFLICT. Structural additions and
 * deletions fail closed until comma-safe insertion/deletion is implemented.
 *
 * @param {string} src - Current side source text
 * @param {string} baseSrc - Base source text
 * @param {string} genSrc - Generated source text
 * @param {string} pointer - JSON Pointer to the array
 * @param {string} identityKey - Key name used to match elements
 * @returns {{ edits: Array<{range:{start:number,end:number},replacement:string}> }|'CLEAN'|'CONFLICT'}
 */
function mergeIdentityKeyedArray(src, baseSrc, genSrc, pointer, identityKey) {
  const currentArr = extractArrayAtPath(src, pointer);
  const baseArr = extractArrayAtPath(baseSrc, pointer);
  const genArr = extractArrayAtPath(genSrc, pointer);

  if (!currentArr || !baseArr || !genArr) return 'CONFLICT';

  const indexByKey = (array) => {
    const result = new Map();
    for (let index = 0; index < array.length; index += 1) {
      const element = array[index];
      if (!element || typeof element !== 'object' || !(identityKey in element)) return null;
      const key = element[identityKey];
      if (result.has(key)) return null;
      result.set(key, { el: element, index });
    }
    return result;
  };
  const baseByKey = indexByKey(baseArr);
  const currentByKey = indexByKey(currentArr);
  const genByKey = indexByKey(genArr);
  if (!baseByKey || !currentByKey || !genByKey) return 'CONFLICT';

  const baseArrayRange = locatePointer(baseSrc, pointer);
  const currentArrayRange = locatePointer(src, pointer);
  const genArrayRange = locatePointer(genSrc, pointer);
  if (!baseArrayRange || !currentArrayRange || !genArrayRange) return 'CONFLICT';

  const allKeys = new Set([...baseByKey.keys(), ...currentByKey.keys(), ...genByKey.keys()]);
  const edits = [];

  for (const key of allKeys) {
    const base = baseByKey.get(key);
    const curr = currentByKey.get(key);
    const gen = genByKey.get(key);

    if (!base && curr && gen) {
      // Both added same key — check if identical
      if (JSON.stringify(curr.el) !== JSON.stringify(gen.el)) return 'CONFLICT';
      // Current already contains the identical addition.
    } else if (!base && curr && !gen) {
      // Preserve a current-only (human) addition.
    } else if (!base && !curr && gen) {
      return 'CONFLICT'; // comma-safe insertion is not implemented
    } else if (base && curr && !gen) {
      if (JSON.stringify(base.el) !== JSON.stringify(curr.el)) return 'CONFLICT';
      return 'CONFLICT'; // comma-safe deletion is not implemented
    } else if (base && !curr && gen) {
      if (JSON.stringify(base.el) !== JSON.stringify(gen.el)) return 'CONFLICT';
      // Human deleted, producer unchanged → accept delete (skip)
    } else if (base && !curr && !gen) {
      // Both deleted — skip
    } else if (base && curr && gen) {
      const currChanged = JSON.stringify(base.el) !== JSON.stringify(curr.el);
      const genChanged = JSON.stringify(base.el) !== JSON.stringify(gen.el);
      if (currChanged && genChanged) {
        if (JSON.stringify(curr.el) !== JSON.stringify(gen.el)) return 'CONFLICT';
      } else if (!currChanged && genChanged) {
        const baseRange = findArrayElement(baseSrc, baseArrayRange.start, base.index);
        const currentRange = findArrayElement(src, currentArrayRange.start, curr.index);
        const generatedRange = findArrayElement(genSrc, genArrayRange.start, gen.index);
        if (!baseRange || !currentRange || !generatedRange) return 'CONFLICT';
        const baseRaw = baseSrc.substring(baseRange.start, baseRange.end);
        const currentRaw = src.substring(currentRange.start, currentRange.end);
        // A formatting/comment-only human delta is still protected.
        if (currentRaw !== baseRaw || rangeContainsComments(src, currentRange.start, currentRange.end)) {
          return 'CONFLICT';
        }
        edits.push({
          range: currentRange,
          replacement: genSrc.substring(generatedRange.start, generatedRange.end),
        });
      }
    }
  }

  return edits.length === 0 ? 'CLEAN' : { edits };
}

/**
 * Extract an array value at a given pointer from source text.
 *
 * @param {string} src
 * @param {string} pointer
 * @returns {Array|null}
 */
function extractArrayAtPath(src, pointer) {
  const parsed = tryParseJsonc(Buffer.from(src, 'utf8'));
  if (!parsed) return null;

  const parts = pointer.split('/').filter(Boolean);
  let value = parsed;
  for (const part of parts) {
    const decoded = decodePointerPart(part);
    if (value == null || typeof value !== 'object') return null;
    value = value[decoded];
  }
  return Array.isArray(value) ? value : null;
}

function valueAtPointer(root, pointer) {
  let value = root;
  for (const part of pointer.split('/').filter(Boolean)) {
    const decoded = decodePointerPart(part);
    if (value == null || typeof value !== 'object' || !(decoded in value)) return undefined;
    value = value[decoded];
  }
  return value;
}

/**
 * Check whether a byte range in source text contains JSONC comments.
 *
 * @param {string} src
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
function rangeContainsComments(src, start, end) {
  let inString = false;
  for (let i = start; i < end; i++) {
    if (inString) {
      if (src[i] === '\\') { i++; continue; }
      if (src[i] === '"') inString = false;
      continue;
    }
    if (src[i] === '"') { inString = true; continue; }
    if (src[i] === '/' && i + 1 < end) {
      if (src[i + 1] === '/' || src[i + 1] === '*') return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge two JSON/JSONC modifications of the same base content.
 *
 * Performs minimal byte-range replacements at the specified JSON Pointers.
 * Comments, key order, and untouched whitespace are preserved from the
 * current side.
 *
 * @param {object} options
 * @param {Buffer} options.base      - Base JSON/JSONC content.
 * @param {Buffer} options.current   - Current (human) JSON/JSONC content.
 * @param {Buffer} options.generated - Generated (producer) JSON/JSONC content.
 * @param {string[]} [options.pointers=[]] - JSON Pointers of values to merge.
 * @param {Record<string,string>} [options.identityKeys={}]
 *   Map of JSON Pointer → identity key name for arrays at that pointer.
 * @returns {{ status: 'MERGEABLE'|'CONFLICT'|'STRUCTURE_INVALID', bytes?: Buffer, conflicts: object[] }}
 */
export function mergeJson({ base, current, generated, pointers = [], identityKeys = {} } = {}) {
  // Null/missing inputs → CONFLICT
  if (!base || !current || !generated) {
    return Object.freeze({
      status: 'CONFLICT',
      bytes: undefined,
      conflicts: Object.freeze([{ reason: 'missing input' }]),
    });
  }

  // Validate all three are parseable JSON(C)
  const baseParsed = tryParseJsonc(base);
  const currentParsed = tryParseJsonc(current);
  const generatedParsed = tryParseJsonc(generated);

  if (baseParsed === null || currentParsed === null || generatedParsed === null) {
    return Object.freeze({
      status: 'STRUCTURE_INVALID',
      bytes: undefined,
      conflicts: Object.freeze([{ reason: 'malformed JSON/JSONC input' }]),
    });
  }

  const src = current.toString('utf8');
  const baseSrc = base.toString('utf8');
  const genSrc = generated.toString('utf8');

  // Collect edits as { range, replacement } sorted by position (descending for safe apply)
  const edits = [];

  for (const pointer of pointers) {
    const idKey = identityKeys[pointer];

    if (idKey) {
      // Identity-keyed array merge
      const result = mergeIdentityKeyedArray(src, baseSrc, genSrc, pointer, idKey);
      if (result === 'CONFLICT') {
        return Object.freeze({
          status: 'CONFLICT',
          bytes: undefined,
          conflicts: Object.freeze([{ reason: `array conflict at ${pointer}`, pointer }]),
        });
      }
      if (result === 'CLEAN') continue;
      edits.push(...result.edits);
    } else {
      // Simple value merge: locate byte ranges in each side
      const currentRange = locatePointer(src, pointer);
      const baseRange = locatePointer(baseSrc, pointer);
      const genRange = locatePointer(genSrc, pointer);

      if (!currentRange || !baseRange || !genRange) {
        return Object.freeze({
          status: 'STRUCTURE_INVALID',
          bytes: undefined,
          conflicts: Object.freeze([{ reason: `pointer not found: ${pointer}`, pointer }]),
        });
      }

      const currentValue = src.substring(currentRange.start, currentRange.end);
      const baseValue = baseSrc.substring(baseRange.start, baseRange.end);
      const genValue = genSrc.substring(genRange.start, genRange.end);

      const currentChanged = currentValue !== baseValue;
      const genChanged = genValue !== baseValue;

      const baseSemantic = valueAtPointer(baseParsed, pointer);
      const currentSemantic = valueAtPointer(currentParsed, pointer);
      const generatedSemantic = valueAtPointer(generatedParsed, pointer);
      if (Array.isArray(baseSemantic) && Array.isArray(currentSemantic) &&
          Array.isArray(generatedSemantic) && currentChanged && genChanged) {
        return Object.freeze({
          status: 'CONFLICT',
          bytes: undefined,
          conflicts: Object.freeze([{
            reason: `array modified on both sides without identity key at ${pointer}`,
            pointer,
          }]),
        });
      }

      if (!currentChanged && !genChanged) {
        continue; // No change on either side
      }

      if (currentChanged && genChanged) {
        if (currentValue === genValue) {
          // Same change — accept (current already has it)
          continue;
        }
        // Divergent changes to a simple value — for non-array, try text merge
        // of the raw value strings
        const mergeResult = mergeText({
          base: Buffer.from(baseValue, 'utf8'),
          current: Buffer.from(currentValue, 'utf8'),
          generated: Buffer.from(genValue, 'utf8'),
        });
        if (mergeResult.status === 'CONFLICT') {
          return Object.freeze({
            status: 'CONFLICT',
            bytes: undefined,
            conflicts: Object.freeze([{
              reason: `divergent value at ${pointer}`,
              pointer,
            }]),
          });
        }
        // Text merge succeeded — but we already have the current value in place
        // If mergeResult differs from current, apply the edit
        const mergedValue = mergeResult.bytes.toString('utf8');
        if (mergedValue !== currentValue) {
          edits.push({ range: currentRange, replacement: mergedValue });
        }
      } else if (!currentChanged && genChanged) {
        // Only generated changed — apply generated value
        edits.push({ range: currentRange, replacement: genValue });
      }
      // If only current changed — keep current (no edit needed)
    }
  }

  if (edits.length === 0) {
    // No changes to apply — return current bytes as-is
    return Object.freeze({
      status: 'MERGEABLE',
      bytes: Buffer.from(current),
      conflicts: Object.freeze([]),
    });
  }

  // Apply edits in reverse order (highest offset first) to preserve positions
  edits.sort((a, b) => b.range.start - a.range.start);

  let result = src;
  for (const edit of edits) {
    result = result.substring(0, edit.range.start) +
             edit.replacement +
             result.substring(edit.range.end);
  }

  return Object.freeze({
    status: 'MERGEABLE',
    bytes: Buffer.from(result, 'utf8'),
    conflicts: Object.freeze([]),
  });
}
