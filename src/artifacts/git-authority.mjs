/**
 * Git authority: repository identity, commit-tree reading, merge-base search,
 * and attribute safety gate.
 *
 * All git interactions use `execFile('git', args, { cwd, shell: false })` —
 * no shell strings, no network writes.
 *
 * @module artifacts/git-authority
 */

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  ReleaseError,
  BASE_UNAVAILABLE,
  LOCK_MIGRATION_REQUIRED,
  PATH_UNSAFE,
} from '../core/errors.mjs';
import { digestEntryManifest } from './entry.mjs';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command and return trimmed stdout.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, { cwd, shell: false });
  return stdout.trim();
}

/**
 * Compute SHA-256 hex of a string.
 *
 * @param {string} data
 * @returns {string}
 */
function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Check git attributes for dangerous settings (custom clean filter,
 * working-tree-encoding).
 *
 * When `commitRef` is provided, reads `.gitattributes` from the commit tree
 * and checks attributes using a temporary environment with `GIT_ATTR_SOURCE`
 * or by using `git check-attr` with the attributes sourced from the commit.
 * This ensures the attributes gate reflects the commit's own attributes,
 * not the working tree's.
 *
 * For git versions that support `--source=<commit>` (git 2.40+), that flag
 * is used directly. Otherwise, falls back to reading `.gitattributes` from
 * the commit tree and parsing them manually.
 *
 * @param {string} cwd - Repository root.
 * @param {string[]} paths - Paths to check.
 * @param {string|null} commitRef - Commit to source attributes from.
 * @throws {ReleaseError} PATH_UNSAFE on dangerous attributes.
 */
async function checkUnsafeAttributes(cwd, paths, commitRef = null) {
  if (paths.length === 0) return;

  // When commitRef is provided, check attributes from the commit tree only.
  // This ensures the gate reflects the commit's own attributes, not the
  // working tree's (which may have changed since the commit).
  if (commitRef) {
    // Try --source=<commit> first (git 2.40+)
    try {
      const args = ['check-attr', '-z', `--source=${commitRef}`, 'filter', 'working-tree-encoding', ...paths];
      const { stdout } = await execFileAsync('git', args, { cwd, shell: false });
      return parseAndCheckAttributes(stdout);
    } catch (err) {
      // --source not supported — fall through to commit-tree-based check
      if (!err.message?.includes('unknown option')) throw err;
    }

    // Fallback: parse .gitattributes from the commit tree directly
    return checkCommitAttributesFromTree(cwd, commitRef, paths);
  }

  // No commitRef — use working tree attributes
  const args = ['check-attr', '-z', 'filter', 'working-tree-encoding', ...paths];
  const { stdout } = await execFileAsync('git', args, { cwd, shell: false });
  parseAndCheckAttributes(stdout);
}

/**
 * Parse NUL-delimited git check-attr output and reject dangerous values.
 *
 * @param {string} stdout - NUL-delimited output.
 * @throws {ReleaseError} PATH_UNSAFE on dangerous attributes.
 */
function parseAndCheckAttributes(stdout) {
  const fields = stdout.split('\0').filter((s) => s.length > 0);
  if (fields.length === 0) return;

  for (let i = 0; i + 2 < fields.length; i += 3) {
    const attr = fields[i + 1];
    const value = fields[i + 2];
    if (attr === 'filter' || attr === 'working-tree-encoding') {
      if (value !== 'unspecified' && value !== 'unset') {
        throw new ReleaseError(
          PATH_UNSAFE,
          `dangerous git attribute "${attr}" = "${value}"`,
          { path: fields[i], attribute: attr, value },
        );
      }
    }
  }
}

/**
 * Check the commit's .gitattributes tree for dangerous settings.
 *
 * Reads the `.gitattributes` blob from the commit tree and parses it
 * to detect `filter=` or `working-tree-encoding=` attributes that the
 * working tree might not have.
 *
 * @param {string} cwd - Repository root.
 * @param {string} commitRef - Commit to check.
 * @param {string[]} paths - Paths to check against.
 * @throws {ReleaseError} PATH_UNSAFE on dangerous attributes.
 */
