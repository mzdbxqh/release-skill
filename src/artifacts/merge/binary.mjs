/**
 * Binary artifact three-way merge.
 *
 * Binary entries can only be fast-forwarded: exactly one side may differ
 * from the base.  Divergent two-side changes are always CONFLICT.
 *
 * @module artifacts/merge/binary
 */

import { sha256Hex } from '../../core/digest.mjs';

/**
 * Merge two binary modifications of the same base content.
 *
 * Accepts the changed side when only one side differs from the base.
 * Returns CONFLICT when both sides changed to different content.
 *
 * @param {object} options
 * @param {Buffer} options.base      - Base (accepted) content.
 * @param {Buffer} options.current   - Current (human) content.
 * @param {Buffer} options.generated - Generated (producer) content.
 * @returns {{ status: 'MERGEABLE'|'CONFLICT', bytes?: Buffer, conflicts: object[] }}
 */
export function mergeBinary({ base, current, generated }) {
  const baseHash = sha256Hex(base);
  const currentHash = sha256Hex(current);
  const generatedHash = sha256Hex(generated);

  const currentChanged = baseHash !== currentHash;
  const generatedChanged = baseHash !== generatedHash;

  // Both unchanged — MERGEABLE with base content
  if (!currentChanged && !generatedChanged) {
    return Object.freeze({
      status: 'MERGEABLE',
      bytes: base,
      conflicts: Object.freeze([]),
    });
  }

  // Only one side changed — accept that side
  if (currentChanged && !generatedChanged) {
    return Object.freeze({
      status: 'MERGEABLE',
      bytes: current,
      conflicts: Object.freeze([]),
    });
  }

  if (!currentChanged && generatedChanged) {
    return Object.freeze({
      status: 'MERGEABLE',
      bytes: generated,
      conflicts: Object.freeze([]),
    });
  }

  // Both sides changed
  if (currentHash === generatedHash) {
    // Same change — accept
    return Object.freeze({
      status: 'MERGEABLE',
      bytes: current,
      conflicts: Object.freeze([]),
    });
  }

  // Divergent — CONFLICT
  return Object.freeze({
    status: 'CONFLICT',
    conflicts: Object.freeze([Object.freeze({
      reason: 'binary divergent change',
      currentHash,
      generatedHash,
    })]),
  });
}
