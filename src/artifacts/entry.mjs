/**
 * Artifact entry reader and manifest digest.
 *
 * Reads a single artifact entry from the working tree or git object store.
 * Entry kinds: 'absent' | 'regular' | 'tree'.
 *
 * Tree entries carry a manifestDigest computed from a canonical subset of
 * entry fields (path, type, mode, size, sha256) to enable deterministic
 * comparison without materialising full content.
 *
 * @module artifacts/entry
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import { ReleaseError, PATH_UNSAFE } from '../core/errors.mjs';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Paths to skip during recursive directory enumeration. */
const SKIP_DIRS = new Set(['.git']);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Node.js `stat.mode` (decimal) to a git-style octal mode string.
 *
 * Git uses a restricted subset of POSIX modes:
 * - '100644' — regular file
 * - '100755' — executable file
 * - '040000' — tree (directory)
 * - '120000' — symlink
 * - '160000' — gitlink (submodule)
 *
 * For files, group-write is stripped to produce '100644' unless the
 * executable bit is set, in which case '100755' is returned.
 *
 * @param {import('node:fs').Stats} stat
 * @returns {string} Git octal mode string.
 */
function statToGitMode(stat) {
  if (stat.isDirectory()) return '040000';
  if (stat.isSymbolicLink()) return '120000';
  // Regular file: check executable bit (owner + group + other)
  const mode = stat.mode & 0o777;
  const executable = (mode & 0o111) !== 0;
  return executable ? '100755' : '100644';
}

/**
 * Compute the git blob object ID (SHA-1) for a file's content.
 *
 * Uses `git hash-object` without `-w` so no objects are written to the
 * repository's object store.
 *
 * @param {string} root - Repository root (cwd for git).
 * @param {string} absPath - Absolute path to the file.
 * @returns {Promise<string>} 40-character hex SHA-1.
 */
async function gitHashObject(root, absPath) {
  const { stdout } = await execFileAsync(
    'git',
    ['hash-object', absPath],
    { cwd: root, shell: false },
  );
  return stdout.trim();
}

/**
 * Recursively enumerate files in a directory, returning entry metadata.
 *
 * Directories and files under `.git/` are skipped. Symbolic links and
 * hardlinks (nlink > 1) cause an immediate PATH_UNSAFE error (v1 policy).
 *
 * @param {string} root - Repository root (for git hash-object).
 * @param {string} dirPath - Absolute path to the directory being enumerated.
 * @param {string} relBase - Relative path prefix for entries within this tree.
 * @returns {Promise<Array<{path:string, type:string, mode:string, gitOid:string, sha256:string, size:number}>>}
 */
async function enumerateTreeEntries(root, dirPath, relBase) {
  const entries = [];
  const items = await readdir(dirPath, { withFileTypes: true });

  for (const item of items) {
    if (SKIP_DIRS.has(item.name)) continue;

    const absPath = join(dirPath, item.name);
    const relPath = relBase ? `${relBase}/${item.name}` : item.name;
    const st = await lstat(absPath);

    if (st.isSymbolicLink()) {
      throw new ReleaseError(
        PATH_UNSAFE,
        `symlink encountered in tree: ${relPath}`,
        { path: relPath },
      );
    }

    if (!st.isDirectory() && st.nlink > 1) {
      throw new ReleaseError(
        PATH_UNSAFE,
        `hardlink detected (nlink=${st.nlink}): ${relPath}`,
        { path: relPath, nlink: st.nlink },
      );
    }

    if (st.isDirectory()) {
      const subEntries = await enumerateTreeEntries(root, absPath, relPath);
      entries.push(...subEntries);
    } else {
      const content = await readFile(absPath);
      entries.push(
        Object.freeze({
          path: relPath,
          type: 'blob',
          mode: statToGitMode(st),
          gitOid: await gitHashObject(root, absPath),
          sha256: sha256Hex(content),
          size: st.size,
        }),
      );
    }
  }

  // Sort by path for deterministic ordering
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

// ---------------------------------------------------------------------------
// Manifest digest
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic manifest digest for a set of tree entries.
 *
 * The digest covers path, type, mode, size, and sha256 of each entry
 * (gitOid is excluded because it depends on the git hash algorithm, which
 * is SHA-1 in current git and not guaranteed stable across implementations).
 *
 * @param {Array<{path:string, type:string, mode:string, sha256:string, size:number}>} entries
 * @returns {string} `sha256:<hex>` digest.
 */
export function digestEntryManifest(entries) {
  const canonical = entries.map(({ path, type, mode, sha256, size }) => ({
    path, type, mode, size, sha256,
  }));
  return `sha256:${sha256Hex(canonicalJson(canonical))}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a single artifact entry from the working tree.
 *
 * Entry kinds:
 * - `{ kind: 'absent' }` — path does not exist on disk.
 * - `{ kind: 'regular', path, type, mode, gitOid, sha256, size }` — a single file.
 * - `{ kind: 'tree', entries, manifestDigest }` — a directory; `entries` is
 *   the recursive enumeration of all files within it.
 *
 * Symbolic links and hardlinks (nlink > 1) are rejected with PATH_UNSAFE
 * (v1 policy: writable/publish entries only allow absent, regular file, tree).
 *
 * @param {object} options
 * @param {string} options.root - Repository root (absolute).
 * @param {string} options.path - Relative POSIX path to the entry.
 * @param {'worktree'} [options.source='worktree'] - Read source.
 * @returns {Promise<ArtifactEntry>}
 * @throws {ReleaseError} PATH_UNSAFE on symlink or hardlink.
 */
export async function readEntry({ root, path, source = 'worktree' } = {}) {
  if (source !== 'worktree') {
    throw new ReleaseError(PATH_UNSAFE, `unsupported readEntry source: ${source}`, { source });
  }

  const absPath = join(root, path);

  let st;
  try {
    st = await lstat(absPath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return Object.freeze({ kind: 'absent' });
    }
    throw err;
  }

  // Symlinks are always unsafe (v1)
  if (st.isSymbolicLink()) {
    throw new ReleaseError(
      PATH_UNSAFE,
      `symlink encountered: ${path}`,
      { path },
    );
  }

  // Directory → tree entry with recursive manifest
  if (st.isDirectory()) {
    const entries = await enumerateTreeEntries(root, absPath, path);
    const manifestDigest = digestEntryManifest(entries);
    return Object.freeze({
      kind: 'tree',
      entries: Object.freeze(entries),
      manifestDigest,
    });
  }

  // Hardlink detection (v1: reject nlink > 1)
  if (st.nlink > 1) {
    throw new ReleaseError(
      PATH_UNSAFE,
      `hardlink detected (nlink=${st.nlink}): ${path}`,
      { path, nlink: st.nlink },
    );
  }

  // Regular file
  const content = await readFile(absPath);
  return Object.freeze({
    kind: 'regular',
    path,
    type: 'blob',
    mode: statToGitMode(st),
    gitOid: await gitHashObject(root, absPath),
    sha256: sha256Hex(content),
    size: st.size,
  });
}
