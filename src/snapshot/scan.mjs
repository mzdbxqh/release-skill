/**
 * Snapshot leakage scanner.
 *
 * Scans text files in a snapshot directory for:
 * 1. Configured `forbiddenPaths` entries.
 * 2. `/Users/` absolute paths (and Windows drive letters).
 * 3. Common token prefixes (`ghp_`, `github_pat_`, `npm_`, `AKIA`, etc.).
 * 4. PEM private key headers.
 * 5. Stale build artifacts: files in `dist/` whose hash no longer matches the
 *    manifest recorded in `dist/manifest.json`.
 *
 * **Critical security contract:** Finding messages and details MUST NOT contain
 * the raw matched secret value. Only the kind, location, and a generic
 * description are emitted.
 *
 * @module snapshot/scan
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, extname, posix, win32 } from 'node:path';
import { createHash } from 'node:crypto';

import { SECRET_DETECTED, STALE_BUILD_ARTIFACT, FORBIDDEN_CONTENT_DETECTED, CONFIG_INVALID } from '../core/errors.mjs';
import { ReleaseError } from '../core/errors.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Extensions of known binary files -- never read or scanned. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.wasm', '.bin', '.exe', '.dll', '.so', '.dylib', '.o', '.obj',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.webm',
  '.pdf', '.psd', '.ai', '.sketch',
  '.db', '.sqlite', '.sqlite3',
  '.node',
]);

/** Number of initial bytes to inspect for null-byte binary detection. */
const BINARY_PROBE_SIZE = 8192;

/**
 * Regex: platform absolute paths.
 * Matches concrete user, home, and temporary paths while leaving documentation placeholders
 * such as `/Users/...` alone.
 */
