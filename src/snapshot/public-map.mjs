/**
 * Explicit public mapping and snapshot fidelity for release units.
 *
 * Provides two public functions:
 * - `normalizePublicMappings({ unit })` — converts repository-relative
 *   `publicFiles.from` paths to source-relative paths.
 * - `buildPublicStaging({ sourceRoot, unit, outputDir })` — reads each
 *   mapped source file, rejects symlinks/special files/hardlinks, copies
 *   exact bytes and mode, and verifies requiredPublicFiles.
 *
 * Safety checks:
 * - `from` must reside inside `unit.source` (no escaping the unit).
 * - Paths must not escape the repository root (path traversal rejected).
 * - Symlinks, block/char devices, and hardlinks are rejected.
 * - Duplicate targets, case-fold collisions, and NFC collisions are rejected.
 * - Non-empty staging directories are rejected (fail closed).
 * - Missing required public files produce `PUBLIC_FILE_MISSING`.
 * - Post-copy content digest, byte count, type, and mode mismatches
 *   produce `SNAPSHOT_FIDELITY_FAILED`.
 *
 * @module snapshot/public-map
 */

import { lstat, readFile, mkdir, readdir, realpath, chmod as fsChmod } from 'node:fs/promises';
import { open as fsOpen } from 'node:fs/promises';
import { relative, resolve, dirname, sep as pathSep, isAbsolute } from 'node:path';
import { posix } from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  ReleaseError,
  PUBLIC_FILE_MISSING,
  PUBLIC_PATH_FORBIDDEN,
  SNAPSHOT_FIDELITY_FAILED,
  CONFIG_INVALID,
} from '../core/errors.mjs';
import { canonicalPublicPath, publicPathCollisionKey } from './public-path.mjs';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fsConstants;

// O_NOFOLLOW capability check — must be numeric and nonzero.
// If the platform does not define O_NOFOLLOW, fail closed rather than
// silently degrading to follow symlinks.
if (typeof O_NOFOLLOW !== 'number' || O_NOFOLLOW === 0) {
  throw new ReleaseError(
    SNAPSHOT_FIDELITY_FAILED,
    'O_NOFOLLOW is not available on this platform; refusing to degrade symlink safety',
    { O_NOFOLLOW },
  );
}

// Resource limits
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MiB
const MAX_MAPPINGS = 100000;
const MAX_PATH_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Containment helper (exported for cross-platform canary testing)
// ---------------------------------------------------------------------------

/**
 * Pure containment check using injected path helpers.
 *
 * Returns true only when `candidate` is strictly inside `root`:
 * - Empty relative path (candidate === root) → false (root is not inside itself)
 * - Relative path starting with `..` → false (candidate escapes root)
 * - Absolute relative path (e.g. `D:\<path>` from `C:\<root>` on Windows) → false
 *   (cross-device escape detected by checking `isAbsolute(rel)`)
 *
 * The `relPathSep` parameter allows matching the `..` prefix to the correct
 * path separator for the `relativeFn` implementation (POSIX uses `/`,
 * win32 uses `\`).
 *
 * @param {function} relativeFn - e.g. `path.relative` or `path.win32.relative`.
 * @param {function} isAbsoluteFn - e.g. `path.isAbsolute` or `path.win32.isAbsolute`.
 * @param {string} root - Absolute root directory.
 * @param {string} candidate - Absolute candidate path.
 * @param {string} [relPathSep=pathSep] - Path separator to match `..` prefix.
 * @returns {boolean} true if candidate is strictly inside root.
 */
