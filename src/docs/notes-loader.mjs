/**
 * Safe loader for the structured release-notes source
 * (2026-07-21-release-docs-refresh-protocol §2/§3).
 *
 * `loadReleaseNotesSource({ unitRoot, config, version, maxBytes, seam, backendFactory })`:
 *
 * 1. normalizes `config` through `normalizeReleaseDocumentsConfig` (closed
 *    semantic validation first);
 * 2. substitutes every `{version}` placeholder in `notesSource` and
 *    re-canonicalizes the result through the shared `canonicalArtifactPath`
 *    helper; the version itself must be a safe single path segment;
 * 3. reads the target exclusively through directory handles provided by the
 *    safe-filesystem backend (`artifacts/safe-fs.mjs`): `openRoot` on the
 *    caller-supplied unit root AS-IS (the loader never realpath's it; the
 *    backend's per-segment O_NOFOLLOW walk rejects a symlinked root or
 *    ancestor), then `openDir` per ancestor segment (openat, no-follow),
 *    then `readEntry` + `readFile` on the leaf relative to the parent
 *    handle. No absolute path is ever opened after the root handle is
 *    established, so a parent directory replaced with a symlink between
 *    the walk and the leaf read cannot redirect the read (openat stays
 *    bound to the original directory inode). All handles are closed in
 *    reverse order. Every identity consumed from `readEntry` (pre-read)
 *    and `readFile` (post-read) is strictly validated first — `size`,
 *    `dev`, `ino`, `nlink` must be non-negative safe integers and `bytes`
 *    must be a `Buffer`; anything else fails closed before parsing. The
 *    identity is then verified: regular-file type, `nlink === 1`, size
 *    within `maxBytes`, and agreement between reported size, returned
 *    bytes length, and the pre-read `readEntry` metadata (dev/ino/size) —
 *    any mismatch fails closed;
 * 4. delegates to `parseReleaseNotes` with the format chosen by suffix
 *    (yaml/yml/json);
 * 5. returns a deeply frozen `{ relativePath, bytesDigest, notes }` where
 *    `bytesDigest` is `sha256:` + lowercase hex over the raw bytes.
 *
 * If the safe backend is unavailable the loader fails closed with the
 * backend's stable error (e.g. SAFE_WRITE_UNAVAILABLE); it never degrades
 * to absolute-path opens.
 *
 * The handle walk itself is exported as `readSafeFileThroughHandles` so the
 * refresh service reads every release-document target through the identical
 * safe-read primitive (same O_NOFOLLOW walk, same identity checks, plus the
 * permission mode captured by the same stable readFile).
 *
 * Injection points (tests only):
 * - `backendFactory: async () => backend` — supply a backend built from a
 *   fake addon via `createBackend` to cover race/identity branches
 *   deterministically;
 * - `seam.beforeLeafRead({ parentDir })` — awaited after every ancestor
 *   handle is established and before the leaf read. It receives ONLY the
 *   relative parent directory (never an absolute path, never unitRoot).
 *
 * Path/race problems throw the existing stable code `PATH_UNSAFE`; semantic
 * problems throw `RELEASE_DOCS_INVALID`; parse problems propagate their own
 * codes (including `RELEASE_DOCS_TRANSLATION_MISSING`). Error messages and
 * details never carry absolute paths or note body text.
 *
 * @module src/docs/notes-loader
 */

import { loadSafeFs } from '../artifacts/safe-fs.mjs';
import { canonicalArtifactPath } from '../artifacts/path-key.mjs';
import { sha256Hex } from '../core/digest.mjs';
import {
  ReleaseError,
  PATH_UNSAFE,
  RELEASE_DOCS_INVALID,
} from '../core/errors.mjs';
import { normalizeReleaseDocumentsConfig } from './config.mjs';
import { parseReleaseNotes, DEFAULT_MAX_NOTES_BYTES } from './notes.mjs';

// ---------------------------------------------------------------------------
// Error helpers (never include absolute paths or body text)
// ---------------------------------------------------------------------------

function unsafe(reason, message, details = {}) {
  throw new ReleaseError(PATH_UNSAFE, message, { reason, ...details });
}

function invalid(reason, message, details = {}) {
  throw new ReleaseError(RELEASE_DOCS_INVALID, message, { reason, ...details });
}

/** Wrap a backend error without forwarding its (already sanitized) message. */
function unsafeCause(reason, message, err, details = {}) {
  throw new ReleaseError(PATH_UNSAFE, message, {
    reason,
    cause: err?.code ?? 'BACKEND_ERROR',
    ...details,
  });
}

