/**
 * Closed-world artifact inventory builder.
 *
 * Enumerates every file that belongs to the artifact world:
 * 1. Git-tracked files (`git ls-files -z`)
 * 2. Relevant untracked files (`git ls-files -o --exclude-standard -z`)
 * 3. Tombstone entries from a previous lock (paths removed since last accept)
 *
 * Protocol-reserved directories (`.git/`, `.release-skill/runs/`,
 * `transactions/`, `resolution-worktree/`, `objects/`) are excluded from
 * enumeration. Policy, lock, and project config files inside `.release-skill/`
 * are NOT excluded — they are explicit closed-world entries.
 *
 * Each enumerated path is validated through `readEntry` which rejects
 * symlinks, hardlinks, and other dangerous filesystem types with PATH_UNSAFE.
 *
 * @module artifacts/inventory
 */

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import { readEntry, digestEntryManifest } from './entry.mjs';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Protocol-reserved directory prefixes (excluded from inventory)
// ---------------------------------------------------------------------------

/**
 * Paths starting with any of these prefixes are protocol-reserved and
 * excluded from the closed-world inventory.
 *
 * Note: `.release-skill/` itself is NOT reserved — only its `runs/`
 * subdirectory. Policy, lock, and project config files inside
 * `.release-skill/` remain inventory entries.
 */
const RESERVED_PREFIXES = Object.freeze([
  '.git/',
  '.release-skill/runs/',
  'transactions/',
  'resolution-worktree/',
  'objects/',
]);

/**
 * Check whether a relative path is inside a protocol-reserved directory.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
function isReservedPath(relPath) {
  // Exact match for directory names (without trailing slash)
  if (relPath === '.git' || relPath === 'transactions' || relPath === 'objects') {
    return true;
  }
  return RESERVED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command and return NUL-delimited output as an array of strings.
 *
 * @param {string} cwd - Working directory (repo root).
 * @param {string[]} args - Git arguments (must include -z or -rz).
 * @returns {Promise<string[]>} Split paths (empty strings filtered out).
 */
async function gitLsFilesRaw(cwd, args) {
  const { stdout } = await execFileAsync('git', ['ls-files', ...args], {
    cwd,
    shell: false,
    maxBuffer: 50 * 1024 * 1024,
  });
  // NUL-delimited; filter empty strings from trailing NUL
  return stdout.split('\0').filter((s) => s.length > 0);
}

/**
 * Check if a path exists on disk (file, directory, or symlink).
 *
 * @param {string} absPath
 * @returns {Promise<boolean>}
 */
async function pathExists(absPath) {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a closed-world inventory for a repository.
 *
 * The inventory captures every artifact entry that belongs to the current
 * release scope:
 * - Git-tracked files
 * - Relevant untracked files (not in .gitignore, not in reserved dirs)
 * - Tombstone entries for paths removed since the previous lock
 *
 * Each entry is read through `readEntry` which rejects symlinks and
 * hardlinks with PATH_UNSAFE.
 *
 * @param {object} options
 * @param {string} options.root - Repository root (absolute).
 * @param {object} options.policy - Validated artifact policy (must have `repository.id`).
 * @param {object} [options.previousLock] - Previous artifact-lock for tombstone recovery.
 * @param {string} [options.gitRef] - Git ref for base state (reserved for Task 4).
 * @returns {Promise<Inventory>}
 */
export async function buildInventory({ root, policy, previousLock, gitRef } = {}) {
  const repositoryId = policy.repository.id;

  // 1. Enumerate git-tracked files
  const tracked = await gitLsFilesRaw(root, ['-z']);

  // 2. Enumerate relevant untracked files (not in .gitignore, not tracked)
  const untracked = await gitLsFilesRaw(root, ['-o', '--exclude-standard', '-z']);

  // 3. Merge and deduplicate, filtering reserved paths
  const allPaths = new Set();
  for (const p of [...tracked, ...untracked]) {
    if (!isReservedPath(p)) {
      allPaths.add(p);
    }
  }

  // 4. Add tombstone entries from previous lock (paths that were accepted
  //    before but are no longer present on disk or in git)
  const tombstoneEntries = [];
  if (previousLock && Array.isArray(previousLock.entries)) {
    for (const lockEntry of previousLock.entries) {
      if (lockEntry.path && !allPaths.has(lockEntry.path)) {
        const absPath = `${root}/${lockEntry.path}`;
        const exists = await pathExists(absPath);
        if (!exists) {
          tombstoneEntries.push(
            Object.freeze({
              kind: 'absent',
              path: lockEntry.path,
            }),
          );
          allPaths.add(lockEntry.path);
        }
      }
    }
  }

  // 5. Read each enumerated path through readEntry (validates filesystem type)
  const fileEntries = [];
  for (const p of tracked) {
    if (!isReservedPath(p)) {
      fileEntries.push(await readEntry({ root, path: p, source: 'worktree' }));
    }
  }
  for (const p of untracked) {
    if (!isReservedPath(p)) {
      fileEntries.push(await readEntry({ root, path: p, source: 'worktree' }));
    }
  }

  // 6. Merge file entries with tombstone entries
  const entries = [...fileEntries, ...tombstoneEntries];

  // 7. Compute sorted paths and manifest digest
  const paths = Object.freeze([...allPaths].sort());

  return Object.freeze({
    repositoryId,
    entries: Object.freeze(entries),
    paths,
    manifestDigest: digestEntryManifest(
      entries.map((e) => ({
        path: e.path ?? '',
        type: e.type ?? (e.kind === 'absent' ? 'absent' : ''),
        mode: e.mode ?? '',
        sha256: e.sha256 ?? '',
        size: e.size ?? 0,
      })),
    ),
  });
}
