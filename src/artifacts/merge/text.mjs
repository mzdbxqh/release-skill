/**
 * Three-way text merge for UTF-8 artifact content.
 *
 * Performs line-level diff3 on normalised (LF) content, preserving the
 * original encoding (UTF-8 BOM detection) and trailing-newline state.
 *
 * Conflict regions are returned as structured data — no conflict markers
 * (<<<<<<< / ======= / >>>>>>>) are ever written to the merged output.
 *
 * Non-UTF-8 input, mixed illegal line endings, or excessive line counts
 * are treated as binary/structure conflicts.
 *
 * @module artifacts/merge/text
 */

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

/**
 * Compute the longest common subsequence table between two line arrays.
 *
 * Returns `null` when the cell count (m × n) exceeds `MAX_LCS_CELLS`,
 * signalling that the merge should fail closed.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number[][]|null} LCS dynamic-programming table, or null if too large.
 */
function lcsTable(a, b) {
  const m = a.length;
  const n = b.length;
  if (m * n > MAX_LCS_CELLS) return null;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

/**
 * Back-trace the LCS table to produce a diff operations list.
 *
 * Operations:
 * - `equal` — line is the same on both sides.
 * - `delete` — line exists in `a` but not in `b`.
 * - `insert` — line exists in `b` but not in `a`.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @param {number[][]} dp
 * @returns {Array<{op: string, aLine?: string, bLine?: string}>}
 */
function diffFromLcs(a, b, dp) {
  const ops = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ op: 'equal', aLine: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ op: 'insert', bLine: b[j - 1] });
      j--;
    } else {
      ops.push({ op: 'delete', aLine: a[i - 1] });
      i--;
    }
  }
  return ops.reverse();
}

/**
 * Compute a line-level diff between two string arrays.
 *
 * Returns `null` when the LCS cell count exceeds the cap, signalling
 * that the merge should fail closed with a complexity conflict.
 *
 * @param {string[]} a - Source lines.
 * @param {string[]} b - Target lines.
 * @returns {Array<{op: string, line?: string, aLine?: string, bLine?: string}>|null}
 */
function diffLines(a, b) {
  const dp = lcsTable(a, b);
  if (!dp) return null;
  const raw = diffFromLcs(a, b, dp);
  return raw.map((e) => {
    if (e.op === 'equal') return { op: 'equal', line: e.aLine };
    if (e.op === 'delete') return { op: 'delete', line: e.aLine };
    return { op: 'insert', line: e.bLine };
  });
}

/**
 * Maximum number of lines the merge will process before refusing.
 * Prevents unbounded memory/CPU on adversarial inputs.
 */
const MAX_LINES = 200_000;

/**
 * Maximum number of cells (base.length × side.length) the LCS table
 * will allocate.  Prevents unbounded memory on large divergent inputs.
 *
 * At 4 bytes per cell, 4M cells ≈ 16 MB — a reasonable ceiling.
 */
const MAX_LCS_CELLS = 4_000_000;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/**
 * Detect encoding features of a byte buffer.
 *
 * Returns the BOM prefix (if any) and whether the content has a trailing
 * newline.
 *
 * @param {Buffer} bytes
 * @returns {{ bom: Buffer|null, hasTrailingNewline: boolean }}
 */
function detectEncoding(bytes) {
  let bom = null;
  let start = 0;
  if (bytes.length >= 3 &&
      bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    start = 3;
  }
  const hasTrailingNewline = bytes.length > start &&
    bytes[bytes.length - 1] === 0x0A;
  return { bom, hasTrailingNewline };
}

/**
 * Normalise line endings to LF and split into lines.
 *
 * Strips the BOM prefix (if present) before splitting. The trailing empty
 * string produced by a final LF is trimmed so that the lines array contains
 * only content lines.
 *
 * @param {Buffer} bytes
 * @returns {{ lines: string[], bom: Buffer|null, hasTrailingNewline: boolean }}
 */
function normaliseToLines(bytes) {
  const { bom, hasTrailingNewline } = detectEncoding(bytes);
  let text;
  try {
    // Keep the BOM code point so the explicit encoding state below remains
    // authoritative; the default decoder behavior would already strip it.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    text = decoder.decode(bytes);
  } catch {
    return null;
  }

  // Strip BOM from the decoded text
  if (bom) text = text.slice(1);

  // Strict LF contract: reject any CR presence (CRLF, bare CR) as structure conflict.
  // Only bare LF is acceptable.
  const hasCR = text.includes('\r');
  if (hasCR) return null;

  // Normalise to LF
  const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const allLines = normalised.split('\n');

  // If text ends with LF, split produces trailing '' — trim it
  const lines = hasTrailingNewline && allLines[allLines.length - 1] === ''
    ? allLines.slice(0, -1)
    : allLines;

  return { lines, bom, hasTrailingNewline };
}