// ---------------------------------------------------------------------------
// Placeholder substitution and format selection
// ---------------------------------------------------------------------------

const FORMAT_BY_SUFFIX = Object.freeze({ yaml: 'yaml', yml: 'yml', json: 'json' });

/**
 * Substitute every `{version}` placeholder and re-canonicalize the path.
 *
 * @param {string} notesSource  Canonical notesSource from config validation.
 * @param {string} version  Release version; must be a safe single segment.
 * @returns {{ relativePath: string, format: string }}
 */
function resolveNotesPath(notesSource, version) {
  // The version must itself be a safe single path segment before it may be
  // embedded into a filesystem path. canonicalArtifactPath covers traversal,
  // separators (backslash), colon, NUL and reserved names; the single-segment
  // requirement is enforced explicitly here.
  if (version.includes('/')) {
    invalid(
      'UNSAFE_VERSION_SEGMENT',
      'version is not a safe file-name fragment for notesSource substitution',
      { version, cause: 'PATH_UNSAFE' },
    );
  }
  try {
    canonicalArtifactPath(version);
  } catch (err) {
    invalid(
      'UNSAFE_VERSION_SEGMENT',
      'version is not a safe file-name fragment for notesSource substitution',
      { version, cause: err.code ?? 'PATH_UNSAFE' },
    );
  }

  const substituted = notesSource.split('{version}').join(version);
  if (substituted.includes('{') || substituted.includes('}')) {
    invalid(
      'RESIDUAL_PLACEHOLDER',
      'notesSource contains a placeholder other than {version}',
      { notesSource },
    );
  }

  let relativePath;
  try {
    relativePath = canonicalArtifactPath(substituted).path;
  } catch (err) {
    invalid(
      'UNSAFE_NOTES_PATH',
      `notesSource is unsafe after version substitution: ${err.message}`,
      { notesSource, cause: err.code ?? 'PATH_UNSAFE' },
    );
  }

  const dot = relativePath.lastIndexOf('.');
  const suffix = dot >= 0 ? relativePath.slice(dot + 1) : '';
  const format = FORMAT_BY_SUFFIX[suffix];
  if (!format) {
    invalid(
      'UNSUPPORTED_SUFFIX',
      'notesSource must end with .yaml, .yml, or .json after version substitution',
      { notesSource, suffix },
    );
  }

  return { relativePath, format };
}

// ---------------------------------------------------------------------------
// Handle-based safe read (openat / no-follow; no absolute-path opens)
// ---------------------------------------------------------------------------

const IDENTITY_FIELDS = Object.freeze(['size', 'dev', 'ino', 'nlink']);

/**
 * Strictly validate identity metadata reported by the backend before any of
 * it is trusted. `size`, `dev`, `ino`, `nlink` must each be a non-negative
 * safe integer (rejecting NaN, Infinity, negatives, fractions, strings,
 * null/undefined, and values beyond the safe-integer range); when `withBytes`
 * is set, `bytes` must be a Buffer. Any violation fails closed with
 * PATH_UNSAFE before the parser is ever reached.
 *
 * @param {object} entry  readEntry or readFile result from the backend.
 * @param {string} relativePath  Canonical relative path (error details only).
 * @param {{ withBytes?: boolean }} [options]
 * @param {string} [subject]  Error-message subject (default 'notes source').
 */
function validateIdentity(entry, relativePath, { withBytes = false } = {}, subject = 'notes source') {
  for (const field of IDENTITY_FIELDS) {
    const value = entry[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      unsafe('UNSAFE_IDENTITY', `${subject} metadata is not a trustworthy identity`, {
        relativePath,
        field,
      });
    }
  }
  if (withBytes && !Buffer.isBuffer(entry.bytes)) {
    unsafe('UNSAFE_IDENTITY', `${subject} read did not return bytes`, {
      relativePath,
      field: 'bytes',
    });
  }
}

