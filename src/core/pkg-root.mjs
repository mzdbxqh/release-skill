/**
 * Package root resolution for bundled and unbundled execution.
 *
 * In development (unbundled) mode, `import.meta.url` points to the source
 * file under `src/core/`, so `../..` reaches the package root.
 *
 * In bundled mode, the esbuild banner defines `__bundlePkgRoot` before the
 * module body executes, derived deterministically from the bundle's own
 * file path. The env-var override path has been removed to prevent
 * callers from hijacking schema/native resolution.
 *
 * @module core/pkg-root
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// In bundled mode, __bundlePkgRoot is set by the esbuild banner.
// In development mode, resolve from this source file's location.
export const PKG_ROOT = typeof __bundlePkgRoot !== 'undefined'
  ? __bundlePkgRoot
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