/**
 * Reconstruct bytes from merged lines.
 *
 * @param {string[]} lines - Merged content lines.
 * @param {{ bom: Buffer|null, hasTrailingNewline: boolean }} encoding
 * @returns {Buffer}
 */
function linesToBytes(lines, encoding) {
  const content = lines.join('\n');
  const utf8 = Buffer.from(content, 'utf8');
  if (encoding.bom) {
    return encoding.hasTrailingNewline
      ? Buffer.concat([encoding.bom, utf8, Buffer.from('\n')])
      : Buffer.concat([encoding.bom, utf8]);
  }
  return encoding.hasTrailingNewline
    ? Buffer.concat([utf8, Buffer.from('\n')])
    : utf8;
}

function mergeBooleanState(base, current, generated) {
  if (current === generated) return { conflict: false, value: current };
  if (current === base) return { conflict: false, value: generated };
  if (generated === base) return { conflict: false, value: current };
  return { conflict: true };
}

// ---------------------------------------------------------------------------
// Diff3 merge (base → current × base → generated)
// ---------------------------------------------------------------------------

/**
 * Classify a diff operation for edit-region grouping.
 *
 * - 'equal' — synchronisation point (both diffs must match here).
 * - 'edit'  — a delete or insert that constitutes part of an edit region.
 */
function diffToHunks(base, other) {
  const ops = diffLines(base, other);
  if (!ops) return null;
  const hunks = [];
  let baseIndex = 0;
  let active = null;

  const ensureActive = () => {
    if (!active) active = { start: baseIndex, end: baseIndex, replacement: [] };
    return active;
  };
  const flush = () => {
    if (active) hunks.push(Object.freeze(active));
    active = null;
  };

  for (const op of ops) {
    if (op.op === 'equal') {
      flush();
      baseIndex += 1;
    } else if (op.op === 'delete') {
      ensureActive().end += 1;
      baseIndex += 1;
    } else {
      ensureActive().replacement.push(op.line);
    }
  }
  flush();
  return hunks;
}

function applyHunksToRegion(base, start, end, hunks) {
  const output = [];
  let cursor = start;
  for (const hunk of hunks) {
    output.push(...base.slice(cursor, hunk.start), ...hunk.replacement);
    cursor = hunk.end;
  }
  output.push(...base.slice(cursor, end));
  return output;
}

function hunksOverlapRegion(hunk, start, end) {
  if (start === end) return hunk.start === start;
  if (hunk.start === hunk.end) return hunk.start >= start && hunk.start < end;
  return hunk.start < end && hunk.end > start;
}

/**
 * Three-way line merge.
 *
 * Computes diffs `base→current` and `base→generated` and walks them in
 * lock-step.  Consecutive non-equal operations on each side are grouped
 * into edit regions.  Each region is then compared across the two sides:
 *
 * - Both sides produce the same result → accept once.
 * - Only one side changed → accept that side.
 * - Both sides changed differently → CONFLICT.
 *
 * @param {string[]} base
 * @param {string[]} current
 * @param {string[]} generated
 * @returns {{ merged: string[], conflicts: object[], humanHunks: string[] }}
 */
