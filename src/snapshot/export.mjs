/**
 * Safe snapshot export: build a public snapshot from a release unit.
 *
 * Provides a backward-compatible `buildSnapshot` adapter that accepts
 * both `{sourceRoot,...}` (new) and `{root,...}` (legacy) calling
 * conventions. Old callers pass `root` to mean repository root.
 *
 * All snapshot building goes through the explicit publicFiles mapper —
 * no implicit git or package.json collection.
 *
 * Uses an explicit whitelist of allowed parameters. Any unknown option
 * (including legacy `generatedFiles`, `forbiddenPaths`, `files`,
 * `includePatterns`) is rejected with CONFIG_INVALID — fail closed.
 *
 * @module snapshot/export
 */

import { buildPublicStaging } from './public-map.mjs';
import { ReleaseError, CONFIG_INVALID } from '../core/errors.mjs';

/** Explicit whitelist of allowed parameters for buildSnapshot. */
const ALLOWED_PARAMS = new Set([
  'sourceRoot',
  'root',
  'unit',
  'outputDir',
]);

/**
 * Backward-compatible buildSnapshot adapter.
 *
 * Accepts `sourceRoot` (preferred) or `root` (legacy alias).
 * Uses an explicit whitelist — any unknown option is rejected with
 * CONFIG_INVALID to prevent silent data loss.
 *
 * Internal test hooks (_afterCopy, _beforeOpen, _afterSourceRead,
 * _afterDestRead, _fsOps) are NOT accepted by the public adapter.
 * Tests must call buildPublicStaging directly for hook injection.
 *
 * @param {object} options
 * @param {string} [options.sourceRoot] - Absolute source root.
 * @param {string} [options.root] - Legacy alias for sourceRoot.
 * @param {object} options.unit - Release unit configuration.
 * @param {string} [options.outputDir] - Output directory for staged files.
 * @returns {Promise<SnapshotManifest>}
 */
export async function buildSnapshot(options = {}) {
  // Reject null/undefined options — CONFIG_INVALID, not TypeError
  if (options === null || options === undefined) {
    throw new ReleaseError(
      CONFIG_INVALID,
      'buildSnapshot options must be a non-null object',
      { options },
    );
  }

  // Reject any unknown parameters — whitelist, not blacklist.
  // Hooks are intentionally excluded from the public API.
  const unknownKeys = Object.keys(options).filter((k) => !ALLOWED_PARAMS.has(k));
  if (unknownKeys.length > 0) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unknown parameter(s) not allowed in buildSnapshot: ${unknownKeys.join(', ')}`,
      { unknownKeys },
    );
  }

  const {
    sourceRoot,
    root: legacyRoot,
    unit,
    outputDir,
  } = options;

  // Reject simultaneous sourceRoot and root — no silent precedence.
  if (sourceRoot !== undefined && legacyRoot !== undefined) {
    throw new ReleaseError(
      CONFIG_INVALID,
      'buildSnapshot accepts either sourceRoot or root, not both',
      { sourceRoot, root: legacyRoot },
    );
  }

  const effectiveSourceRoot = sourceRoot ?? legacyRoot;

  if (!effectiveSourceRoot) {
    throw new ReleaseError(
      CONFIG_INVALID,
      'buildSnapshot requires either sourceRoot or root',
      { sourceRoot, root: legacyRoot },
    );
  }

  return buildPublicStaging({
    sourceRoot: effectiveSourceRoot,
    unit,
    outputDir,
  });
}