const ABSOLUTE_PATH_PATTERNS = [
  /\/(?:Users|home)\/[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[^\s"'`<>]*)?/,
  /\/(?:root|tmp)\/[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[^\s"'`<>]*)?/,
  /(?:^|[^A-Za-z0-9_])[A-Za-z]:\\[A-Za-z0-9_$-][A-Za-z0-9._$-]*(?:\\[^\s"'`<>]*)?/,
];

/**
 * Regex list: common secret token prefixes.
 * Each pattern matches a prefix followed by at least one non-whitespace
 * character. Word boundaries prevent false positives from substrings.
 */
const TOKEN_PATTERNS = [
  { name: 'ghp_', re: /\bghp_[A-Za-z0-9_]+/g },
  { name: 'github_pat_', re: /\bgithub_pat_[A-Za-z0-9_]+/g },
  // Granular npm config environment names (for example npm_config_registry)
  // are public identifiers, not credentials. Modern granular access tokens
  // have a long alphanumeric payload, so require enough payload characters to
  // avoid classifying those identifiers as secrets.
  { name: 'npm_', re: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { name: 'AKIA', re: /\bAKIA[A-Z0-9]{16,}/g },
  { name: 'sk-', re: /\bsk-[A-Za-z0-9_-]{10,}/g },
  { name: 'xoxb-', re: /\bxoxb-[A-Za-z0-9-]+/g },
  { name: 'xoxp-', re: /\bxoxp-[A-Za-z0-9-]+/g },
  { name: 'glpat-', re: /\bglpat-[A-Za-z0-9_-]+/g },
];

/**
 * Regex: PEM-encoded private key header.
 */
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all file paths under a directory.
 *
 * @param {string} dir - Absolute directory path.
 * @param {string} [base] - Base path for computing relative paths.
 * @returns {Promise<string[]>} Relative file paths (POSIX separators).
 */
async function collectFiles(dir, base = dir) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    // Skip .git directories
    if (entry.name === '.git') continue;

    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectFiles(abs, base);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(relative(base, abs));
    }
  }

  return results;
}

/**
 * Determine whether a file should be skipped because it is binary.
 * Uses extension allowlist and null-byte probing.
 *
 * @param {string} relPath - Relative file path.
 * @param {string} absPath - Absolute file path for content probing.
 * @returns {Promise<boolean>} `true` if the file should be skipped.
 */
async function isBinaryFile(relPath, absPath) {
  const ext = extname(relPath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;

  // Probe for null bytes in the first chunk
  let handle;
  try {
    const { open } = await import('node:fs/promises');
    handle = await open(absPath, 'r');
    const buf = Buffer.alloc(BINARY_PROBE_SIZE);
    const { bytesRead } = await handle.read(buf, 0, BINARY_PROBE_SIZE, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
  } catch {
    // If we cannot read the file, skip it (treat as binary)
    return true;
  } finally {
    if (handle) await handle.close();
  }

  return false;
}

// ---------------------------------------------------------------------------
// Per-file scanning
// ---------------------------------------------------------------------------

/**
 * Scan a single text file for all leakage patterns.
 *
 * @param {string} relPath - Relative path of the file.
 * @param {string} absPath - Absolute path of the file.
 * @param {string[]} forbiddenPaths - Policy forbidden paths.
 * @param {string[]} forbiddenContentPatterns - Policy forbidden content patterns.
 * @param {Set<string>} seenKinds - Dedup set of `kind:file` strings.
 * @returns {Promise<Finding[]>}
 */
async function scanFile(relPath, absPath, forbiddenPaths, forbiddenContentPatterns, seenKinds) {
  /** @type {Finding[]} */
  const findings = [];

  const normRel = relPath.replaceAll(win32.sep, posix.sep);
  const lowerRel = normRel.toLowerCase();
  const separators = [posix.sep, win32.sep];

  // 1. Configured forbidden paths
  for (const fp of forbiddenPaths) {
    const normFp = fp.replaceAll(win32.sep, posix.sep)
      .replace(/\/+$/, '')
      .toLowerCase();
    if (!normFp) continue;

    for (const sep of separators) {
      const prefix = normFp.endsWith(sep.toLowerCase())
        ? normFp
        : normFp + sep.toLowerCase();
      const checkPath = lowerRel + sep.toLowerCase();

      if (lowerRel === normFp || checkPath.startsWith(prefix)) {
        const dedupKey = `FORBIDDEN_PATH:${normFp}:${normRel}`;
        if (!seenKinds.has(dedupKey)) {
          seenKinds.add(dedupKey);
          findings.push({
            kind: 'PUBLIC_PATH_FORBIDDEN',
            file: normRel,
            message: `File is under a forbidden path "${fp}"`,
          });
        }
        break;
      }
    }
  }

  // Read file content
  let content;
  try {
    content = await readFile(absPath, 'utf8');
  } catch {
    return findings;
  }

  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // 2. Absolute paths
    if (ABSOLUTE_PATH_PATTERNS.some((pattern) => pattern.test(line))) {
      const key = `ABSOLUTE_PATH:${normRel}`;
      if (!seenKinds.has(key)) {
        seenKinds.add(key);
        findings.push({
          kind: 'PUBLIC_PATH_FORBIDDEN',
          file: normRel,
          line: lineNum,
          message: `Absolute path detected`,
        });
      }
    }

    // 3. Token prefixes
    for (const { name } of TOKEN_PATTERNS) {
      // Build a fresh regex for each check (stateful `g` flag)
      const tokenRe = TOKEN_PATTERNS.find(t => t.name === name).re;
      // Reset lastIndex
      tokenRe.lastIndex = 0;
      if (tokenRe.test(line)) {
        const key = `TOKEN:${name}:${normRel}`;
        if (!seenKinds.has(key)) {
          seenKinds.add(key);
          findings.push({
            kind: SECRET_DETECTED,
            file: normRel,
            line: lineNum,
            message: `Token pattern "${name}" detected`,
          });
        }
      }
    }

    // 4. Private key
    if (PRIVATE_KEY_RE.test(line)) {
      const key = `PRIVATE_KEY:${normRel}`;
      if (!seenKinds.has(key)) {
        seenKinds.add(key);
        findings.push({
          kind: SECRET_DETECTED,
          file: normRel,
          line: lineNum,
          message: 'Private key header detected',
        });
      }
    }

    // 5. Forbidden content patterns
    // Patterns are validated at scan entry point; all are valid regex.
    for (const pattern of forbiddenContentPatterns) {
      if (!pattern) continue;
      const re = new RegExp(pattern);
      if (re.test(line)) {
        const key = `FORBIDDEN_CONTENT:${pattern}:${normRel}`;
        if (!seenKinds.has(key)) {
          seenKinds.add(key);
          findings.push({
            kind: FORBIDDEN_CONTENT_DETECTED,
            file: normRel,
            line: lineNum,
            message: `Forbidden content pattern detected`,
          });
        }
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Stale dist detection
// ---------------------------------------------------------------------------

/**
 * Check dist/ files against `dist/manifest.json` for hash mismatches.
 *
 * @param {string} snapshotDir - Absolute snapshot directory.
 * @returns {Promise<Finding[]>}
 */
async function scanForStaleDist(snapshotDir) {
  /** @type {Finding[]} */
  const findings = [];
  const manifestPath = join(snapshotDir, 'dist', 'manifest.json');

  let manifest;
  try {
    const raw = await readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch {
    // No manifest -- cannot perform stale detection
    return findings;
  }

  if (!manifest.files || typeof manifest.files !== 'object') {
    return findings;
  }

  const distDir = join(snapshotDir, 'dist');

  for (const [fileRel, expectedHash] of Object.entries(manifest.files)) {
    if (typeof expectedHash !== 'string') continue;

    const fileAbs = join(distDir, fileRel);
    let actualContent;
    try {
      actualContent = await readFile(fileAbs);
    } catch {
      // File referenced in manifest but missing from dist
      findings.push({
        kind: STALE_BUILD_ARTIFACT,
        file: `dist/${fileRel}`,
        message: 'Build artifact referenced in manifest is missing',
      });
      continue;
    }

    const actualHash = createHash('sha256').update(actualContent).digest('hex');
    if (actualHash !== expectedHash) {
      findings.push({
        kind: STALE_BUILD_ARTIFACT,
        file: `dist/${fileRel}`,
        message: 'Build artifact hash does not match manifest',
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Finding
 * @property {string} kind - Error code (e.g. SECRET_DETECTED, STALE_BUILD_ARTIFACT, PUBLIC_PATH_FORBIDDEN).
 * @property {string} file - Relative path of the affected file.
 * @property {number} [line] - 1-based line number where the issue was found.
 * @property {string} message - Human-readable description (MUST NOT contain raw secret values).
 */

/**
 * @typedef {Object} ScanPolicy
 * @property {string[]} [forbiddenPaths] - Paths that must not appear in the snapshot.
 */

/**
 * Scan a snapshot directory for leakage patterns and stale build artifacts.
 *
 * @param {Object} options
 * @param {string} options.snapshotDir - Absolute path to the snapshot directory.
 * @param {ScanPolicy} [options.policy] - Scan policy configuration.
 * @returns {Promise<Finding[]>} Array of findings. Empty if the snapshot is clean.
 */
export async function scanSnapshot({ snapshotDir, policy = {} } = {}) {
  if (!snapshotDir || typeof snapshotDir !== 'string') {
    throw new TypeError('snapshotDir must be a non-empty string');
  }

  const { forbiddenPaths = [], forbiddenContentPatterns = [] } = policy;

  // Validate all forbiddenContentPatterns upfront — fail closed on invalid regex.
  // Patterns should also be validated at config load time, but scanSnapshot
  // must not silently skip invalid patterns when called directly.
  for (const pattern of forbiddenContentPatterns) {
    if (!pattern) continue;
    try {
      new RegExp(pattern);
    } catch (err) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `invalid regex in forbiddenContentPatterns: "${pattern}": ${err.message}`,
        { pattern, cause: err.message },
      );
    }
  }

  /** @type {Finding[]} */
  const allFindings = [];

  // Collect all files in the snapshot
  const relFiles = await collectFiles(snapshotDir);

  // Dedup sets to avoid reporting the same kind+file combination twice
  /** @type {Set<string>} */
  const seenKinds = new Set();
  for (const relPath of relFiles) {
    const absPath = join(snapshotDir, relPath);
    const normRel = relPath.replaceAll(win32.sep, posix.sep);

    // Skip binary files
    if (await isBinaryFile(relPath, absPath)) continue;

    // Per-file leakage scan
    const fileFindings = await scanFile(normRel, absPath, forbiddenPaths, forbiddenContentPatterns, seenKinds);
    allFindings.push(...fileFindings);

  }

  // Stale dist artifact detection
  const staleFindings = await scanForStaleDist(snapshotDir);
  allFindings.push(...staleFindings);

  return allFindings;
}
