/**
 * Canonical public-path helpers shared between config loader and snapshot mapper.
 *
 * Delegates to the canonical artifact path implementation in
 * `artifacts/path-key.mjs` to ensure snapshot and artifact inventory
 * share one collision semantics. The `allowDot` option (for standalone `.`)
 * is handled here as a thin wrapper.
 *
 * @module snapshot/public-path
 */

import { ReleaseError, PUBLIC_PATH_FORBIDDEN, PATH_UNSAFE } from '../core/errors.mjs';
import { canonicalArtifactPath } from '../artifacts/path-key.mjs';
import { isAbsolute, relative, resolve } from 'node:path';

const SAFE_UNIT_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Canonicalise a public file path.
 *
 * Normalises separators and rejects:
 * - POSIX absolute paths (starting with `/`)
 * - Windows drive-letter paths (e.g. `C:\<path>`)
 * - Windows UNC paths (e.g. `\\server\share`)
 * - Raw `..` segments (before normalization collapses them)
 * - Empty segments (from consecutive `/` or normalisation)
 * - Backslash separators
 * - NUL bytes
 *
 * @param {string} raw - Raw path string.
 * @param {object} [options]
 * @param {boolean} [options.allowDot=false] - Allow standalone `.` as a valid path
 *   (used for `unit.source: .`).
 * @returns {{ path: string }} Object with canonical `path`.
 * @throws {ReleaseError} PUBLIC_PATH_FORBIDDEN on traversal or absolute path.
 */
export function canonicalPublicPath(raw, { allowDot = false } = {}) {
  // Allow standalone `.` for unit.source (backward compatibility).
  if (allowDot && raw === '.') {
    return { path: '.' };
  }

  // Delegate to canonicalArtifactPath; convert PATH_UNSAFE to PUBLIC_PATH_FORBIDDEN
  // for backward compatibility with existing callers.
  try {
    const result = canonicalArtifactPath(raw);
    return { path: result.path };
  } catch (err) {
    if (err.code === PATH_UNSAFE) {
      throw new ReleaseError(
        PUBLIC_PATH_FORBIDDEN,
        err.message,
        { path: raw },
      );
    }
    throw err;
  }
}

/**
 * Compute a stable collision key for a public file target path.
 *
 * Normalises to NFC then applies stable case-fold (lowercase).
 * Used for detecting target collisions in both config loading and runtime staging.
 *
 * @param {string} target - The target path string.
 * @returns {string} A stable collision key (NFC + lowercase).
 */
export function publicPathCollisionKey(target) {
  return target.normalize('NFC').toLowerCase();
}

/**
 * Resolve one release-unit-owned child under a trusted base directory.
 * Unit ids are identifiers, never paths: they must be a single safe segment.
 * The resolved containment check is retained as defense in depth.
 *
 * @param {string} baseDir absolute or relative trusted base directory
 * @param {string} unitId release unit identifier
 * @param {object} [options]
 * @param {string} [options.suffix=''] deterministic filename suffix
 * @returns {string} absolute contained path
 * @throws {ReleaseError} PUBLIC_PATH_FORBIDDEN for unsafe ids or containment failure
 */
export function resolveUnitScopedPath(baseDir, unitId, { suffix = '' } = {}) {
  if (typeof unitId !== 'string' || !SAFE_UNIT_ID_PATTERN.test(unitId)) {
    throw new ReleaseError(
      PUBLIC_PATH_FORBIDDEN,
      `release unit id must be a safe single path segment: "${String(unitId)}"`,
      { unitId },
    );
  }

  const base = resolve(baseDir);
  const candidate = resolve(base, `${unitId}${suffix}`);
  const rel = relative(base, candidate);
  const separator = process.platform === 'win32' ? '\\' : '/';
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${separator}`)) {
    throw new ReleaseError(
      PUBLIC_PATH_FORBIDDEN,
      `release unit path escapes its trusted base: "${unitId}"`,
      { unitId, baseDir: base },
    );
  }
  return candidate;
}
