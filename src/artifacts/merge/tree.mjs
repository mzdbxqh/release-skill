/**
 * Three-way tree (directory) merge.
 *
 * Computes the path union of base/current/generated entries and merges
 * each path individually via the entry-level dispatcher.  Detects
 * undeclared renames (producer deletes + adds without a renameMap entry)
 * and reports them as CONFLICT.
 *
 * The output manifest is recomputed via `digestEntryManifest` so it is
 * always deterministic and content-addressed.
 *
 * @module artifacts/merge/tree
 */

import { digestEntryManifest } from '../entry.mjs';
import { mergeEntry } from './entry-merge.mjs';

/**
 * Compute the set-union of all paths across three entry maps.
 *
 * @param {Map<string,object>} baseE
 * @param {Map<string,object>} currentE
 * @param {Map<string,object>} generatedE
 * @returns {string[]} Sorted unique paths.
 */
function pathUnion(baseE, currentE, generatedE) {
  const set = new Set([...baseE.keys(), ...currentE.keys(), ...generatedE.keys()]);
  return [...set].sort();
}

/**
 * Extract a path→entry map from a tree entry's `entries` array.
 *
 * Absent entries are represented as `{ kind: 'absent' }`.
 *
 * @param {object} treeEntry - A tree entry (kind: 'tree') or absent.
 * @returns {Map<string,object>}
 */
function entryMap(treeEntry) {
  if (!treeEntry || treeEntry.kind === 'absent' || !treeEntry.entries) {
    return new Map();
  }
  return new Map(treeEntry.entries.map((e) => [e.path, e]));
}

/**
 * Merge two modifications of the same base tree.
 *
 * @param {object} options
 * @param {object} options.base      - Base tree entry.
 * @param {object} options.current   - Current tree entry.
 * @param {object} options.generated - Generated tree entry.
 * @param {Record<string,string>} [options.renameMap] - Declared renames (oldPath → newPath).
 * @param {Record<string,string>} [options.drivers]   - Per-path merge driver (path → 'text'|'binary').
 * @returns {{ status: 'MERGEABLE'|'CONFLICT', candidate?: object, conflicts?: object[] }}
 */
export function mergeTree({ base, current, generated, renameMap, drivers } = {}) {
  const baseE      = entryMap(base);
  const currentE   = entryMap(current);
  const generatedE = entryMap(generated);
  const allPaths   = pathUnion(baseE, currentE, generatedE);

  const candidateEntries = [];
  const conflicts = [];

  // Per-entry merge
  for (const path of allPaths) {
    const b = baseE.get(path)      ?? Object.freeze({ kind: 'absent' });
    const c = currentE.get(path)   ?? Object.freeze({ kind: 'absent' });
    const g = generatedE.get(path) ?? Object.freeze({ kind: 'absent' });

    const pathDriver = drivers?.[path] ?? 'text';
    const result = mergeEntry({ base: b, current: c, generated: g, driver: pathDriver });

    if (result.status === 'CONFLICT') {
      conflicts.push({ path, reason: 'entry conflict' });
      continue;
    }

    const cand = result.candidate;
    if (!cand || cand.kind === 'absent') continue;

    // Normalise: ensure path and type are set for manifest digest
    const entry = {
      path: cand.path ?? path,
      type: cand.type ?? 'blob',
      mode: cand.mode ?? '100644',
      sha256: cand.sha256 ?? '',
      size: cand.size ?? 0,
    };
    candidateEntries.push(Object.freeze(entry));
  }

  // --- File-directory prefix collision detection ---
  //
  // When one side has a file at path P and another side has entries under
  // P/ (making P a directory), the merge result is structurally invalid.
  // This catches the case where a blob entry and a path prefixed by that
  // blob's path both appear in the merged candidate set.
  const candidatePaths = candidateEntries.map((e) => e.path).sort();
  for (let i = 0; i < candidatePaths.length - 1; i += 1) {
    const current = candidatePaths[i];
    const next = candidatePaths[i + 1];
    if (next.startsWith(`${current}/`)) {
      conflicts.push({
        path: current,
        reason: `file-directory conflict: '${current}' is a blob but '${next}' exists under it`,
      });
    }
  }

  // --- NFC + case-fold path collision detection ---
  //
  // Paths that differ only by Unicode normalization form (NFC vs NFD) or
  // case fold would collide on macOS (HFS+) and Windows (NTFS) filesystems.
  // Fail closed: any two candidate paths that normalize to the same key
  // after NFC + case-fold are a CONFLICT.
  {
    const seen = new Map(); // normalisedKey → first path that used it
    for (const path of candidatePaths) {
      // NFC normalize then lowercase for case-fold equivalence
      const key = path.normalize('NFC').toLowerCase();
      const existing = seen.get(key);
      if (existing) {
        conflicts.push({
          path,
          reason: `NFC+case-fold path collision: '${path}' collides with '${existing}' after normalization`,
        });
      } else {
        seen.set(key, path);
      }
    }
  }

  // --- Undeclared-rename detection ---
  //
  // When the producer deleted paths from base AND added new paths that
  // are not in the base, an explicit renameMap entry is required for
  // every such pair.  Otherwise the disappearance is ambiguous and the
  // merge is a CONFLICT.
  if (allPaths.length > 0) {
    const reverseRenameMap = renameMap
      ? new Map(Object.entries(renameMap).map(([k, v]) => [v, k]))
      : new Map();

    // Paths that were in the base and deleted by the producer
    const producerDeletions = [];
    // Paths that are new in the generated (not in base or current)
    const producerAdditions = [];

    for (const path of allPaths) {
      const inBase = baseE.has(path);
      const inGen  = generatedE.has(path);

      if (inBase && !inGen) {
        // Producer removed this path
        if (!(renameMap && renameMap[path])) {
          producerDeletions.push(path);
        }
      }
      if (!inBase && inGen) {
        // Producer added this path — check if it's a declared rename target
        if (!reverseRenameMap.has(path)) {
          producerAdditions.push(path);
        }
      }
    }

    // Undeclared renames: if both sides have orphans, it's ambiguous
    if (producerDeletions.length > 0 && producerAdditions.length > 0) {
      for (const oldPath of producerDeletions) {
        conflicts.push({
          path: oldPath,
          reason: 'undeclared rename: producer removed and added paths without renameMap',
        });
      }
    }
  }

  // Return conflicts if any
  if (conflicts.length > 0) {
    return Object.freeze({
      status: 'CONFLICT',
      candidate: undefined,
      conflicts: Object.freeze(conflicts.map((c) => Object.freeze(c))),
    });
  }

  // Build candidate tree
  const manifestDigest = digestEntryManifest(candidateEntries);
  const candidate = Object.freeze({
    kind: 'tree',
    entries: Object.freeze(candidateEntries),
    manifestDigest,
  });

  return Object.freeze({
    status: 'MERGEABLE',
    candidate,
    conflicts: Object.freeze([]),
  });
}