async function checkCommitAttributesFromTree(cwd, commitRef, paths) {
  let attrContent;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['cat-file', 'blob', `${commitRef}:.gitattributes`],
      { cwd, shell: false, encoding: 'utf8' },
    );
    attrContent = stdout;
  } catch {
    // No .gitattributes in the commit — safe
    return;
  }

  // Simple glob-based matching for the most common patterns
  // We only need to detect dangerous settings, not full attribute resolution
  const lines = attrContent.split('\n').filter((l) => l.trim() && !l.startsWith('#'));

  for (const line of lines) {
    const trimmed = line.trim();
    // Check for filter= or working-tree-encoding= in any attribute spec
    if (/\bfilter=/.test(trimmed) && !/\bfilter=\s*unspecified/.test(trimmed)) {
      // Check if any of our paths match the pattern
      const pattern = trimmed.split(/\s+/)[0];
      for (const p of paths) {
        if (matchesGitattributesPattern(pattern, p)) {
          throw new ReleaseError(
            PATH_UNSAFE,
            `dangerous git attribute "filter" in commit ${commitRef}'s .gitattributes`,
            { path: p, attribute: 'filter', commit: commitRef },
          );
        }
      }
    }
    if (/\bworking-tree-encoding=/.test(trimmed) && !/\bworking-tree-encoding=\s*unspecified/.test(trimmed)) {
      const pattern = trimmed.split(/\s+/)[0];
      for (const p of paths) {
        if (matchesGitattributesPattern(pattern, p)) {
          throw new ReleaseError(
            PATH_UNSAFE,
            `dangerous git attribute "working-tree-encoding" in commit ${commitRef}'s .gitattributes`,
            { path: p, attribute: 'working-tree-encoding', commit: commitRef },
          );
        }
      }
    }
  }
}

/**
 * Simple glob pattern matching for .gitattributes patterns.
 * Supports `*` wildcard and literal matches.
 *
 * @param {string} pattern - Gitattributes pattern (e.g. `*.md`, `file.txt`).
 * @param {string} path - Path to match against.
 * @returns {boolean}
 */
function matchesGitattributesPattern(pattern, path) {
  // Convert gitattributes glob to regex
  const regex = new RegExp(
    '^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.') + '$',
  );
  // Match against basename or full path
  return regex.test(path) || regex.test(path.split('/').pop());
}

/**
 * Parse NUL-separated `git ls-tree -rz` output into entry objects.
 *
 * Each line has the format: `<mode> <type> <oid>\t<path>`
 *
 * @param {string} raw - Raw NUL-delimited ls-tree output.
 * @returns {Array<{ path: string, gitOid: string, mode: string, type: string }>}
 */
function parseLsTree(raw) {
  if (!raw) return [];
  const entries = [];
  const chunks = raw.split('\0').filter((s) => s.length > 0);
  for (const chunk of chunks) {
    const tabIdx = chunk.indexOf('\t');
    if (tabIdx < 0) continue;
    const meta = chunk.slice(0, tabIdx);
    const path = chunk.slice(tabIdx + 1);
    const parts = meta.split(' ');
    if (parts.length < 3) continue;
    entries.push({ mode: parts[0], type: parts[1], gitOid: parts[2], path });
  }
  return entries;
}

/**
 * Get the blob content from the git object store.
 *
 * @param {string} cwd - Repository root.
 * @param {string} oid - Blob object ID.
 * @returns {Promise<Buffer>}
 */