/**
 * Read one file through directory handles only (openat / no-follow per
 * segment; never an absolute-path open after the root handle is open).
 *
 * Shared safe-read primitive: the notes source itself and every
 * release-document target are read through this exact walk (regular file,
 * nlink === 1, size limit, pre/post identity agreement). There is no
 * absolute-path `fs.readFile` fallback; when the backend is unavailable the
 * read fails closed.
 *
 * @param {object} backend  Safe-fs backend (loadSafeFs or injected fake).
 * @param {string} unitRoot  Caller-supplied unit root, handed verbatim to
 *   backend.openRoot — never realpath'd; openRoot's per-segment O_NOFOLLOW
 *   walk rejects a symlinked root or ancestor.
 * @param {string} relativePath  Canonical relative path (POSIX segments).
 * @param {number} limit  Size limit in bytes.
 * @param {{ beforeLeafRead?: (info: { parentDir: string }) => Promise<void> }} [seam]
 * @param {string} [subject]  Error-message subject (default 'notes source';
 *   release-document target reads pass 'release document target').
 * @returns {Promise<Readonly<{ bytes: Buffer, mode: number }>>} fresh byte
 *   copy plus the permission mode captured by the same stable readFile.
 */
export async function readSafeFileThroughHandles(backend, unitRoot, relativePath, limit, seam, subject = 'notes source') {
  const segments = relativePath.split('/');
  const handleStack = [];
  let readResult = null;
  let primaryError = null;

  try {
    let rootHandle;
    try {
      rootHandle = await backend.openRoot(unitRoot);
    } catch (err) {
      unsafeCause('ROOT_OPEN_FAILED', 'release unit root cannot be opened safely', err, { relativePath });
    }
    handleStack.push(rootHandle);

    // Walk ancestors relative to the parent handle (openat, no-follow).
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      const parent = handleStack[handleStack.length - 1];
      let entry;
      try {
        entry = await parent.readEntry(segment);
      } catch (err) {
        unsafeCause('ANCESTOR_READ_FAILED', `${subject} path component cannot be inspected`, err, { relativePath });
      }
      if (entry === null || entry === undefined) {
        unsafe('MISSING', `${subject} path component does not exist`, { relativePath });
      }
      if (entry.type === 'symlink') {
        unsafe('ANCESTOR_SYMLINK', `${subject} path contains a symlinked directory`, { relativePath });
      }
      if (entry.type !== 'directory') {
        unsafe('ANCESTOR_NOT_DIRECTORY', `${subject} path component is not a directory`, { relativePath });
      }
      let child;
      try {
        child = await parent.openDir(segment);
      } catch (err) {
        unsafeCause('ANCESTOR_OPEN_FAILED', `${subject} directory cannot be opened safely`, err, { relativePath });
      }
      handleStack.push(child);
    }

    // Test-only seam: parent handles are established; the leaf is not read
    // yet. Only the relative parent directory is exposed — never an
    // absolute path.
    if (seam && typeof seam.beforeLeafRead === 'function') {
      const parentDir = segments.length > 1 ? segments.slice(0, -1).join('/') : '.';
      await seam.beforeLeafRead({ parentDir });
    }

    // Leaf identity check before reading anything.
    const leaf = segments[segments.length - 1];
    const parentHandle = handleStack[handleStack.length - 1];
    let leafEntry;
    try {
      leafEntry = await parentHandle.readEntry(leaf);
    } catch (err) {
      unsafeCause('LEAF_READ_FAILED', `${subject} file cannot be inspected`, err, { relativePath });
    }
    if (leafEntry === null || leafEntry === undefined) {
      unsafe('MISSING', `${subject} file does not exist`, { relativePath });
    }
    if (leafEntry.type === 'symlink') {
      unsafe('TARGET_SYMLINK', `${subject} target must not be a symlink`, { relativePath });
    }
    if (leafEntry.type !== 'file') {
      unsafe('NOT_REGULAR_FILE', `${subject} target must be a regular file`, { relativePath });
    }
    validateIdentity(leafEntry, relativePath, {}, subject);
    if (leafEntry.nlink !== 1) {
      unsafe('HARDLINK', `${subject} target must not be hardlinked`, { relativePath, nlink: leafEntry.nlink });
    }
    if (leafEntry.size > limit) {
      invalid('INPUT_TOO_LARGE', `${subject} exceeds the size limit`, {
        size: leafEntry.size,
        maxBytes: limit,
      });
    }

    // Read through the parent handle (openat, no-follow).
    try {
      readResult = await parentHandle.readFile(leaf);
    } catch (err) {
      unsafeCause('LEAF_READ_FAILED', `${subject} file cannot be read safely`, err, { relativePath });
    }
    if (readResult === null || readResult === undefined) {
      unsafe('MISSING', `${subject} file disappeared during read`, { relativePath });
    }

    // Strictly validate the identity returned by readFile before trusting it.
    validateIdentity(readResult, relativePath, { withBytes: true }, subject);
    if (readResult.nlink !== 1) {
      unsafe('HARDLINK', `${subject} target must not be hardlinked`, { relativePath, nlink: readResult.nlink });
    }
    if (readResult.size > limit) {
      invalid('INPUT_TOO_LARGE', `${subject} exceeds the size limit`, {
        size: readResult.size,
        maxBytes: limit,
      });
    }
    if (readResult.bytes.length !== readResult.size) {
      unsafe('CHANGED_DURING_READ', `${subject} bytes disagree with reported size`, { relativePath });
    }
    if (readResult.size !== leafEntry.size
      || readResult.dev !== leafEntry.dev
      || readResult.ino !== leafEntry.ino) {
      unsafe('CHANGED_DURING_READ', `${subject} identity changed between inspection and read`, { relativePath });
    }
  } catch (err) {
    primaryError = err instanceof ReleaseError
      ? err
      : new ReleaseError(PATH_UNSAFE, `${subject} read failed`, { reason: 'READ_FAILED' });
  }

  // Close every handle in reverse order; a close failure after a successful
  // read still fails closed.
  const closeFailures = [];
  for (let i = handleStack.length - 1; i >= 0; i -= 1) {
    try {
      await handleStack[i].close();
    } catch (closeErr) {
      closeFailures.push(closeErr?.code ?? 'CLOSE_FAILED');
    }
  }

  if (primaryError) {
    throw primaryError;
  }
  if (closeFailures.length > 0) {
    unsafe('CLOSE_FAILED', `${subject} handle close failed after read`, {
      relativePath,
      closeFailures,
    });
  }

  return Object.freeze({ bytes: Buffer.from(readResult.bytes), mode: readResult.mode });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Safely load and parse the structured release-notes source for one release
 * unit.
 *
 * @param {object} options
 * @param {string} options.unitRoot  Absolute release-unit root directory.
 * @param {object} options.config  Raw releaseDocuments config block.
 * @param {string} options.version  Exact expected release version.
 * @param {number} [options.maxBytes]  Size limit (default 1 MiB).
 * @param {{ beforeLeafRead?: (info: { parentDir: string }) => Promise<void> }} [options.seam]
 *   Test-only injection point; receives only the relative parent directory.
 * @param {() => Promise<object>} [options.backendFactory]
 *   Test-only safe-fs backend factory (default: loadSafeFs). Failures fail
 *   closed; there is no fallback to absolute-path opens.
 * @returns {Promise<Readonly<{
 *   relativePath: string,
 *   bytesDigest: string,
 *   notes: object,
 * }>>} deeply frozen result; `relativePath` is workspace-relative, never absolute
 * @throws {ReleaseError} PATH_UNSAFE on path/race problems; RELEASE_DOCS_INVALID
 *   on semantic problems; backend/parse-layer codes propagate (including
 *   SAFE_WRITE_UNAVAILABLE and RELEASE_DOCS_TRANSLATION_MISSING).
 */
