/**
 * Markdown format-preserving three-way merge.
 *
 * Splits the file into frontmatter, managed regions (declared by start/end
 * markers), and unmanaged body ranges.  Unmanaged ranges are byte-preserved
 * from the current side.  Managed regions are merged via text diff3 on the
 * region content.  Frontmatter is merged via text diff3 on the YAML block.
 *
 * No full-file parse or stringify is ever performed — all edits are
 * localised byte-range replacements.
 *
 * @module artifacts/merge/markdown
 */

import { parseManagedRegions } from './regions.mjs';
import { mergeText } from './text.mjs';

/**
 * Detect YAML frontmatter in a Markdown buffer.
 *
 * Frontmatter starts with `---\n` at offset 0 and ends at the next `---\n`.
 *
 * @param {Buffer} bytes
 * @returns {{ endOffset: number }|null} End offset (exclusive) of the frontmatter
 *   block including the closing `---\n`, or null if no frontmatter.
 */
function detectFrontmatter(bytes) {
  const text = bytes.toString('utf8');
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null;

  // Find the closing ---
  const afterFirstDelimiter = text.startsWith('---\r\n') ? 5 : 4;
  const rest = text.substring(afterFirstDelimiter);
  const closeIdx = rest.indexOf('\n---\n');
  if (closeIdx < 0) return null;

  // end offset = afterFirstDelimiter + closeIdx + length of "\n---\n"
  return { endOffset: afterFirstDelimiter + closeIdx + 5 };
}

/**
 * Merge two Markdown modifications of the same base content.
 *
 * @param {object} options
 * @param {Buffer} options.base      - Base Markdown content.
 * @param {Buffer} options.current   - Current (human) Markdown content.
 * @param {Buffer} options.generated - Generated (producer) Markdown content.
 * @param {Array<{ id: string, start: string, end: string }>} [options.managedRegions]
 *   Managed-region declarations.  Each region is delimited by start/end markers.
 * @returns {{ status: 'MERGEABLE'|'CONFLICT'|'STRUCTURE_INVALID', bytes?: Buffer, conflicts: object[] }}
 */