async function gitCatFileBlob(cwd, oid) {
  const { stdout } = await execFileAsync(
    'git',
    ['cat-file', 'blob', oid],
    { cwd, shell: false, encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * List first-parent commit chain from HEAD.
 *
 * @param {string} cwd
 * @returns {Promise<string[]>} Commit hashes, HEAD first.
 */
async function revListFirstParent(cwd) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-list', '--first-parent', 'HEAD'],
      { cwd, shell: false },
    );
    return stdout.split('\n').filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/**
 * Read a tree recursively via `git ls-tree -rz` and build a manifest.
 *
 * @param {string} cwd - Repository root.
 * @param {string} treeRef - Tree-ish (commit, tree OID, etc.).
 * @param {string} treePath - Path to the tree within the commit.
 * @returns {Promise<{ type: 'tree', entries: object[], manifestDigest: string }>}
 */
async function readTreeRecursive(cwd, treeRef, treePath) {
  const { stdout: raw } = await execFileAsync(
    'git',
    ['ls-tree', '-rz', `${treeRef}:${treePath}`],
    { cwd, shell: false, maxBuffer: 50 * 1024 * 1024 },
  );
  const parsed = parseLsTree(raw);
  const entries = [];
  for (const pe of parsed) {
    // Paths within the tree are relative to treePath
    const fullPath = treePath ? `${treePath}/${pe.path}` : pe.path;
    if (pe.type === 'blob') {
      const content = await gitCatFileBlob(cwd, pe.gitOid);
      entries.push(
        Object.freeze({
          path: fullPath,
          type: 'blob',
          mode: pe.mode,
          gitOid: pe.gitOid,
          sha256: sha256Hex(content),
          size: content.length,
        }),
      );
    } else if (pe.type === 'tree') {
      // Recurse into subtree
      const sub = await readTreeRecursive(cwd, treeRef, fullPath);
      entries.push(...sub.entries);
    }
  }
  // Sort for deterministic ordering
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    type: 'tree',
    entries,
    manifestDigest: digestEntryManifest(entries),
  };
}

/**
 * Validate that a lock matches the designed authoritative shape.
 *
 * Old-format locks (missing `lockVersion` or `entries`) are rejected
 * as LOCK_MIGRATION_REQUIRED.
 *
 * @param {object} lock
 * @throws {ReleaseError} LOCK_MIGRATION_REQUIRED on old format.
 */
function validateLockFormat(lock) {
  if (!lock || typeof lock !== 'object') {
    throw new ReleaseError(
      BASE_UNAVAILABLE,
      'artifact lock is missing or invalid',
      {},
    );
  }
  // Old format detection: must have lockVersion and entries
  if (lock.lockVersion !== 1 || !lock.entries || typeof lock.entries !== 'object') {
    throw new ReleaseError(
      LOCK_MIGRATION_REQUIRED,
      'lock uses old format (missing lockVersion or entries); migration required',
      { field: 'lockFormat', reason: 'old artifactIds/manifestDigest format' },
    );
  }
}

/**
 * Compare lock entries against policy artifacts for path/ownership/driver changes.
 *
 * @param {object} lockEntries - Lock's `entries` object keyed by artifact ID.
 * @param {Array} policyArtifacts - Policy artifact definitions.
 * @throws {ReleaseError} LOCK_MIGRATION_REQUIRED on any change.
 */
function validateLockPolicyConsistency(lockEntries, policyArtifacts) {
  if (!Array.isArray(policyArtifacts) || policyArtifacts.length === 0) return;

  for (const pa of policyArtifacts) {
    const lockEntry = lockEntries[pa.id];
    if (!lockEntry) continue; // New artifact in policy — not a change to existing

    // Path change
    if (lockEntry.path && pa.path && lockEntry.path !== pa.path) {
      throw new ReleaseError(
        LOCK_MIGRATION_REQUIRED,
        `artifact "${pa.id}" path changed from "${lockEntry.path}" to "${pa.path}"`,
        { field: 'path', artifactId: pa.id, lockPath: lockEntry.path, policyPath: pa.path },
      );
    }

    // Ownership change
    const lockOwnership = lockEntry.ownership ?? lockEntries[pa.id]?.ownership;
    if (lockOwnership && pa.ownership && lockOwnership !== pa.ownership) {
      throw new ReleaseError(
        LOCK_MIGRATION_REQUIRED,
        `artifact "${pa.id}" ownership changed from "${lockOwnership}" to "${pa.ownership}"`,
        { field: 'ownership', artifactId: pa.id, lockOwnership, policyOwnership: pa.ownership },
      );
    }

    // Merge driver change
    const lockDriver = lockEntry.mergeDriver ?? lockEntries[pa.id]?.mergeDriver;
    if (lockDriver && pa.mergeDriver && lockDriver !== pa.mergeDriver) {
      throw new ReleaseError(
        LOCK_MIGRATION_REQUIRED,
        `artifact "${pa.id}" merge driver changed from "${lockDriver}" to "${pa.mergeDriver}"`,
        { field: 'mergeDriver', artifactId: pa.id, lockDriver, policyDriver: pa.mergeDriver },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the repository identity: gitDir, commonDir, and remoteUrlHash.
 *
 * `remoteUrlHash` is `sha256:<hex>` of the origin remote URL, or
 * `sha256:<64 zeros>` if no origin is configured.
 *
 * @param {string} root - Repository root (absolute).
 * @returns {Promise<{ gitDir: string, commonDir: string, remoteUrlHash: string }>}
 * @throws {ReleaseError} PATH_UNSAFE if not inside a git repository.
 */
export async function readRepositoryIdentity(root) {
  let gitDir;
  try {
    gitDir = await git(root, 'rev-parse', '--absolute-git-dir');
  } catch {
    throw new ReleaseError(PATH_UNSAFE, 'not inside a git repository', { root });
  }

  let commonDir;
  try {
    commonDir = await git(root, 'rev-parse', '--git-common-dir');
  } catch {
    commonDir = gitDir;
  }

  let remoteUrl = '';
  try {
    remoteUrl = await git(root, 'config', '--get', 'remote.origin.url');
  } catch {
    // No origin configured — use empty string.
  }

  const remoteUrlHash = remoteUrl
    ? `sha256:${sha256Hex(remoteUrl)}`
    : `sha256:${'0'.repeat(64)}`;

  return Object.freeze({ gitDir, commonDir, remoteUrlHash });
}

/**
 * Read artifact entries from a git commit tree for the given paths.
 *
 * Validates that no path has a custom `filter` or `working-tree-encoding`
 * git attribute set **in the specified commit** (not the working tree).
 * Uses `--source=<commit>` to read attributes from the commit tree.
 *
 * Supports three entry types:
 * - **absent**: path not found in the commit tree (skipped).
 * - **regular file**: blob entry with sha256 content digest.
 * - **tree**: directory entry — recursed via `git ls-tree -rz` to build
 *   a complete manifest with deterministic digest.
 *
 * Rejects symlink mode `120000`, gitlink `160000` with PATH_UNSAFE.
 *
 * @param {object} options
 * @param {string} options.root - Repository root (absolute).
 * @param {string} options.commit - Commit hash or ref.
 * @param {string[]} options.paths - Artifact paths to read.
 * @returns {Promise<Map<string, object>>} Map of path → ArtifactEntry.
 * @throws {ReleaseError} PATH_UNSAFE on dangerous git attributes or entry types.
 */
export async function readCommitEntries({ root, commit, paths } = {}) {
  if (paths.length === 0) return new Map();

  // Check for dangerous git attributes against the COMMIT tree, not working tree
  await checkUnsafeAttributes(root, paths, commit);

  const result = new Map();

  for (const path of paths) {
    // Determine the object type at this path in the commit tree.
    // `git ls-tree -rz <commit> <path>` returns blob/tree entries directly.
    // For directories, it returns the contents (not the tree entry itself).
    // We use `git cat-file -t <commit>:<path>` to detect the type first.
    let objectType;
    try {
      objectType = await git(root, 'cat-file', '-t', `${commit}:${path}`);
    } catch {
      // Path does not exist in the commit tree — skip (absent)
      continue;
    }

    if (objectType === 'tree') {
      // Tree entry: recurse via git ls-tree to build complete manifest
      const treeManifest = await readTreeRecursive(root, commit, path);

      // Get the tree OID
      const treeOid = await git(root, 'rev-parse', `${commit}:${path}`);

      result.set(path, Object.freeze({
        path,
        type: 'tree',
        mode: '040000',
        gitOid: treeOid,
        entries: Object.freeze(treeManifest.entries),
        manifestDigest: treeManifest.manifestDigest,
      }));
    } else if (objectType === 'blob') {
      // Get the blob entry metadata via ls-tree
      const { stdout: raw } = await execFileAsync(
        'git',
        ['ls-tree', '-rz', commit, path],
        { cwd: root, shell: false, maxBuffer: 50 * 1024 * 1024 },
      );
      const treeEntries = parseLsTree(raw);
      const te = treeEntries[0];
      if (!te) continue;

      // Reject unsafe entry types
      if (te.mode === '120000') {
        throw new ReleaseError(
          PATH_UNSAFE,
          `symlink mode 120000 rejected for "${path}"`,
          { path, mode: te.mode },
        );
      }
      if (te.mode === '160000') {
        throw new ReleaseError(
          PATH_UNSAFE,
          `gitlink mode 160000 rejected for "${path}"`,
          { path, mode: te.mode },
        );
      }

      const content = await gitCatFileBlob(root, te.gitOid);
      result.set(
        path,
        Object.freeze({
          path,
          type: 'blob',
          mode: te.mode,
          gitOid: te.gitOid,
          sha256: sha256Hex(content),
          size: content.length,
        }),
      );
    }
    // Other types (tag, commit) are skipped
  }

  return result;
}

/**
 * Find the first ancestor commit in first-parent history whose artifact
 * manifest digest matches the lock's accepted manifest.
 *
 * Validates:
 * - Lock uses the new format (`lockVersion: 1` with `entries`); old format
 *   (`artifactIds/manifestDigest`) → LOCK_MIGRATION_REQUIRED.
 * - Lock's `repositoryIdentity.remoteUrlHash` matches the current repository's
 *   remoteUrlHash (not absolute gitDir).
 * - Lock's `policyDigest` matches the caller-provided policyDigest (if any).
 * - Each lock entry's path/ownership/mergeDriver matches policy artifacts (if any).
 * - Base search checks entries' path/type/mode/gitOid/sha256 against commit tree
 *   and compares `acceptedArtifactManifestDigest`.
 *
 * On missing ancestor: `BASE_UNAVAILABLE.details.nextAction.command` is a
 * read-only fetch bound to the repository's remoteUrlHash.
 *
 * @param {object} options
 * @param {string} options.root - Repository root (absolute).
 * @param {object} options.lock - Artifact lock object (new format).
 * @param {string} [options.policyDigest] - Current policy digest to compare against lock.
 * @param {Array} [options.policyArtifacts] - Policy artifact definitions for change detection.
 * @returns {Promise<string>} Commit hash of the matching ancestor.
 * @throws {ReleaseError} LOCK_MIGRATION_REQUIRED on identity/policy/format mismatch.
 * @throws {ReleaseError} BASE_UNAVAILABLE if no matching ancestor is found.
 */
export async function findMergeBaseCommit({ root, lock, policyDigest, policyArtifacts } = {}) {
  // Validate lock format (new authoritative shape)
  validateLockFormat(lock);

  // Validate lock has required identity fields
  if (!lock.repositoryIdentity || !lock.repositoryIdentity.remoteUrlHash) {
    throw new ReleaseError(
      LOCK_MIGRATION_REQUIRED,
      'lock missing repositoryIdentity.remoteUrlHash',
      { field: 'repositoryIdentity' },
    );
  }

  if (!lock.acceptedArtifactManifestDigest) {
    throw new ReleaseError(
      BASE_UNAVAILABLE,
      'lock missing acceptedArtifactManifestDigest',
      {},
    );
  }

  // Validate repository identity matches via remoteUrlHash (not absolute gitDir)
  const identity = await readRepositoryIdentity(root);
  if (identity.remoteUrlHash !== lock.repositoryIdentity.remoteUrlHash) {
    throw new ReleaseError(
      LOCK_MIGRATION_REQUIRED,
      'lock repositoryIdentity.remoteUrlHash does not match current repository',
      {
        field: 'repositoryIdentity',
        lockRemoteUrlHash: lock.repositoryIdentity.remoteUrlHash,
        currentRemoteUrlHash: identity.remoteUrlHash,
      },
    );
  }

  // Validate policy digest consistency
  if (policyDigest && lock.policyDigest && policyDigest !== lock.policyDigest) {
    throw new ReleaseError(
      LOCK_MIGRATION_REQUIRED,
      'policy digest changed since lock was created',
      {
        field: 'policyDigest',
        lockPolicyDigest: lock.policyDigest,
        currentPolicyDigest: policyDigest,
      },
    );
  }

  // Validate policy artifact changes (path/ownership/driver)
  validateLockPolicyConsistency(lock.entries, policyArtifacts);

  // Compute artifact paths from lock entries for base search
  const artifactPaths = Object.values(lock.entries).map((entry) => entry.path);
  if (artifactPaths.some((path) => typeof path !== 'string' || path.length === 0)) {
    throw new ReleaseError(
      LOCK_MIGRATION_REQUIRED,
      'lock contains an entry without a canonical path',
      { field: 'entries.path' },
    );
  }

  // Walk first-parent history looking for matching manifest digest
  const commits = await revListFirstParent(root);
  for (const commit of commits) {
    const entries = await readCommitEntries({ root, commit, paths: artifactPaths });
    const entryArray = [...entries.values()];
    const computedDigest = digestEntryManifest(entryArray);
    if (computedDigest === lock.acceptedArtifactManifestDigest) {
      return commit;
    }
  }

  // No matching ancestor found — provide a fetch command bound to remoteUrlHash
  throw new ReleaseError(
    BASE_UNAVAILABLE,
    'no reachable ancestor matches the accepted artifact manifest',
    {
      remoteUrlHash: identity.remoteUrlHash,
      lockManifestDigest: lock.acceptedArtifactManifestDigest,
      nextAction: {
        command: `git fetch --no-tags origin --deepen=100`,
      },
    },
  );
}