function diff3Merge(base, current, generated) {
  const rawCurrentHunks = diffToHunks(base, current);
  const rawGeneratedHunks = diffToHunks(base, generated);
  if (!rawCurrentHunks || !rawGeneratedHunks) {
    return { merged: null, conflicts: [{ reason: 'LCS complexity exceeded — cell count too large' }], humanHunks: [] };
  }
  const currentHunks = rawCurrentHunks.map((hunk) => ({ ...hunk, side: 'current' }));
  const generatedHunks = rawGeneratedHunks.map((hunk) => ({ ...hunk, side: 'generated' }));
  const pending = [...currentHunks, ...generatedHunks].sort((a, b) =>
    a.start - b.start || a.end - b.end || a.side.localeCompare(b.side));
  const merged = [];
  const conflicts = [];
  const humanHunks = [];
  let cursor = 0;

  while (pending.length > 0) {
    const group = [pending.shift()];
    let start = group[0].start;
    let end = group[0].end;
    let added = true;
    while (added) {
      added = false;
      for (let index = 0; index < pending.length; index += 1) {
        if (!hunksOverlapRegion(pending[index], start, end)) continue;
        const [hunk] = pending.splice(index, 1);
        group.push(hunk);
        start = Math.min(start, hunk.start);
        end = Math.max(end, hunk.end);
        added = true;
        break;
      }
    }

    merged.push(...base.slice(cursor, start));
    const cHunks = group.filter((h) => h.side === 'current').sort((a, b) => a.start - b.start);
    const gHunks = group.filter((h) => h.side === 'generated').sort((a, b) => a.start - b.start);
    const currentResult = applyHunksToRegion(base, start, end, cHunks);
    const generatedResult = applyHunksToRegion(base, start, end, gHunks);
    const same = currentResult.length === generatedResult.length &&
      currentResult.every((line, index) => line === generatedResult[index]);

    if (cHunks.length === 0) {
      merged.push(...generatedResult);
    } else if (gHunks.length === 0) {
      merged.push(...currentResult);
      humanHunks.push(currentResult.join('\n'));
    } else if (same) {
      merged.push(...currentResult);
    } else {
      conflicts.push({ currentLines: currentResult, generatedLines: generatedResult });
    }
    cursor = end;
  }

  merged.push(...base.slice(cursor));

  return { merged, conflicts, humanHunks };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge two textual modifications of the same base content.
 *
 * Input bytes are expected to be valid UTF-8.  Line endings are normalised
 * to LF before diffing; the original encoding (BOM, trailing-newline state)
 * is preserved in the output.
 *
 * Conflict regions are returned as structured `conflicts` entries — no
 * `<<<<<<<` / `=======` / `>>>>>>>` markers appear in `bytes`.
 *
 * @param {object} options
 * @param {Buffer} options.base   - Base (accepted) content.
 * @param {Buffer} options.current - Current (human) content.
 * @param {Buffer} options.generated - Generated (producer) content.
 * @returns {{ status: 'MERGEABLE'|'CONFLICT', bytes?: Buffer, conflicts: object[], preservedHumanHunks: string[] }}
 */
export function mergeText({ base, current, generated }) {
  // Null/undefined inputs → structure conflict
  if (!base || !current || !generated) {
    return Object.freeze({
      status: 'CONFLICT',
      conflicts: [{ reason: 'missing input' }],
      preservedHumanHunks: [],
    });
  }

  // Validate UTF-8
  const baseN = normaliseToLines(base);
  const currentN = normaliseToLines(current);
  const generatedN = normaliseToLines(generated);

  if (!baseN || !currentN || !generatedN) {
    return Object.freeze({
      status: 'CONFLICT',
      conflicts: [{ reason: 'non-UTF-8 or CR/CRLF line endings (strict LF contract)' }],
      preservedHumanHunks: [],
    });
  }

  // Line-count guard
  if (baseN.lines.length > MAX_LINES ||
      currentN.lines.length > MAX_LINES ||
      generatedN.lines.length > MAX_LINES) {
    return Object.freeze({
      status: 'CONFLICT',
      conflicts: [{ reason: 'excessive line count' }],
      preservedHumanHunks: [],
    });
  }

  const bomState = mergeBooleanState(Boolean(baseN.bom), Boolean(currentN.bom), Boolean(generatedN.bom));
  const newlineState = mergeBooleanState(
    baseN.hasTrailingNewline,
    currentN.hasTrailingNewline,
    generatedN.hasTrailingNewline,
  );
  if (bomState.conflict || newlineState.conflict) {
    return Object.freeze({
      status: 'CONFLICT',
      conflicts: Object.freeze([Object.freeze({ reason: 'encoding state changed divergently' })]),
      preservedHumanHunks: Object.freeze([]),
    });
  }

  // Diff3 merge
  const { merged, conflicts, humanHunks } = diff3Merge(
    baseN.lines, currentN.lines, generatedN.lines,
  );

  if (merged === null || conflicts.length > 0) {
    return Object.freeze({
      status: 'CONFLICT',
      conflicts: Object.freeze(conflicts.map((c) => Object.freeze(c))),
      preservedHumanHunks: Object.freeze([]),
    });
  }

  const bytes = linesToBytes(merged, {
    bom: bomState.value ? Buffer.from([0xEF, 0xBB, 0xBF]) : null,
    hasTrailingNewline: newlineState.value,
  });

  return Object.freeze({
    status: 'MERGEABLE',
    bytes,
    conflicts: Object.freeze([]),
    preservedHumanHunks: Object.freeze(humanHunks),
  });
}
