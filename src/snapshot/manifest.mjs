/**
 * Snapshot manifest: content-addressable inventory of a snapshot directory.
 *
 * A {@link SnapshotManifest} records every file in a snapshot directory with its
 * individual SHA-256 hash, the aggregate content hash of all file data, the
 * total file count, total byte size, and the generation timestamp.
 *
 * Hash algorithm is identical to {@link module:digest.sha256Hex}: SHA-256 via
 * Node.js `node:crypto` `createHash`, output as lowercase hex.
 *
 * The manifest is designed so that:
 * - Two runs over identical content always produce the same `contentHash`.
 * - `verifyManifest` can detect any modification (addition, removal, content
 *   change) to the snapshot directory after generation.
 *
 * @module snapshot/manifest
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types (documented via JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FileEntry
 * @property {string}  path - Relative path within the snapshot directory.
 * @property {string}  sha256 - Lowercase hex SHA-256 of the file content.
 * @property {number}  size - File size in bytes.
 */

/**
 * @typedef {Object} SnapshotManifest
 * @property {string}        version - Manifest schema version (`"1"`).
 * @property {string}        createdAt - ISO-8601 generation timestamp.
 * @property {string}        dir - The snapshot directory that was scanned.
 * @property {number}        fileCount - Number of files in the snapshot.
 * @property {number}        totalSize - Sum of all file sizes in bytes.
 * @property {string}        contentHash - Aggregate SHA-256 hex over all file
 *   contents, sorted by path, with each file's contribution separated by its
 *   relative path (ensuring order-independence between traversal strategies).
 * @property {FileEntry[]}   files - Per-file entries sorted by `path`.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all regular file paths in a directory, returning
 * paths relative to `root`.  Symlinks are resolved; directories named
 * `.git` are skipped.
 *
 * @param {string} root - Absolute directory to walk.
 * @returns {Promise<string[]>} Sorted array of relative paths.
 */
async function walkFiles(root) {
  const result = [];

  /** @param {string} dir */
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        result.push(relative(root, full));
      }
    }
  }

  await walk(root);
  result.sort();
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a {@link SnapshotManifest} for a directory.
 *
 * The content hash is computed deterministically:
 * 1. Each file is hashed individually (SHA-256).
 * 2. The aggregate content hash is the SHA-256 of the concatenation of
 *    `path + "\0" + fileSha256` for every file, in sorted path order.
 *    This design makes the hash independent of filesystem traversal order
 *    and the number of bytes in each file, while still binding the hash to
 *    the file path *and* content.
 *
 * @param {string} snapshotDir - Absolute path to the snapshot directory.
 * @returns {Promise<SnapshotManifest>}
 */
export async function generateManifest(snapshotDir) {
  const dir = resolve(snapshotDir);

  // Verify the directory exists
  const dirStat = await stat(dir);
  if (!dirStat.isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }

  const filePaths = await walkFiles(dir);

  const files = [];
  let totalSize = 0;

  // Hash each file and accumulate
  const aggregateHash = createHash('sha256');

  for (const relPath of filePaths) {
    const absPath = join(dir, relPath);
    const content = await readFile(absPath);
    const fileHash = createHash('sha256').update(content).digest('hex');

    files.push({
      path: relPath,
      sha256: fileHash,
      size: content.length,
    });

    totalSize += content.length;

    // Feed path + hash into aggregate (not file bytes), so the aggregate
    // hash is order-invariant with respect to the actual byte sequence but
    // still bound to path and content hash.
    aggregateHash.update(relPath);
    aggregateHash.update('\0');
    aggregateHash.update(fileHash);
    aggregateHash.update('\0');
  }

  const contentHash = aggregateHash.digest('hex');

  return {
    version: '1',
    createdAt: new Date().toISOString(),
    dir,
    fileCount: files.length,
    totalSize,
    contentHash,
    files,
  };
}

/**
 * Verify that a snapshot directory matches an existing manifest.
 *
 * Returns `true` if every file in the manifest exists in the directory with
 * the same SHA-256 hash, the file count and total size match, and no extra
 * files are present.
 *
 * Returns `false` if any mismatch is detected (file added, removed, content
 * changed, or size/count differs).
 *
 * This function never throws on verification mismatches -- it returns `false`
 * instead.  It only throws if the directory cannot be read or the manifest is
 * structurally invalid.
 *
 * @param {SnapshotManifest} manifest - A previously generated manifest.
 * @param {string} [snapshotDir] - Directory to verify.  Defaults to
 *   `manifest.dir`.
 * @returns {Promise<boolean>}
 */
export async function verifyManifest(manifest, snapshotDir) {
  const dir = resolve(snapshotDir ?? manifest.dir);

  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error('Invalid manifest: missing files array');
  }

  // Generate a fresh manifest for the directory
  const fresh = await generateManifest(dir);

  // Quick structural checks
  if (fresh.fileCount !== manifest.fileCount) {
    return false;
  }
  if (fresh.totalSize !== manifest.totalSize) {
    return false;
  }

  // Compare files entry-by-entry (both are sorted by path)
  if (fresh.files.length !== manifest.files.length) {
    return false;
  }

  for (let i = 0; i < fresh.files.length; i++) {
    const a = fresh.files[i];
    const b = manifest.files[i];
    if (a.path !== b.path || a.sha256 !== b.sha256 || a.size !== b.size) {
      return false;
    }
  }

  // Content hash comparison (deterministic re-derivation)
  if (fresh.contentHash !== manifest.contentHash) {
    return false;
  }

  return true;
}
