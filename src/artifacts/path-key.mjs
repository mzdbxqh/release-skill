/**
 * Canonical artifact path helpers.
 *
 * Single source of truth for artifact path canonicalization used by both
 * snapshot public-map and artifact inventory/policy.
 *
 * @module artifacts/path-key
 */

import { normalize } from 'node:path';
import { ReleaseError, PATH_UNSAFE } from '../core/errors.mjs';

// ---------------------------------------------------------------------------
// Windows reserved device names (case-insensitive)
// ---------------------------------------------------------------------------

const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Check whether a path segment is a Windows reserved device name.
 *
 * @param {string} segment
 * @returns {boolean}
 */
function isWindowsReservedSegment(segment) {
  return WINDOWS_RESERVED_RE.test(segment);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Canonicalise an artifact path.
 *
 * Requires POSIX separators, applies Unicode NFC,
 * and rejects:
 * - Non-string or empty input
 * - NUL bytes
 * - Absolute paths (POSIX `/`, Windows drive-letter `<drive>:\`, UNC `\\`)
 * - Path traversal (`..`), dot segments (`.`), empty segments
 * - Windows reserved device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9)
 * - Colons (NTFS Alternate Data Streams, Windows drive-relative)
 *
 * Returns a frozen object with:
 * - `path` — the canonical POSIX-style relative path
 * - `collisionKey` — stable case-fold key for cross-platform collision detection
 *
 * @param {string} input - Raw path string.
 * @returns {{ path: string, collisionKey: string }}
 * @throws {ReleaseError} PATH_UNSAFE on any violation.
 */
export function canonicalArtifactPath(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new ReleaseError(PATH_UNSAFE, 'path must be a non-empty string', { input });
  }

  // Reject NUL bytes
  if (input.includes('\0')) {
    throw new ReleaseError(PATH_UNSAFE, 'path contains NUL byte', { input });
  }

  // Artifact identities are POSIX-only. Converting a backslash would make an
  // invalid Windows/UNC spelling alias a different public path.
  if (input.includes('\\')) {
    throw new ReleaseError(PATH_UNSAFE, 'path must use POSIX separators', { input });
  }
  const path = input.normalize('NFC');

  // Reject absolute paths
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.startsWith('\\\\')) {
    throw new ReleaseError(PATH_UNSAFE, 'path must not be absolute', { input });
  }

  // Reject colons (ADS, drive-relative)
  if (path.includes(':')) {
    throw new ReleaseError(PATH_UNSAFE, 'path must not contain colon', { input });
  }

  // Split and validate segments
  const parts = path.split('/');
  if (path.startsWith('/') || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new ReleaseError(PATH_UNSAFE, 'path contains empty, dot, or traversal segment', { input });
  }

  if (parts.some(isWindowsReservedSegment)) {
    throw new ReleaseError(PATH_UNSAFE, 'path contains Windows reserved name', { input });
  }

  // Compute collision key: lowercase for cross-platform case-fold
  const collisionKey = path.toLocaleLowerCase('en-US');

  return Object.freeze({ path, collisionKey });
}
