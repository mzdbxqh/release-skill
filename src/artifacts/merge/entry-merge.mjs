/**
 * Three-way artifact entry merge dispatcher.
 *
 * Classifies the existence/state of (base, current, generated) and
 * delegates content merge to the appropriate driver (text, binary, tree).
 *
 * The existence table (design §10.1) is implemented here; content-level
 * merge logic lives in the driver modules.
 *
 * Real artifact targets are never written by this module — results are
 * returned as in-memory candidates.
 *
 * @module artifacts/merge/entry-merge
 */

import { sha256Hex } from '../../core/digest.mjs';
import { mergeText } from './text.mjs';
import { mergeBinary } from './binary.mjs';
import { mergeTree } from './tree.mjs';
import { mergeMarkdown } from './markdown.mjs';
import { mergeJson } from './json.mjs';
import { mergeYaml } from './yaml.mjs';

// Re-export sub-module APIs for convenience
export { mergeText } from './text.mjs';
export { mergeBinary } from './binary.mjs';
export { mergeTree } from './tree.mjs';
export { mergeMarkdown } from './markdown.mjs';
export { mergeJson } from './json.mjs';
export { mergeYaml } from './yaml.mjs';

/**
 * Merge two modifications of the same base artifact entry.
 *
 * Dispatches to the appropriate driver after applying the existence table
 * (absent/present combinations).
 *
 * @param {object} options
 * @param {object|null} options.base      - Base entry ({ kind: 'absent' } or entry object).
 * @param {object|null} options.current   - Current entry.
 * @param {object|null} options.generated - Generated entry.
 * @param {'text'|'binary'|'tree'} [options.driver='text'] - Merge driver.
 * @param {object} [options.options]      - Driver-specific options (renameMap for tree).
 * @returns {{ status: 'MERGEABLE'|'CONFLICT', candidate?: object }}
 */
