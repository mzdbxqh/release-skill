/**
 * Safe filesystem backend — JS loader, capability probe, and directory handle.
 *
 * Loads the native Node-API addon that provides no-follow/openat relative
 * directory primitives. The addon must be explicitly built with `native:build`
 * or loaded from a prebuild addon registered in prebuilds.json.
 *
 * There is NO automatic install/postinstall native build. If the addon is
 * not available, all mutating commands fail closed with SAFE_WRITE_UNAVAILABLE.
 *
 * @module artifacts/safe-fs
 */

import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { ReleaseError, SAFE_WRITE_UNAVAILABLE } from '../core/errors.mjs';

import {
  loadNativeAddon,
  createBackend,
} from './safe-fs-backend-internal.mjs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the safe filesystem backend.
 *
 * The public entry point does NOT accept `_testAddon` or any test hooks.
 * All addon loading goes through `loadNativeAddon` which validates the
 * addon path, lstat identity, and production manifest integrity.
 *
 * Tests that need a fake addon must import `createBackend` directly from
 * `./safe-fs-backend-internal.mjs`.
 */
export async function loadSafeFs(options = {}) {
  const addon = loadNativeAddon(options.addonPath);
  return createBackend(addon);
}

/**
 * Hard gate: load safe filesystem primitives and verify they work.
 * Throws SAFE_WRITE_UNAVAILABLE if the native addon is not available or
 * the real probe fails. Callers cannot proceed with writes based on
 * platform name alone.
 */
export async function requireSafeFs(options = {}) {
  const backend = await loadSafeFs(options);

  // Real probe — creates, writes, renames, reads back actual data.
  // Only realpath the default system tmpdir (macOS /var -> /private/var safety).
  // Explicit user-provided root is NOT realpath'd — openRoot will reject
  // ancestor symlinks via O_NOFOLLOW segment walk (C1).
  let root;
  if (options.root) {
    root = options.root;
  } else {
    root = await realpath(tmpdir());
  }
  const result = await backend.probe(root);

  if (!result.supported) {
    throw new ReleaseError(
      SAFE_WRITE_UNAVAILABLE,
      'safe write primitives are not functional on this platform',
    );
  }

  return backend;
}