export function _isContainedWith(relativeFn, isAbsoluteFn, root, candidate, relPathSep = pathSep) {
  const rel = relativeFn(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${relPathSep}`) && !isAbsoluteFn(rel);
}

/**
 * Platform-native containment check.
 *
 * Delegates to `_isContainedWith` using the current platform's `path.relative`
 * and `path.isAbsolute`.
 *
 * @param {string} root - Absolute root directory.
 * @param {string} candidate - Absolute candidate path.
 * @returns {boolean} true if candidate is strictly inside root.
 */
function isContained(root, candidate) {
  return _isContainedWith(relative, isAbsolute, root, candidate);
}

// ---------------------------------------------------------------------------
// Private path helpers
// ---------------------------------------------------------------------------

/**
 * Check that no ancestor of `filePath` is a symlink.
 *
 * Walks from `root` towards `filePath`, checking each path component with
 * lstat (no follow). Rejects with PUBLIC_PATH_FORBIDDEN if any component
 * is a symlink.
 *
 * @param {string} root - Repository root (absolute).
 * @param {string} filePath - Absolute file path to check.
 */
async function assertNoAncestorSymlinks(root, filePath, fs = { lstat }) {
  const rel = relative(root, filePath);
  const segments = rel.split(/[/\\]/);
  let current = root;

  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const st = await fs.lstat(current, { stage: 'source-ancestor' });
      if (st.isSymbolicLink()) {
        throw new ReleaseError(
          PUBLIC_PATH_FORBIDDEN,
          `symlink in path component: "${current}"`,
          { path: current, root },
        );
      }
    } catch (err) {
      if (err instanceof ReleaseError) throw err;
      // ENOENT is acceptable — the file itself may not exist yet.
      if (err.code !== 'ENOENT') {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `cannot check path component: "${current}": ${err.message}`,
          { path: current, cause: err.code },
        );
      }
    }
  }
}

/**
 * Walk the outputDir ancestor chain checking each EXISTING component.
 *
 * Every existing component must be a real directory — symlinks are rejected
 * regardless of their target type. No "benign system symlink" exception.
 * Test helpers should call `realpath(tmpRoot)` to resolve macOS
 * `/var → /private/var` before constructing output paths.
 *
 * @param {string} effectiveOutputDir - Absolute resolved output directory.
 */
async function assertOutputAncestorsNoFollow(effectiveOutputDir, fs = { lstat }) {
  const parts = effectiveOutputDir.split(pathSep).filter(Boolean);
  let accumulated = '';

  for (const part of parts) {
    accumulated = accumulated ? `${accumulated}${pathSep}${part}` : `${pathSep}${part}`;

    try {
      const partStat = await fs.lstat(accumulated, { stage: 'output-ancestor' });

      if (partStat.isSymbolicLink()) {
        // Symlink in ancestor chain — always reject.
        // Test helpers must use realpath(tmpRoot) to avoid false positives
        // from macOS /var → /private/var.
        throw new ReleaseError(
          CONFIG_INVALID,
          `outputDir ancestor is a symlink: "${accumulated}"`,
          { outputDir: effectiveOutputDir, symlinkAncestor: accumulated },
        );
      }

      if (!partStat.isDirectory()) {
        throw new ReleaseError(
          CONFIG_INVALID,
          `outputDir ancestor is not a directory: "${accumulated}"`,
          { outputDir: effectiveOutputDir, ancestor: accumulated },
        );
      }
    } catch (err) {
      if (err instanceof ReleaseError) throw err;
      if (err.code === 'ENOENT') {
        // This component doesn't exist yet — it will be created fresh.
        // Its parent (the last existing component) has already been
        // verified as a non-symlink directory by the previous iteration.
        break;
      }
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `cannot inspect outputDir ancestor: ${err.message}`,
        { outputDir: effectiveOutputDir, ancestor: accumulated, cause: err.code },
      );
    }
  }
}

/**
 * Walk the destination path from the real output root to the destination
 * file, checking each EXISTING component with lstat (no follow).
 *
 * This detects inter-mapping symlink injection where a previous mapping's
 * _afterCopy replaced an output directory with a symlink to an external
 * location. Must be called AFTER mkdir(destDir) and BEFORE open(destPath)
 * to catch symlinks that mkdir follows through.
 *
 * @param {string} realOutputRoot - Fixed real output root (realpath-resolved).
 * @param {string} destPath - Absolute destination file path.
 */
async function assertDestAncestorsNoFollow(realOutputRoot, destPath, fs = { lstat }) {
  // Walk from realOutputRoot to destPath, checking each component.
  // The realOutputRoot is already verified as a real directory.
  const relDest = relative(realOutputRoot, destPath);
  const segments = relDest.split(pathSep).filter(Boolean);
  let current = realOutputRoot;

  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const st = await fs.lstat(current, { stage: 'dest-ancestor' });
      if (st.isSymbolicLink()) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `destination ancestor is a symlink: "${current}"`,
          { destPath, symlinkAncestor: current, realOutputRoot },
        );
      }
      // The component is a real directory (for ancestors) or file (for leaf).
      // Ancestors must be directories; the leaf will be verified separately.
      if (segment !== segments[segments.length - 1] && !st.isDirectory()) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `destination ancestor is not a directory: "${current}"`,
          { destPath, ancestor: current, realOutputRoot },
        );
      }
    } catch (err) {
      if (err instanceof ReleaseError) throw err;
      if (err.code === 'ENOENT') {
        // This component doesn't exist — expected for the leaf file.
        break;
      }
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `cannot inspect destination ancestor: "${current}": ${err.message}`,
        { destPath, ancestor: current, cause: err.code },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalise public file mappings for a release unit.
 *
 * Converts each `publicFiles.from` path from a repository-relative path
 * to a source-relative path by stripping the source prefix. The canonical
 * `from` path must reside inside `unit.source`; paths outside produce
 * `PUBLIC_PATH_FORBIDDEN`.
 *
 * @param {Object} options
 * @param {object} options.unit - Release unit configuration.
 * @param {string} options.unit.source - Relative source directory.
 * @param {object[]} options.unit.publicFiles - Array of `{ from, to, mode }`.
 *
 * @returns {ReadonlyArray<{ from: string, sourceRelative: string, to: string, mode: string }>}
 */
export function normalizePublicMappings({ unit } = {}) {
  if (!unit || !Array.isArray(unit.publicFiles)) {
    throw new ReleaseError(CONFIG_INVALID, 'unit.publicFiles must be an array');
  }

  // unit.source uses allowDot for standalone `.` as valid source.
  const sourcePrefix = canonicalPublicPath(unit.source, { allowDot: true }).path;

  return Object.freeze(
    unit.publicFiles.map((mapping) => {
      const from = canonicalPublicPath(mapping.from).path;
      const sourceRelative = posix.relative(sourcePrefix, from);

      // Reject `from` paths that escape `unit.source`.
      if (sourceRelative.startsWith('../') || sourceRelative === '..') {
        throw new ReleaseError(
          PUBLIC_PATH_FORBIDDEN,
          `public file "${mapping.from}" is outside unit source "${unit.source}"`,
          { from: mapping.from, source: unit.source, sourceRelative },
        );
      }

      return Object.freeze({
        from,
        sourceRelative,
        to: canonicalPublicPath(mapping.to).path,
        mode: mapping.mode,
      });
    }),
  );
}

/**
 * Build a public staging directory from explicit public file mappings.
 *
 * For each mapping, reads `resolve(sourceRoot, mapping.from)`,
 * rejects symlinks/special files/hardlinks, copies exact bytes and mode to
 * `outputDir/to`, and records the entry in the manifest.
 *
 * After all entries are collected, checks that every file listed in
 * `unit.requiredPublicFiles` appears in the manifest. Missing files
 * produce `PUBLIC_FILE_MISSING`.
 *
 * The `outputDir` must either not exist or be empty. A non-empty
 * staging directory is rejected to prevent overwriting stale artifacts.
 *
 * @param {Object} options
 * @param {string} options.sourceRoot - Absolute source root (repository root).
 * @param {object} options.unit - Release unit configuration.
 * @param {string} [options.outputDir] - Output directory for staged files.
 *   If not provided, a temporary directory is created.
 *
 * @returns {Promise<SnapshotManifest>}
 * @throws {ReleaseError} PUBLIC_FILE_MISSING if a required file is absent.
 * @throws {ReleaseError} PUBLIC_PATH_FORBIDDEN if a path escapes the source.
 * @throws {ReleaseError} SNAPSHOT_FIDELITY_FAILED on integrity mismatch.
 * @throws {ReleaseError} CONFIG_INVALID on duplicate targets or non-empty staging.
 */
export async function buildPublicStaging({
  sourceRoot,
  unit,
  outputDir,
  /**
   * Internal test hook — called after each file copy, before fidelity
   * verification. Default is a no-op. Injected by fidelity tests to
   * simulate content or mode corruption deterministically.
   *
   * @param {{ destPath: string, srcPath: string }} ctx
   */
  _afterCopy = async () => {},
  /**
   * Internal test hook — called between preflight and source open.
   * Default is a no-op. Injected by fidelity tests to simulate source
   * mutations between lstat and open (e.g., mode change).
   *
   * @param {{ srcPath: string }} ctx
   */
  _beforeOpen = async () => {},
  /**
   * Stage hook — called after source readFile() but before post-read stat().
   * Allows tests to mutate the source file between read and verification
   * (e.g., chmod same inode, same-length overwrite).
   *
   * @param {{ srcPath: string, content: Buffer }} ctx
   */
  _afterSourceRead = async () => {},
  /**
   * Stage hook — called after destination readFile() but before post-read
   * stat(). Allows tests to mutate the destination between read and
   * verification (e.g., change mode/size of same inode).
   *
   * @param {{ destPath: string }} ctx
   */
  _afterDestRead = async () => {},
  /**
   * Internal FS dependency injection — allows deterministic error injection
   * for testing. NOT exposed through the public buildSnapshot adapter.
   * Each function defaults to the real fs function when not provided.
   */
  _fsOps = {},
  /**
   * Legacy input — must not be provided. Rejects with CONFIG_INVALID
   * to prevent implicit file collection.
   */
  generatedFiles,
} = {}) {
  // Detect NFC/case collisions from the raw spellings before canonicalization
  // collapses them to the same string. This preserves an actionable diagnostic.
  const rawTargetByKey = new Map();
  for (const mapping of unit?.publicFiles ?? []) {
    const raw = mapping?.to;
    if (typeof raw !== 'string') continue;
    const nfc = raw.normalize('NFC');
    const key = nfc.toLowerCase();
    const existing = rawTargetByKey.get(key);
    if (existing !== undefined) {
      if (existing === raw) {
        throw new ReleaseError(CONFIG_INVALID, `duplicate public file target: "${raw}"`, { target: raw });
      }
      const existingNfc = existing.normalize('NFC');
      const kind = existingNfc === nfc ? 'NFC' : 'case-fold';
      throw new ReleaseError(
        CONFIG_INVALID,
        `${kind} collision on target: "${raw}" and "${existing}"`,
        { target: raw, existing },
      );
    }
    rawTargetByKey.set(key, raw);
  }

  // Reject legacy generatedFiles input — fail closed
  if (generatedFiles !== undefined) {
    throw new ReleaseError(
      CONFIG_INVALID,
      'generatedFiles is not allowed; use explicit publicFiles mappings',
      { generatedFiles },
    );
  }

  if (!sourceRoot || typeof sourceRoot !== 'string') {
    throw new ReleaseError(CONFIG_INVALID, 'sourceRoot must be a non-empty string');
  }
  if (!unit || typeof unit.source !== 'string') {
    throw new ReleaseError(CONFIG_INVALID, 'unit.source must be a non-empty string');
  }
  if (!Array.isArray(unit.publicFiles)) {
    throw new ReleaseError(CONFIG_INVALID, 'unit.publicFiles must be an array');
  }

  // --- Resolve FS operations (allow DI override for testing) ---
  // All _fsOps functions receive {operation, path, stage} context for
  // deterministic test injection. When _fsOps provides a function, it is
  // wrapped to receive the context; otherwise the real fs function is used.
  // This ensures tests can match by exact path+stage, not call count.
  const fs = {
    lstat: _fsOps.lstat
      ? (p, ctx) => _fsOps.lstat({ operation: 'lstat', path: p, ...ctx })
      : lstat,
    realpath: _fsOps.realpath
      ? (p, ctx) => _fsOps.realpath({ operation: 'realpath', path: p, ...ctx })
      : realpath,
    readFile: _fsOps.readFile
      ? (p, ctx) => _fsOps.readFile({ operation: 'readFile', path: p, ...ctx })
      : readFile,
    open: _fsOps.open
      ? (p, flags, mode, ctx) => _fsOps.open({ operation: 'open', path: p, flags, mode, ...ctx })
      : fsOpen,
    mkdir: _fsOps.mkdir
      ? (p, opts, ctx) => _fsOps.mkdir({ operation: 'mkdir', path: p, opts, ...ctx })
      : mkdir,
    readdir: _fsOps.readdir
      ? (p, ctx) => _fsOps.readdir({ operation: 'readdir', path: p, ...ctx })
      : readdir,
    chmod: _fsOps.chmod
      ? (p, mode, ctx) => _fsOps.chmod({ operation: 'chmod', path: p, mode, ...ctx })
      : fsChmod,
  };

  // --- sourceRoot must be a real directory, not a symlink ---
  // Use lstat (no follow) to detect if sourceRoot itself is a symlink.
  let realSourceRoot;
  try {
    const rootStat = await fs.lstat(sourceRoot, { stage: 'source-root' });
    if (rootStat.isSymbolicLink()) {
      throw new ReleaseError(
        PUBLIC_PATH_FORBIDDEN,
        `sourceRoot is a symlink: "${sourceRoot}"`,
        { sourceRoot },
      );
    }
    // Fix the real path of sourceRoot for all subsequent containment checks.
    realSourceRoot = await fs.realpath(sourceRoot, { stage: 'source-root-realpath' });
  } catch (err) {
    if (err instanceof ReleaseError) throw err;
    const code = err.code ?? 'UNKNOWN';
    // ENOENT means sourceRoot doesn't exist — config issue.
    // EACCES/EIO etc. are FS fidelity issues.
    const errorCode = code === 'ENOENT' ? CONFIG_INVALID : SNAPSHOT_FIDELITY_FAILED;
    throw new ReleaseError(
      errorCode,
      `cannot inspect sourceRoot: ${err.message}`,
      { sourceRoot, cause: code },
    );
  }

  const mappings = normalizePublicMappings({ unit });

  // Resource limit: number of mappings
  if (mappings.length > MAX_MAPPINGS) {
    throw new ReleaseError(
      SNAPSHOT_FIDELITY_FAILED,
      `too many mappings: ${mappings.length} (max ${MAX_MAPPINGS})`,
      { count: mappings.length, limit: MAX_MAPPINGS },
    );
  }

  // --- Fix real unit root for containment checks ---
  const unitRootLexical = resolve(sourceRoot, unit.source);
  let realUnitRoot;
  try {
    realUnitRoot = await fs.realpath(unitRootLexical, { stage: 'unit-root-realpath' });
  } catch (err) {
    const code = err.code ?? 'UNKNOWN';
    // ENOENT means unit source directory doesn't exist — config issue.
    // EACCES/EIO etc. are FS fidelity issues.
    const errorCode = code === 'ENOENT' ? CONFIG_INVALID : SNAPSHOT_FIDELITY_FAILED;
    throw new ReleaseError(
      errorCode,
      `cannot resolve unit source root: ${err.message}`,
      { sourceRoot, unitSource: unit.source, cause: code },
    );
  }

  const effectiveOutputDir = resolve(
    outputDir ?? resolve(sourceRoot, '.release-skill', 'staging'),
  );

  // =======================================================================
  // PREFLIGHT: Validate ALL source mappings before any file I/O.
  // This ensures that if any mapping is invalid, no destination files are
  // created and the outputDir remains untouched (zero file writes).
  // =======================================================================
  const preflightRecords = [];
  const requiredTargetSet = new Set(unit.requiredPublicFiles ?? []);

  for (const mapping of mappings) {
    const srcPath = resolve(sourceRoot, mapping.from);
    const destPath = resolve(effectiveOutputDir, mapping.to);

    // Resource limit: path length
    if (srcPath.length > MAX_PATH_LENGTH || destPath.length > MAX_PATH_LENGTH) {
      preflightRecords.push({
        ok: false,
        err: new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `path too long: source=${srcPath.length}, dest=${destPath.length} (max ${MAX_PATH_LENGTH})`,
          { from: mapping.from, to: mapping.to, limit: MAX_PATH_LENGTH },
        ),
      });
      continue;
    }

    // Lexical containment: source path must be inside realSourceRoot.
    // Uses unified isContained() to reject traversal, cross-device, and root equality.
    if (!isContained(realSourceRoot, srcPath)) {
      preflightRecords.push({
        ok: false,
        err: new ReleaseError(
          PUBLIC_PATH_FORBIDDEN,
          `source file escapes sourceRoot: "${mapping.from}"`,
          { from: mapping.from, sourceRoot },
        ),
      });
      continue;
    }

    // Check for symlinks in ancestor directories (walk from sourceRoot)
    try {
      await assertNoAncestorSymlinks(sourceRoot, srcPath, fs);
    } catch (err) {
      preflightRecords.push({ ok: false, err });
      continue;
    }

    // Realpath containment: resolved source must be inside realSourceRoot.
    try {
      const realSrc = await fs.realpath(srcPath, { stage: 'source-preflight-realpath' });
      if (!isContained(realSourceRoot, realSrc)) {
        preflightRecords.push({
          ok: false,
          err: new ReleaseError(
            PUBLIC_PATH_FORBIDDEN,
            `source file escapes sourceRoot via realpath: "${mapping.from}"`,
            { from: mapping.from, realSrc, sourceRoot },
          ),
        });
        continue;
      }
      // Also check real containment inside unit root
      if (!isContained(realUnitRoot, realSrc)) {
        preflightRecords.push({
          ok: false,
          err: new ReleaseError(
            PUBLIC_PATH_FORBIDDEN,
            `source file escapes unit root via realpath: "${mapping.from}"`,
            { from: mapping.from, realSrc, unitRoot: realUnitRoot },
          ),
        });
        continue;
      }
    } catch (err) {
      if (err instanceof ReleaseError) {
        preflightRecords.push({ ok: false, err });
        continue;
      }
      const code = err.code ?? 'UNKNOWN';
      if (code === 'ENOENT') {
        // Required source missing → PUBLIC_FILE_MISSING; non-required → CONFIG_INVALID.
        const isRequired = requiredTargetSet.has(mapping.to);
        preflightRecords.push({
          ok: false,
          err: new ReleaseError(
            isRequired ? PUBLIC_FILE_MISSING : CONFIG_INVALID,
            `source file not found: "${mapping.from}"`,
            { from: mapping.from, sourceRelative: mapping.sourceRelative, cause: code,
              ...(isRequired ? { missing: [mapping.to] } : {}) },
          ),
        });
        continue;
      }
      preflightRecords.push({
        ok: false,
        err: new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `cannot resolve source file: "${mapping.from}"`,
          { from: mapping.from, cause: code },
        ),
      });
      continue;
    }

    // lstat source: reject symlinks, devices, hardlinks, special files
    let srcStat;
    try {
      srcStat = await fs.lstat(srcPath, { stage: 'source-preflight-lstat' });
    } catch (err) {
      const code = err.code ?? 'UNKNOWN';
      if (code === 'ENOENT') {
        const isRequired = requiredTargetSet.has(mapping.to);
        preflightRecords.push({
          ok: false,
          err: new ReleaseError(
            isRequired ? PUBLIC_FILE_MISSING : CONFIG_INVALID,
            `source file not found: "${mapping.from}"`,
            { from: mapping.from, sourceRelative: mapping.sourceRelative, cause: code,
              ...(isRequired ? { missing: [mapping.to] } : {}) },
          ),
        });
        continue;
      }
      preflightRecords.push({
        ok: false,
        err: new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `cannot stat source file: "${mapping.from}"`,
          { from: mapping.from, sourceRelative: mapping.sourceRelative, cause: code },
        ),
      });
      continue;
    }

    if (srcStat.isSymbolicLink()) {
      preflightRecords.push({
        ok: false,
        err: new ReleaseError(
          PUBLIC_PATH_FORBIDDEN,
          `symlink not allowed: "${mapping.from}"`,
          { from: mapping.from },
        ),
      });
      continue;
    }

    if (srcStat.isBlockDevice() || srcStat.isCharacterDevice()) {
      preflightRecords.push({
        ok: false,
        err: new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `device file not allowed: "${mapping.from}"`,
          { from: mapping.from },
        ),
      });
      continue;
    }

    // Reject hardlinks (nlink > 1 means multiple directory entries)
    if (srcStat.nlink > 1) {
      preflightRecords.push({
        ok: false,
        err: new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `hardlinked file not allowed: "${mapping.from}" (nlink=${srcStat.nlink})`,
          { from: mapping.from, nlink: srcStat.nlink },
        ),
      });
      continue;
    }

    // Reject special files (FIFO, socket)
    if (!srcStat.isFile()) {
      preflightRecords.push({
        ok: false,
        err: new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `special file not allowed: "${mapping.from}"`,
          { from: mapping.from },
        ),
      });
      continue;
    }

    // Resource limit: file size
    if (srcStat.size > MAX_FILE_BYTES) {
      preflightRecords.push({
        ok: false,
        err: new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `source file too large: "${mapping.from}" (${srcStat.size} bytes, max ${MAX_FILE_BYTES})`,
          { from: mapping.from, size: srcStat.size, limit: MAX_FILE_BYTES },
        ),
      });
      continue;
    }

    preflightRecords.push({
      ok: true,
      mapping,
      srcPath,
      destPath,
      srcStat,
    });
  }

  // If any preflight record failed, throw the FIRST error.
  // No destination files or directories have been created yet.
  const firstFailure = preflightRecords.find((r) => !r.ok);
  if (firstFailure) {
    throw firstFailure.err;
  }

  // =======================================================================
  // REQUIRED COVERAGE + TARGET COLLISION: validate BEFORE any outputDir
  // creation. If these fail, no directory or file is written.
  // =======================================================================

  // --- Required-file coverage check ---
  const requiredPublicFiles = unit.requiredPublicFiles ?? [];
  if (requiredPublicFiles.length > 0) {
    const toSourceMap = new Map(mappings.map((m) => [m.to, m.from]));
    const missingRequired = [];
    for (const req of requiredPublicFiles) {
      const src = toSourceMap.get(req);
      if (!src) {
        missingRequired.push(req);
        continue;
      }
      // Source existence is already validated by preflight — if we get here
      // the source file is a valid regular file.
    }
    if (missingRequired.length > 0) {
      throw new ReleaseError(
        PUBLIC_FILE_MISSING,
        `missing required public file(s): ${missingRequired.join(', ')}`,
        { missing: missingRequired },
      );
    }
  }

  // --- Target uniqueness validation using shared collision key ---
  const targetSet = new Set();
  const collisionKeyMap = new Map();

  for (const mapping of mappings) {
    const target = mapping.to;

    // Exact duplicate
    if (targetSet.has(target)) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `duplicate public file target: "${target}"`,
        { target },
      );
    }
    targetSet.add(target);

    // Collision key: NFC + case-fold
    const key = publicPathCollisionKey(target);
    if (collisionKeyMap.has(key)) {
      const existing = collisionKeyMap.get(key);
      if (existing !== target) {
        // Determine whether it's a case-fold, NFC, or combined collision.
        const nfc = target.normalize('NFC');
        const existingNfc = existing.normalize('NFC');
        const isNfc = nfc === existingNfc;
        const isCase = nfc.toLowerCase() === existingNfc.toLowerCase();
        let kind = 'case+NFC';
        if (isNfc && !isCase) kind = 'NFC';
        else if (!isNfc && isCase) kind = 'case-fold';

        throw new ReleaseError(
          CONFIG_INVALID,
          `${kind} collision on target: "${target}" and "${existing}"`,
          { target, existing },
        );
      }
    }
    collisionKeyMap.set(key, target);
  }

  // =======================================================================
  // OUTPUT DIR: validate ancestors + create staging directory.
  // All preflight and collision checks passed — safe to create outputDir.
  // =======================================================================

  // --- Walk outputDir ancestor chain, rejecting symlinks (lstat, no follow) ---
  await assertOutputAncestorsNoFollow(effectiveOutputDir, fs);

  // --- Check outputDir itself ---
  try {
    const outputDirStat = await fs.lstat(effectiveOutputDir, { stage: 'output-dir' });
    if (outputDirStat.isSymbolicLink()) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `staging directory is a symlink: "${effectiveOutputDir}"`,
        { outputDir: effectiveOutputDir },
      );
    }
    if (!outputDirStat.isDirectory()) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `staging path is not a directory: "${effectiveOutputDir}"`,
        { outputDir: effectiveOutputDir },
      );
    }

    // Existing directory: must be empty
    const dirEntries = await fs.readdir(effectiveOutputDir, { stage: 'output-dir-read' });
    if (dirEntries.length > 0) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `staging directory is not empty: "${effectiveOutputDir}" (${dirEntries.length} entries)`,
        { outputDir: effectiveOutputDir, entryCount: dirEntries.length },
      );
    }

    // Existing empty directory: verify owner (uid) and permissions ≤ 0700.
    if (typeof outputDirStat.uid === 'number' && process.getuid) {
      const currentUid = process.getuid();
      if (outputDirStat.uid !== currentUid) {
        throw new ReleaseError(
          CONFIG_INVALID,
          `staging directory not owned by current user: uid=${outputDirStat.uid} expected=${currentUid}`,
          { outputDir: effectiveOutputDir },
        );
      }
    }
    const dirMode = outputDirStat.mode & 0o7777;
    // Permission must not be wider than 0700 (owner rwx only)
    if ((dirMode & ~0o700) !== 0) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `staging directory permissions too wide: 0o${dirMode.toString(8)} (max 0700)`,
        { outputDir: effectiveOutputDir, mode: dirMode },
      );
    }
  } catch (err) {
    if (err instanceof ReleaseError) throw err;
    // Only ENOENT (directory does not exist) is safe to proceed from.
    // ENOENT is a config issue (path doesn't exist yet).
    // Other errors (EACCES, EIO, ENOTDIR, etc.) indicate FS fidelity issues.
    if (err.code !== 'ENOENT') {
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `cannot inspect staging directory: ${err.message}`,
        { outputDir: effectiveOutputDir, cause: err.code },
      );
    }
  }

  // --- Create staging directory with mode 0700 ---
  try {
    await fs.mkdir(effectiveOutputDir, { recursive: true, mode: 0o700 }, { stage: 'output-dir-mkdir' });
  } catch (err) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `cannot create staging directory: ${err.message}`,
      { outputDir: effectiveOutputDir, cause: err.code },
    );
  }

  // Ensure the created directory has mode 0700 (mkdir may be affected by umask)
  try {
    await fs.chmod(effectiveOutputDir, 0o700, { stage: 'output-dir-chmod' });
  } catch (err) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `cannot chmod staging directory: ${err.message}`,
      { outputDir: effectiveOutputDir, cause: err.code },
    );
  }

  // --- Copy and verify each file ---
  // All preflight checks passed. Now we create destination files.
  const entries = [];
  let totalSize = 0;

  // Real output root for containment checks on destination writes.
  let realOutputRoot;
  try {
    realOutputRoot = await fs.realpath(effectiveOutputDir, { stage: 'output-root-realpath' });
  } catch (err) {
    const code = err.code ?? 'UNKNOWN';
    // ENOENT means directory doesn't exist yet — config issue.
    // EACCES/EIO/etc. indicate FS fidelity issues.
    const errorCode = code === 'ENOENT' ? CONFIG_INVALID : SNAPSHOT_FIDELITY_FAILED;
    throw new ReleaseError(
      errorCode,
      `cannot resolve staging directory: ${err.message}`,
      { outputDir: effectiveOutputDir, cause: code },
    );
  }

  // Fix output root identity for inter-mapping root swap detection.
  // Each mapping re-verifies isDirectory/dev/ino/realPath before destination operations.
  let rootIdentity;
  try {
    const rootStat = await fs.lstat(effectiveOutputDir, { stage: 'root-identity' });
    if (!rootStat.isDirectory()) {
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `output root is not a directory: "${effectiveOutputDir}"`,
        { outputDir: effectiveOutputDir },
      );
    }
    rootIdentity = {
      dev: rootStat.dev,
      ino: rootStat.ino,
      realPath: realOutputRoot,
    };
  } catch (err) {
    throw new ReleaseError(
      SNAPSHOT_FIDELITY_FAILED,
      `cannot fix output root identity: ${err.message}`,
      { outputDir: effectiveOutputDir, cause: err.code },
    );
  }

  for (const { mapping, srcPath, destPath, srcStat } of preflightRecords) {
    const srcMode = srcStat.mode & 0o7777;

    // --- Internal test hook: called between preflight and source open ---
    // Allows tests to mutate source (e.g., mode change) after lstat but
    // before open, to verify stat→read→stat catches TOCTOU.
    await _beforeOpen({ srcPath });

    // --- Read source bytes via O_NOFOLLOW handle ---
    // Use open(O_RDONLY|O_NOFOLLOW) to prevent symlink TOCTOU.
    // All facts (fstat, readFile) come from the same handle.
    let content;
    let srcHandle;
    try {
      srcHandle = await fs.open(srcPath, O_RDONLY | O_NOFOLLOW, undefined, { stage: 'source-open' });
      const srcHandleStat = await srcHandle.stat();

      // Pre-read: verify ALL stat fields match lstat (type, nlink, size, mode, dev, ino)
      if (srcHandleStat.dev !== srcStat.dev || srcHandleStat.ino !== srcStat.ino) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `TOCTOU detected: source handle dev/ino mismatch for "${mapping.from}"`,
          { from: mapping.from },
        );
      }
      if (!srcHandleStat.isFile()) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `TOCTOU detected: source type changed for "${mapping.from}"`,
          { from: mapping.from },
        );
      }
      if (srcHandleStat.nlink !== srcStat.nlink) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `TOCTOU detected: source nlink changed for "${mapping.from}"`,
          { from: mapping.from, lstatNlink: srcStat.nlink, handleNlink: srcHandleStat.nlink },
        );
      }
      if (srcHandleStat.size !== srcStat.size) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `TOCTOU detected: source size changed for "${mapping.from}"`,
          { from: mapping.from, lstatSize: srcStat.size, handleSize: srcHandleStat.size },
        );
      }
      if ((srcHandleStat.mode & 0o7777) !== (srcStat.mode & 0o7777)) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `TOCTOU detected: source mode changed for "${mapping.from}"`,
          { from: mapping.from },
        );
      }

      // Verify realpath of the handle is inside both realSourceRoot and realUnitRoot.
      // This catches a race between preflight and open where a component
      // was replaced with a symlink.
      const handleRealPath = await fs.realpath(srcPath, { stage: 'source-open-realpath' });
      if (!isContained(realSourceRoot, handleRealPath)) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `source escapes sourceRoot containment after open: "${mapping.from}"`,
          { from: mapping.from, realPath: handleRealPath },
        );
      }
      if (!isContained(realUnitRoot, handleRealPath)) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `source escapes unitRoot containment after open: "${mapping.from}"`,
          { from: mapping.from, realPath: handleRealPath },
        );
      }

      // Re-check source ancestor symlinks after open (defense in depth)
      try {
        await assertNoAncestorSymlinks(sourceRoot, srcPath, fs);
      } catch (ancestorErr) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `source ancestor symlink detected after open: "${mapping.from}"`,
          { from: mapping.from, cause: ancestorErr.message },
        );
      }

      content = await srcHandle.readFile();

      // Stage hook: after source readFile(), before post-read stat()
      await _afterSourceRead({ srcPath, content });

      // Post-read stat: verify ALL fields haven't changed during read.
      // Includes mtimeMs/ctimeMs to catch same-length overwrites.
      const postReadStat = await srcHandle.stat();
      if (postReadStat.dev !== srcStat.dev ||
          postReadStat.ino !== srcStat.ino ||
          postReadStat.nlink !== srcStat.nlink) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `TOCTOU detected: source changed during read for "${mapping.from}"`,
          { from: mapping.from },
        );
      }
      if (!postReadStat.isFile()) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `TOCTOU detected: source type changed during read for "${mapping.from}"`,
          { from: mapping.from },
        );
      }
      if ((postReadStat.mode & 0o7777) !== (srcStat.mode & 0o7777)) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `source mode changed during read for "${mapping.from}"`,
          { from: mapping.from },
        );
      }
      if (postReadStat.size !== srcStat.size) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `source size changed during read for "${mapping.from}"`,
          { from: mapping.from },
        );
      }
      if (postReadStat.mtimeMs !== srcStat.mtimeMs ||
          postReadStat.ctimeMs !== srcStat.ctimeMs) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `source timestamps changed during read for "${mapping.from}"`,
          { from: mapping.from },
        );
      }
    } catch (err) {
      if (err instanceof ReleaseError) throw err;
      const code = err.code ?? 'UNKNOWN';
      if (code === 'ENOENT') {
        // Required source disappeared between preflight and open
        const isRequired = (unit.requiredPublicFiles ?? []).includes(mapping.to);
        throw new ReleaseError(
          isRequired ? PUBLIC_FILE_MISSING : CONFIG_INVALID,
          `source file not found during read: "${mapping.from}"`,
          { from: mapping.from, sourceRelative: mapping.sourceRelative, cause: code },
        );
      }
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `cannot read source file: "${mapping.from}"`,
        { from: mapping.from, cause: code },
      );
    } finally {
      if (srcHandle) await srcHandle.close().catch(() => {});
    }

    // --- Re-verify output root identity before destination operations ---
    // Detects root swap (rename + symlink) between mappings.
    try {
      const currentRootReal = await fs.realpath(effectiveOutputDir, { stage: 'root-verify' });
      const currentRootStat = await fs.lstat(effectiveOutputDir, { stage: 'root-verify' });
      if (currentRootStat.isSymbolicLink() ||
          !currentRootStat.isDirectory() ||
          (currentRootStat.dev !== rootIdentity.dev) ||
          (currentRootStat.ino !== rootIdentity.ino) ||
          (currentRootReal !== rootIdentity.realPath)) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `output root identity changed before destination write for "${mapping.to}"`,
          { to: mapping.to, outputDir: effectiveOutputDir },
        );
      }
    } catch (err) {
      if (err instanceof ReleaseError) throw err;
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `cannot verify output root identity: ${err.message}`,
        { to: mapping.to, outputDir: effectiveOutputDir, cause: err.code },
      );
    }

    // --- Check existing destination ancestors BEFORE mkdir ---
    // mkdir({recursive: true}) follows symlinks in existing parent dirs.
    // If a previous _afterCopy injected a symlink, mkdir would create the
    // new directory INSIDE the symlink target before we could detect it.
    // Walking existing ancestors with lstat (no follow) BEFORE mkdir
    // prevents this: any symlink in the chain is detected and rejected
    // before mkdir can follow it.
    const destDir = dirname(destPath);
    const relDest = relative(realOutputRoot, destDir);
    const destSegments = relDest.split(pathSep).filter(Boolean);
    let accumulatedPath = realOutputRoot;
    for (const seg of destSegments) {
      accumulatedPath = resolve(accumulatedPath, seg);
      try {
        const segStat = await fs.lstat(accumulatedPath, { stage: 'dest-ancestor-pre-mkdir' });
        if (segStat.isSymbolicLink()) {
          throw new ReleaseError(
            SNAPSHOT_FIDELITY_FAILED,
            `destination ancestor is a symlink: "${accumulatedPath}"`,
            { to: mapping.to, symlinkAncestor: accumulatedPath, realOutputRoot },
          );
        }
      } catch (err) {
        if (err instanceof ReleaseError) throw err;
        if (err.code === 'ENOENT') break; // remaining will be created fresh
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `cannot inspect destination ancestor: "${accumulatedPath}": ${err.message}`,
          { to: mapping.to, ancestor: accumulatedPath, cause: err.code },
        );
      }
    }

    // --- Create subdirectory with mode 0700 ---
    try {
      await fs.mkdir(destDir, { recursive: true, mode: 0o700 }, { stage: 'dest-dir-mkdir' });
    } catch (err) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `cannot create destination directory: ${err.message}`,
        { to: mapping.to, destDir, cause: err.code },
      );
    }

    // --- Post-mkdir: re-verify root identity + full ancestor walk ---
    try {
      const postMkdirRootReal = await fs.realpath(effectiveOutputDir, { stage: 'post-mkdir-root' });
      const postMkdirRootStat = await fs.lstat(effectiveOutputDir, { stage: 'post-mkdir-root' });
      if (postMkdirRootStat.isSymbolicLink() ||
          !postMkdirRootStat.isDirectory() ||
          (postMkdirRootStat.dev !== rootIdentity.dev) ||
          (postMkdirRootStat.ino !== rootIdentity.ino) ||
          (postMkdirRootReal !== rootIdentity.realPath)) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `output root identity changed after mkdir for "${mapping.to}"`,
          { to: mapping.to, outputDir: effectiveOutputDir },
        );
      }
    } catch (err) {
      if (err instanceof ReleaseError) throw err;
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `cannot verify output root identity after mkdir: ${err.message}`,
        { to: mapping.to, outputDir: effectiveOutputDir, cause: err.code },
      );
    }
    await assertDestAncestorsNoFollow(realOutputRoot, destPath, fs);

    // --- Copy to destination via exclusive/no-follow handle ---
    let destHandle;
    try {
      // O_EXCL ensures we don't overwrite; O_NOFOLLOW prevents symlink attack.
      destHandle = await fs.open(destPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, srcMode, { stage: 'dest-open' });

      // --- Post-open destination containment (defense in depth) ---
      // Verify the opened file's realpath is inside the fixed output root.
      // This catches races between assertDestAncestorsNoFollow and open.
      // Note: we check BEFORE write to fail closed early.
      // Non-ENOENT FS errors on realpath are wrapped as SNAPSHOT_FIDELITY_FAILED.
      let realDestAfterOpen;
      try {
        realDestAfterOpen = await fs.realpath(destPath, { stage: 'dest-post-open-realpath' });
      } catch (rpErr) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `cannot resolve destination after open: "${destPath}"`,
          { from: mapping.from, to: mapping.to, cause: rpErr.code ?? 'UNKNOWN' },
        );
      }
      if (!isContained(realOutputRoot, realDestAfterOpen)) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `destination ancestor is a symlink: "${destPath}"`,
          { from: mapping.from, to: mapping.to, realDest: realDestAfterOpen, realOutputRoot },
        );
      }

      await destHandle.write(content);
      await destHandle.chmod(srcMode);
    } catch (err) {
      if (err instanceof ReleaseError) throw err;
      const code = err.code ?? 'UNKNOWN';
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `cannot write destination file: "${mapping.to}"`,
        { from: mapping.from, to: mapping.to, cause: code },
      );
    } finally {
      if (destHandle) await destHandle.close().catch(() => {});
    }

    // Internal test hook: allows tests to corrupt destination after copy
    await _afterCopy({ destPath, srcPath });

    // --- Post-copy fidelity verification ---
    // Use lstat (not stat) to detect if destination was replaced with symlink.
    // Then re-open with O_NOFOLLOW and verify dev/ino match.
    let destLstat;
    try {
      destLstat = await fs.lstat(destPath, { stage: 'post-copy-dest' });
    } catch (err) {
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `cannot lstat destination after copy: "${mapping.to}"`,
        { from: mapping.from, to: mapping.to, cause: err.code },
      );
    }

    if (destLstat.isSymbolicLink()) {
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `destination is a symlink after copy: "${mapping.to}"`,
        { from: mapping.from, to: mapping.to },
      );
    }

    if (!destLstat.isFile()) {
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `destination is not a regular file: "${mapping.to}"`,
        { from: mapping.from, to: mapping.to },
      );
    }

    if (destLstat.nlink > 1) {
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `destination has multiple hardlinks: "${mapping.to}" (nlink=${destLstat.nlink})`,
        { from: mapping.from, to: mapping.to, nlink: destLstat.nlink },
      );
    }

    const destMode = destLstat.mode & 0o7777;
    if (srcMode !== destMode) {
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `mode mismatch for "${mapping.from}": source=0o${srcMode.toString(8)}, dest=0o${destMode.toString(8)}`,
        { from: mapping.from, to: mapping.to, sourceMode: srcMode, destMode },
      );
    }

    // --- Early size gate: lstat size vs content.length ---
    // If the destination lstat size does not match the content we intend to
    // write, the file was tampered with between write and lstat.  Fail early
    // without opening/reading the destination a second time.
    if (destLstat.size !== content.length) {
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `size mismatch for "${mapping.from}": dest lstat=${destLstat.size}, content=${content.length}`,
        { from: mapping.from, to: mapping.to, destSize: destLstat.size, contentSize: content.length },
      );
    }

    // --- Fixed real output root containment ---
    // Verify destination is inside the real output root.
    // Non-ENOENT FS errors on realpath are wrapped as SNAPSHOT_FIDELITY_FAILED.
    let realDestPath;
    try {
      realDestPath = await fs.realpath(destPath, { stage: 'post-copy-dest-realpath' });
    } catch (rpErr) {
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `cannot resolve destination after copy: "${mapping.to}"`,
        { from: mapping.from, to: mapping.to, cause: rpErr.code ?? 'UNKNOWN' },
      );
    }
    if (!isContained(realOutputRoot, realDestPath)) {
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `destination escapes output root: "${mapping.to}"`,
        { from: mapping.from, to: mapping.to, realDest: realDestPath },
      );
    }

    // Read back destination via O_NOFOLLOW handle and verify content + all stat fields
    let destReadHandle;
    let destContent;
    try {
      destReadHandle = await fs.open(destPath, O_RDONLY | O_NOFOLLOW, undefined, { stage: 'dest-readback-open' });
      const destHandleStat = await destReadHandle.stat();
      // Pre-read: dev/ino/type/nlink/size/mode must match lstat
      if (destHandleStat.dev !== destLstat.dev || destHandleStat.ino !== destLstat.ino) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `TOCTOU detected: destination handle mismatch for "${mapping.to}"`,
          { from: mapping.from, to: mapping.to },
        );
      }
      if (!destHandleStat.isFile()) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `TOCTOU detected: destination type changed for "${mapping.to}"`,
          { from: mapping.from, to: mapping.to },
        );
      }
      if (destHandleStat.nlink !== destLstat.nlink) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `TOCTOU detected: destination nlink changed for "${mapping.to}"`,
          { from: mapping.from, to: mapping.to },
        );
      }
      if (destHandleStat.size !== content.length) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `TOCTOU detected: destination size changed for "${mapping.to}"`,
          { from: mapping.from, to: mapping.to, handleSize: destHandleStat.size, contentSize: content.length },
        );
      }
      if ((destHandleStat.mode & 0o7777) !== destMode) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `TOCTOU detected: destination mode changed for "${mapping.to}"`,
          { from: mapping.from, to: mapping.to },
        );
      }
      destContent = await destReadHandle.readFile();

      // Stage hook: after destination readFile(), before post-read stat()
      await _afterDestRead({ destPath });

      // Post-read stat: verify ALL fields haven't changed during readback.
      // Includes mtimeMs/ctimeMs to catch same-length overwrites.
      const postReadDestStat = await destReadHandle.stat();
      if (postReadDestStat.dev !== destLstat.dev ||
          postReadDestStat.ino !== destLstat.ino ||
          postReadDestStat.nlink !== destLstat.nlink ||
          postReadDestStat.size !== content.length ||
          (postReadDestStat.mode & 0o7777) !== destMode) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `destination changed during readback for "${mapping.to}"`,
          { from: mapping.from, to: mapping.to },
        );
      }
      if (!postReadDestStat.isFile()) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `destination type changed during readback for "${mapping.to}"`,
          { from: mapping.from, to: mapping.to },
        );
      }
      if (postReadDestStat.mtimeMs !== destLstat.mtimeMs ||
          postReadDestStat.ctimeMs !== destLstat.ctimeMs) {
        throw new ReleaseError(
          SNAPSHOT_FIDELITY_FAILED,
          `destination timestamps changed during readback for "${mapping.to}"`,
          { from: mapping.from, to: mapping.to },
        );
      }
    } catch (err) {
      if (err instanceof ReleaseError) throw err;
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `cannot read destination after copy: "${mapping.to}"`,
        { from: mapping.from, to: mapping.to, cause: err.code },
      );
    } finally {
      if (destReadHandle) await destReadHandle.close().catch(() => {});
    }

    // Compare actual bytes (not just size)
    if (!content.equals(destContent)) {
      throw new ReleaseError(
        SNAPSHOT_FIDELITY_FAILED,
        `content mismatch for "${mapping.from}": destination bytes differ from source`,
        { from: mapping.from, to: mapping.to, sourceBytes: content.length, destBytes: destContent.length },
      );
    }

    const fileHash = createHash('sha256').update(content).digest('hex');
    totalSize += content.length;

    entries.push({
      path: mapping.to,
      from: mapping.from,
      sourceRelative: mapping.sourceRelative,
      bytes: content.length,
      hash: fileHash,
      mode: srcStat.mode,
      type: 'file',
    });
  }

  // Final required-public-files safety net (early check above handles
  // missing source files; this catches any other gap).
  const finalRequired = unit.requiredPublicFiles ?? [];
  const entryPaths = new Set(entries.map((e) => e.path));
  const finalMissing = finalRequired.filter((r) => !entryPaths.has(r));
  if (finalMissing.length > 0) {
    throw new ReleaseError(
      PUBLIC_FILE_MISSING,
      `missing required public file(s): ${finalMissing.join(', ')}`,
      { missing: finalMissing },
    );
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Compute canonical manifest digest from sorted entries.
  // This ensures that mapping order changes do NOT change the digest.
  const manifestDigest = createHash('sha256')
    .update(JSON.stringify(entries.map((e) => ({
      path: e.path,
      type: e.type,
      mode: e.mode,
      size: e.bytes,
      contentDigest: e.hash,
    }))))
    .digest('hex');

  // Build sorted files list for backward compatibility
  const files = entries.map((e) => e.path).sort();

  return Object.freeze({
    entries: Object.freeze(entries),
    files,
    totalSize,
    fileCount: entries.length,
    contentHash: manifestDigest,
    snapshotDigest: manifestDigest,
    sourceRoot,
    source: unit.source,
    outputDir: effectiveOutputDir,
  });
}