export function mergeMarkdown({ base, current, generated, managedRegions = [] } = {}) {
  // Null/missing inputs → CONFLICT
  if (!base || !current || !generated) {
    return Object.freeze({
      status: 'CONFLICT',
      bytes: undefined,
      conflicts: Object.freeze([{ reason: 'missing input' }]),
    });
  }

  // Parse managed regions from the CURRENT side (authoritative layout)
  let currentRanges;
  try {
    currentRanges = parseManagedRegions(current, managedRegions);
  } catch (err) {
    if (err.code === 'STRUCTURE_INVALID') {
      return Object.freeze({
        status: 'STRUCTURE_INVALID',
        bytes: undefined,
        conflicts: Object.freeze([{ reason: err.message }]),
      });
    }
    throw err;
  }

  // Also parse from base and generated to verify consistency
  let baseRanges;
  try {
    baseRanges = parseManagedRegions(base, managedRegions);
  } catch (err) {
    if (err.code === 'STRUCTURE_INVALID') {
      return Object.freeze({
        status: 'STRUCTURE_INVALID',
        bytes: undefined,
        conflicts: Object.freeze([{ reason: `base: ${err.message}` }]),
      });
    }
    throw err;
  }

  let generatedRanges;
  try {
    generatedRanges = parseManagedRegions(generated, managedRegions);
  } catch (err) {
    if (err.code === 'STRUCTURE_INVALID') {
      return Object.freeze({
        status: 'STRUCTURE_INVALID',
        bytes: undefined,
        conflicts: Object.freeze([{ reason: `generated: ${err.message}` }]),
      });
    }
    throw err;
  }

  // Detect frontmatter on all three sides
  const baseFm = detectFrontmatter(base);
  const currentFm = detectFrontmatter(current);
  const genFm = detectFrontmatter(generated);

  // Build output by walking unmanaged and managed ranges in order
  const output = [];
  let cursor = 0;

  // Process frontmatter first (if present on any side).
  // Three-way frontmatter rules for all 8 presence combinations:
  //   base current generated → action
  //   0    0       0         → no FM
  //   0    0       1         → include generated FM (generated-only addition)
  //   0    1       0         → preserve current FM (human addition)
  //   0    1       1         → preserve current FM (human overrides)
  //   1    0       0         → accept removal
  //   1    0       1         → if changed → CONFLICT; else accept removal
  //   1    1       0         → preserve current FM (generated removed, human kept)
  //   1    1       1         → three-way merge
  if (currentFm || baseFm || genFm) {
    const baseFmEnd = baseFm?.endOffset ?? 0;
    const currentFmEnd = currentFm?.endOffset ?? 0;
    const genFmEnd = genFm?.endOffset ?? 0;

    if (baseFm && currentFm && genFm) {
      // All three have frontmatter — three-way merge
      const baseFmBytes = base.subarray(0, baseFmEnd);
      const currentFmBytes = current.subarray(0, currentFmEnd);
      const genFmBytes = generated.subarray(0, genFmEnd);

      const fmResult = mergeText({
        base: baseFmBytes,
        current: currentFmBytes,
        generated: genFmBytes,
      });

      if (fmResult.status === 'CONFLICT') {
        return Object.freeze({
          status: 'CONFLICT',
          bytes: undefined,
          conflicts: Object.freeze(fmResult.conflicts.map((c) =>
            Object.freeze({ ...c, regionId: 'frontmatter' }),
          )),
        });
      }

      output.push(fmResult.bytes);
      cursor = currentFmEnd;
    } else if (!baseFm && !currentFm && genFm) {
      // Generated-only new frontmatter — include it
      output.push(generated.subarray(0, genFmEnd));
      cursor = 0; // no frontmatter consumed from current
    } else if (currentFm) {
      // Current has frontmatter — preserve it (covers 0/1/0, 0/1/1, 1/1/0)
      output.push(current.subarray(0, currentFmEnd));
      cursor = currentFmEnd;
    } else if (baseFm && genFm) {
      // Base and generated have frontmatter, current removed it (1/0/1)
      const baseFmContent = base.subarray(0, baseFmEnd);
      const genFmContent = generated.subarray(0, genFmEnd);
      if (!baseFmContent.equals(genFmContent)) {
        // Generated changed frontmatter but current removed it → conflict
        return Object.freeze({
          status: 'CONFLICT',
          bytes: undefined,
          conflicts: Object.freeze([{
            reason: 'frontmatter removed by current but modified by generated',
            regionId: 'frontmatter',
          }]),
        });
      }
      // Generated didn't change frontmatter — accept current's removal (1/0/0)
    }
  }

  // Sort regions by start offset for ordered processing
  const sortedRegions = [...currentRanges.entries()]
    .sort(([, a], [, b]) => a.start - b.start);

  for (const [regionId, currentRange] of sortedRegions) {
    // Emit unmanaged bytes before this region (from current)
    if (cursor < currentRange.start) {
      output.push(current.subarray(cursor, currentRange.start));
    }

    // Get the corresponding range in base and generated
    const baseRange = baseRanges.get(regionId);
    const genRange = generatedRanges.get(regionId);

    if (!baseRange || !genRange) {
      // Region missing in base or generated — structural mismatch
      return Object.freeze({
        status: 'STRUCTURE_INVALID',
        bytes: undefined,
        conflicts: Object.freeze([{
          reason: `managed region '${regionId}' has inconsistent marker positions across sides`,
        }]),
      });
    }

    // Extract region content from each side (between markers, exclusive)
    const baseContent = base.subarray(baseRange.start, baseRange.end);
    const currentContent = current.subarray(currentRange.start, currentRange.end);
    const generatedContent = generated.subarray(genRange.start, genRange.end);

    // Text merge the region content
    const regionResult = mergeText({
      base: baseContent,
      current: currentContent,
      generated: generatedContent,
    });

    if (regionResult.status === 'CONFLICT') {
      return Object.freeze({
        status: 'CONFLICT',
        bytes: undefined,
        conflicts: Object.freeze(regionResult.conflicts.map((c) =>
          Object.freeze({ ...c, regionId }),
        )),
      });
    }

    // Emit merged region bytes
    output.push(regionResult.bytes);
    cursor = currentRange.end;
  }

  // Emit any trailing unmanaged bytes after the last region
  if (cursor < current.length) {
    output.push(current.subarray(cursor));
  }

  const bytes = Buffer.concat(output);

  return Object.freeze({
    status: 'MERGEABLE',
    bytes,
    conflicts: Object.freeze([]),
  });
}