export function mergeEntry({ base, current, generated, driver = 'text', options } = {}) {
  const hasBase      = base      && base.kind      !== 'absent';
  const hasCurrent   = current   && current.kind   !== 'absent';
  const hasGenerated = generated && generated.kind !== 'absent';

  // -------------------------------------------------------------------
  // Existence table — base absent
  // -------------------------------------------------------------------
  if (!hasBase) {
    if (!hasCurrent && !hasGenerated) {
      return Object.freeze({ status: 'MERGEABLE', candidate: Object.freeze({ kind: 'absent' }) });
    }
    if (hasCurrent && !hasGenerated) {
      return Object.freeze({ status: 'MERGEABLE', candidate: current });
    }
    if (!hasCurrent && hasGenerated) {
      return Object.freeze({ status: 'MERGEABLE', candidate: generated });
    }
    // Both present and differ → CONFLICT
    if (!entriesEqual(current, generated)) {
      return Object.freeze({ status: 'CONFLICT', candidate: undefined });
    }
    // Both present and equal → MERGEABLE
    return Object.freeze({ status: 'MERGEABLE', candidate: current });
  }

  // -------------------------------------------------------------------
  // Existence table — base present
  // -------------------------------------------------------------------
  if (!hasCurrent && !hasGenerated) {
    return Object.freeze({ status: 'MERGEABLE', candidate: Object.freeze({ kind: 'absent' }) });
  }

  if (hasCurrent && !hasGenerated) {
    // Producer deleted, human kept → accept producer delete
    if (entriesEqual(base, current)) {
      return Object.freeze({ status: 'MERGEABLE', candidate: Object.freeze({ kind: 'absent' }) });
    }
    // Human modified, producer deleted → CONFLICT
    return Object.freeze({ status: 'CONFLICT', candidate: undefined });
  }

  if (!hasCurrent && hasGenerated) {
    // Human deleted, producer kept → accept human delete
    if (entriesEqual(base, generated)) {
      return Object.freeze({ status: 'MERGEABLE', candidate: Object.freeze({ kind: 'absent' }) });
    }
    // Producer modified, human deleted → CONFLICT
    return Object.freeze({ status: 'CONFLICT', candidate: undefined });
  }

  // Both present — check type compatibility
  if (current.kind === 'tree' || generated.kind === 'tree') {
    if (current.kind !== generated.kind) {
      return Object.freeze({ status: 'CONFLICT', candidate: undefined });
    }
    // Both trees — merge as tree regardless of driver
    const result = mergeTree({ base, current, generated, ...options });
    return Object.freeze({ status: result.status, candidate: result.candidate });
  }

  // Both regular files — type/mode conflict check
  if (current.type !== generated.type || current.mode !== generated.mode) {
    return Object.freeze({ status: 'CONFLICT', candidate: undefined });
  }

  // Content identical → MERGEABLE with current
  if (current.sha256 === generated.sha256) {
    return Object.freeze({ status: 'MERGEABLE', candidate: current });
  }

  // Dispatch to driver
  if (driver === 'tree') {
    const result = mergeTree({ base, current, generated, ...options });
    return Object.freeze({ status: result.status, candidate: result.candidate });
  }

  if (driver === 'binary') {
    const result = mergeBinary({ base: base.bytes, current: current.bytes, generated: generated.bytes });
    if (result.status === 'CONFLICT') {
      return Object.freeze({ status: 'CONFLICT', candidate: undefined });
    }
    return Object.freeze({
      status: 'MERGEABLE',
      candidate: Object.freeze({
        ...current,
        bytes: result.bytes,
        sha256: sha256Hex(result.bytes),
        size: result.bytes.length,
      }),
    });
  }

  if (driver === 'markdown') {
    const result = mergeMarkdown({
      base: base.bytes, current: current.bytes, generated: generated.bytes, ...options,
    });
    if (result.status === 'CONFLICT' || result.status === 'STRUCTURE_INVALID') {
      return Object.freeze({ status: result.status, candidate: undefined });
    }
    return Object.freeze({
      status: 'MERGEABLE',
      candidate: Object.freeze({
        ...current,
        bytes: result.bytes,
        sha256: sha256Hex(result.bytes),
        size: result.bytes.length,
      }),
    });
  }

  if (driver === 'json') {
    const result = mergeJson({
      base: base.bytes, current: current.bytes, generated: generated.bytes, ...options,
    });
    if (result.status === 'CONFLICT' || result.status === 'STRUCTURE_INVALID') {
      return Object.freeze({ status: result.status, candidate: undefined });
    }
    return Object.freeze({
      status: 'MERGEABLE',
      candidate: Object.freeze({
        ...current,
        bytes: result.bytes,
        sha256: sha256Hex(result.bytes),
        size: result.bytes.length,
      }),
    });
  }

  if (driver === 'yaml') {
    const result = mergeYaml({
      base: base.bytes, current: current.bytes, generated: generated.bytes, ...options,
    });
    if (result.status === 'CONFLICT' || result.status === 'STRUCTURE_INVALID') {
      return Object.freeze({ status: result.status, candidate: undefined });
    }
    return Object.freeze({
      status: 'MERGEABLE',
      candidate: Object.freeze({
        ...current,
        bytes: result.bytes,
        sha256: sha256Hex(result.bytes),
        size: result.bytes.length,
      }),
    });
  }

  // Default: text driver
  const result = mergeText({ base: base.bytes, current: current.bytes, generated: generated.bytes });
  if (result.status === 'CONFLICT') {
    return Object.freeze({ status: 'CONFLICT', candidate: undefined });
  }
  return Object.freeze({
    status: 'MERGEABLE',
    candidate: Object.freeze({
      ...current,
      bytes: result.bytes,
      sha256: sha256Hex(result.bytes),
      size: result.bytes.length,
    }),
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check if two entries are equal across all content dimensions.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function entriesEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.mode !== b.mode) return false;
  if (a.sha256 !== b.sha256) return false;
  if (a.manifestDigest !== b.manifestDigest) return false;
  return true;
}
