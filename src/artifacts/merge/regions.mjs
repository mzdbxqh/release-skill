/**
 * Managed region parser for structured merge drivers.
 *
 * Parses managed-region declarations (start/end marker pairs) from raw
 * byte content and returns a projection map of region id → byte range.
 *
 * Enforces:
 * - No duplicate start or end markers for the same region id.
 * - No nested or overlapping regions.
 * - Every declared region must have both start and end markers present.
 *
 * All operations are byte-level; no full-file parse or stringify.
 *
 * @module artifacts/merge/regions
 */

import { ReleaseError, STRUCTURE_INVALID } from '../../core/errors.mjs';

/**
 * @typedef {{ start: number, end: number }} ByteRange
 * start is inclusive byte offset of the start marker; end is the exclusive
 * byte offset past the end marker (i.e., end marker last byte + 1).
 */

/**
 * Parse managed-region declarations from raw bytes.
 *
 * Returns a Map of region id → { start, end } byte ranges.
 *
 * @param {Buffer} bytes - Raw file content.
 * @param {Array<{ id: string, start: string, end: string }>} declarations
 * @returns {Map<string, ByteRange>}
 * @throws {ReleaseError} with code STRUCTURE_INVALID on duplicate/nested/missing markers.
 */
export function parseManagedRegions(bytes, declarations) {
  const result = new Map();

  // Reject empty marker strings upfront to prevent infinite loops
  for (const decl of declarations) {
    if (!decl.start || !decl.end) {
      throw new ReleaseError(
        STRUCTURE_INVALID,
        `managed region '${decl.id}' has empty start or end marker`,
        { regionId: decl.id },
      );
    }
  }

  // Reject duplicate declaration ids
  const seenIds = new Set();
  for (const decl of declarations) {
    if (seenIds.has(decl.id)) {
      throw new ReleaseError(
        STRUCTURE_INVALID,
        `duplicate declaration id '${decl.id}' in managed region declarations`,
        { regionId: decl.id },
      );
    }
    seenIds.add(decl.id);
  }

  /** @type {Array<{ id: string, kind: 'start'|'end', offset: number }>} */
  const markers = [];

  // Collect all marker occurrences
  for (const decl of declarations) {
    let offset = 0;
    while (offset <= bytes.length) {
      const idx = bytes.indexOf(decl.start, offset, 'utf8');
      if (idx < 0) break;
      markers.push({ id: decl.id, kind: 'start', offset: idx });
      offset = idx + Buffer.byteLength(decl.start, 'utf8');
      // Guard: if marker is empty this would be an infinite loop (handled above)
    }
    offset = 0;
    while (offset <= bytes.length) {
      const idx = bytes.indexOf(decl.end, offset, 'utf8');
      if (idx < 0) break;
      markers.push({ id: decl.id, kind: 'end', offset: idx });
      offset = idx + Buffer.byteLength(decl.end, 'utf8');
    }
  }

  // Reject declared regions whose markers are completely absent from content
  for (const decl of declarations) {
    const hasStart = markers.some((m) => m.id === decl.id && m.kind === 'start');
    const hasEnd = markers.some((m) => m.id === decl.id && m.kind === 'end');
    if (!hasStart && !hasEnd) {
      throw new ReleaseError(
        STRUCTURE_INVALID,
        `managed region '${decl.id}' markers not found in content`,
        { regionId: decl.id },
      );
    }
  }

  // Sort by offset, then 'start' before 'end' at same offset
  markers.sort((a, b) => a.offset - b.offset || (a.kind === 'start' ? -1 : 1));

  // Validate and extract ranges
  /** @type {Map<string, { startOffset: number }>} */
  const openRegions = new Map();

  for (const marker of markers) {
    if (marker.kind === 'start') {
      if (openRegions.has(marker.id)) {
        throw new ReleaseError(
          STRUCTURE_INVALID,
          `duplicate start marker for managed region '${marker.id}'`,
          { regionId: marker.id, offset: marker.offset },
        );
      }
      // Check for nesting: any currently-open region with a different id
      // whose start is after this offset indicates overlap
      for (const [openId, openInfo] of openRegions) {
        if (openId !== marker.id && openInfo.startOffset < marker.offset) {
          // There's an open region that started before this one — overlapping
          throw new ReleaseError(
            STRUCTURE_INVALID,
            `managed region '${marker.id}' overlaps with open region '${openId}'`,
            { regionId: marker.id, overlappingWith: openId },
          );
        }
      }
      openRegions.set(marker.id, { startOffset: marker.offset });
    } else {
      // end marker
      if (!openRegions.has(marker.id)) {
        throw new ReleaseError(
          STRUCTURE_INVALID,
          `end marker for managed region '${marker.id}' found without matching start`,
          { regionId: marker.id, offset: marker.offset },
        );
      }
      const openInfo = openRegions.get(marker.id);
      const decl = declarations.find((d) => d.id === marker.id);
      const endMarkerLen = Buffer.byteLength(decl.end, 'utf8');
      result.set(marker.id, {
        start: openInfo.startOffset,
        end: marker.offset + endMarkerLen,
      });
      openRegions.delete(marker.id);
    }
  }

  // Any remaining open regions are missing their end markers
  for (const [id] of openRegions) {
    throw new ReleaseError(
      STRUCTURE_INVALID,
      `managed region '${id}' has start marker but no end marker`,
      { regionId: id },
    );
  }

  return result;
}