export async function loadReleaseNotesSource({
  unitRoot,
  config,
  version,
  maxBytes,
  seam,
  backendFactory,
} = {}) {
  if (typeof unitRoot !== 'string' || unitRoot.length === 0) {
    invalid('INVALID_OPTIONS', 'unitRoot must be a non-empty string', {});
  }
  if (typeof version !== 'string' || version.length === 0) {
    invalid('INVALID_OPTIONS', 'version must be a non-empty string', {});
  }
  const limit = maxBytes ?? DEFAULT_MAX_NOTES_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    invalid('INVALID_OPTIONS', 'maxBytes must be a positive integer', {});
  }

  // 1. Closed semantic validation of the config block first.
  const normalized = normalizeReleaseDocumentsConfig(config);

  // 2. Substitute {version} and re-canonicalize; choose format by suffix.
  const { relativePath, format } = resolveNotesPath(normalized.notesSource, version);

  // 3. Load the safe backend; fail closed when unavailable (no fallback).
  const factory = backendFactory ?? loadSafeFs;
  const backend = await factory();

  // 4. Handle-based safe read inside the physical unit root.
  const { bytes } = await readSafeFileThroughHandles(backend, unitRoot, relativePath, limit, seam);

  // 5. Strict closed-model parse by format.
  const notes = parseReleaseNotes(bytes, {
    format,
    expectedVersion: version,
    locales: [...normalized.locales],
    maxBytes: limit,
  });

  // 6. Frozen canonical result; no absolute paths, deterministic digest.
  return Object.freeze({
    relativePath,
    bytesDigest: `sha256:${sha256Hex(bytes)}`,
    notes,
  });
}
