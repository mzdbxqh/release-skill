/**
 * Internal module: stable addon reader and backend creator.
 *
 * NOT part of the public API. Tests import this module directly to exercise
 * fake-addon scenarios without polluting the public `loadSafeFs` entry point.
 *
 * @module artifacts/safe-fs-backend-internal
 * @internal
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  ReleaseError,
  SAFE_WRITE_UNAVAILABLE,
  PATH_UNSAFE,
} from '../core/errors.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Keep this internal loader self-contained. Besides making the native trust
// boundary auditable, this lets isolated consumers test/copy it together with
// errors.mjs only. In the bundle the banner supplies __bundlePkgRoot; in source
// mode the module's own URL deterministically identifies the package root.
const PKG_ROOT = typeof __bundlePkgRoot !== 'undefined'
  ? __bundlePkgRoot
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NATIVE_BASE = resolve(PKG_ROOT, 'native/safe-write');
const PREBUILDS_PATH = resolve(NATIVE_BASE, 'prebuilds.json');
const PREBUILDS_RESOURCE = 'native/safe-write/prebuilds.json';
const DEFAULT_ADDON_PATH = resolve(NATIVE_BASE, 'build/Release/safe_write.node');

const EXPECTED_EXPORTS = Object.freeze([
  'openRoot', 'openDir', 'readEntry', 'readFile',
  'createTemp', 'rename', 'abortTemp', 'mkdir', 'rmdir', 'unlink', 'chmod', 'fsync', 'close',
]);

function failPrebuildManifest(reason, message = 'prebuilds manifest not readable') {
  throw new ReleaseError(
    SAFE_WRITE_UNAVAILABLE,
    message,
    { resource: PREBUILDS_RESOURCE, reason },
  );
}

function readTrustedPrebuildManifest() {
  let lexicalStat;
  try {
    lexicalStat = lstatSync(PREBUILDS_PATH, { bigint: true });
  } catch {
    failPrebuildManifest('MISSING');
  }

  if (lexicalStat.isSymbolicLink()) {
    failPrebuildManifest('SYMLINK', 'prebuilds manifest must not be a symlink');
  }
  if (!lexicalStat.isFile()) {
    failPrebuildManifest('NOT_REGULAR_FILE', 'prebuilds manifest is not a regular file');
  }
  if (lexicalStat.nlink !== 1n) {
    failPrebuildManifest('UNEXPECTED_HARDLINK_COUNT', 'prebuilds manifest has invalid nlink count');
  }

  let physicalBase;
  let physicalManifest;
  try {
    physicalBase = realpathSync(NATIVE_BASE);
    physicalManifest = realpathSync(PREBUILDS_PATH);
  } catch {
    failPrebuildManifest('REALPATH_FAILED');
  }
  if (!physicalManifest.startsWith(physicalBase + '/') && physicalManifest !== physicalBase) {
    failPrebuildManifest(
      'PHYSICAL_PATH_ESCAPE',
      'prebuilds manifest physical path escapes base directory',
    );
  }

  try {
    return JSON.parse(readFileSync(physicalManifest, 'utf8'));
  } catch {
    failPrebuildManifest('READ_FAILED');
  }
}

// ---------------------------------------------------------------------------
// Error sanitization
// ---------------------------------------------------------------------------

function sanitizeError(err) {
  if (typeof err?.message === 'string') {
    let msg = err.message.replace(/\/[^\s]*:\s*/g, '');
    msg = msg.replace(/\/\S+/g, '<redacted>');
    return msg;
  }
  return 'native addon error';
}

// ---------------------------------------------------------------------------
// Dev addon validation: lexical lstat + physical containment
// ---------------------------------------------------------------------------

/**
 * Validate dev addon: lexical lstat + realpath containment.
 * Returns the verified physical path on success, or null on failure.
 */
function isWithinPackageBuildDir(addonPath) {
  const buildDir = resolve(NATIVE_BASE, 'build/');
  const resolved = resolve(addonPath);
  if (!resolved.startsWith(buildDir + '/') && resolved !== buildDir) {
    return null;
  }

  // Lexical lstat candidate: must be non-symlink regular, nlink==1
  let lstatResult;
  try {
    lstatResult = lstatSync(addonPath, { bigint: true });
  } catch {
    return null;
  }
  if (lstatResult.isSymbolicLink()) return null;
  if (!lstatResult.isFile()) return null;
  if (lstatResult.nlink !== 1n) return null;

  // Physical containment: realpath both buildDir and addonPath
  try {
    const physicalBuildDir = realpathSync(buildDir);
    const physicalAddon = realpathSync(addonPath);
    if (!(physicalAddon.startsWith(physicalBuildDir + '/') || physicalAddon === physicalBuildDir)) {
      return null;
    }
    return physicalAddon;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Manifest entry validation
// ---------------------------------------------------------------------------

function validateManifestEntry(entry, key) {
  if (typeof entry !== 'object' || entry === null) {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, `invalid manifest entry for ${key}`);
  }
  if (typeof entry.path !== 'string' || entry.path.length === 0) {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, `manifest entry missing path for ${key}`);
  }
  if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, `manifest entry missing or invalid sha256 for ${key}`);
  }
  if (typeof entry.exports !== 'object' || !Array.isArray(entry.exports)) {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, `manifest entry missing exports for ${key}`);
  }

  const resolved = resolve(NATIVE_BASE, entry.path);
  const baseDir = NATIVE_BASE;
  if (!resolved.startsWith(baseDir + '/') && resolved !== baseDir) {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, `manifest path escapes base directory for ${key}`);
  }

  const sortedActual = [...entry.exports].sort();
  const sortedExpected = [...EXPECTED_EXPORTS].sort();
  if (sortedActual.length !== sortedExpected.length ||
      sortedActual.some((v, i) => v !== sortedExpected[i])) {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, `manifest exports mismatch for ${key}`);
  }
}

// ---------------------------------------------------------------------------
// requireAddon: createRequire wrapper
// ---------------------------------------------------------------------------

function requireAddon(addonPath) {
  try {
    // Use PKG_ROOT-relative resolution so bundled mode can find the addon.
    const require = createRequire(resolve(PKG_ROOT, 'package.json'));
    return require(addonPath);
  } catch (err) {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, sanitizeError(err));
  }
}

// ---------------------------------------------------------------------------
// readStableAddon: pure function called ONLY by the main loader with real fs ops.
// Accepts optional fs hooks for testing identity-swap TOCTOU detection.
//
// Production: called with no hooks → uses real readFileSync/lstatSync.
// Test: inject { _hooks: { readFileSync, lstatSync } } to exercise TOCTOU.
//
// Step 1: lstat LEXICAL candidate ({bigint:true}) → reject symlink / non-regular / nlink!=1
// Step 2: realpath → compare with physical native base for containment
// Step 3: stable read (pre-stat → read → hash → post-stat → identity compare)
// Step 4: require addon from verified physical path (NO hooks)
// Step 5: post-require identity verification (lstat again, compare with pre-require)
// ---------------------------------------------------------------------------

export function readStableAddon(options = {}) {
  const hooks = options._hooks || {};
  const manifest = readTrustedPrebuildManifest();

  if (!manifest.prebuilds || typeof manifest.prebuilds !== 'object') {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'prebuilds manifest has invalid structure');
  }

  const key = `${process.platform}-${process.arch}`;
  const entry = manifest.prebuilds[key];
  if (!entry) {
    throw new ReleaseError(
      SAFE_WRITE_UNAVAILABLE,
      `no prebuilt addon for ${key}; build from source with native:build`,
    );
  }

  validateManifestEntry(entry, key);

  // Resolve lexical candidate path
  const addonFile = resolve(NATIVE_BASE, entry.path);

  // Step 1: lstat LEXICAL path FIRST — reject symlink, non-regular, nlink!=1
  // Must lstat the original path to detect symlinks; lstat on a resolved path
  // would return the target file's stats and miss the symlink.
  // lstat must come before realpath to reject symlinks before physical resolution.
  const lstatFn = hooks.lstatSync || lstatSync;
  const lstatOpts = { bigint: true };
  let preStat;
  try {
    preStat = lstatFn(addonFile, lstatOpts);
    if (preStat.isSymbolicLink()) {
      throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'prebuilt addon must not be a symlink');
    }
    if (!preStat.isFile()) {
      throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'prebuilt addon is not a regular file');
    }
    if (preStat.nlink !== 1n) {
      throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'prebuilt addon has invalid nlink count');
    }
  } catch (e) {
    if (e instanceof ReleaseError) throw e;
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'prebuilt addon not accessible');
  }

  // Step 2: realpath → physical containment
  let physicalAddonFile;
  try {
    physicalAddonFile = realpathSync(addonFile);
  } catch {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'prebuilt addon not accessible');
  }

  const nativeBaseDir = realpathSync(NATIVE_BASE);
  if (!physicalAddonFile.startsWith(nativeBaseDir + '/') && physicalAddonFile !== nativeBaseDir) {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'prebuilt addon physical path escapes base directory');
  }

  // Step 3: hash the file bytes
  const readFn = hooks.readFileSync || readFileSync;
  let data;
  try {
    data = readFn(physicalAddonFile);
  } catch {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'prebuilt addon not readable');
  }

  const hash = createHash('sha256').update(data).digest('hex');
  if (hash !== entry.sha256) {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'prebuilt addon SHA-256 mismatch');
  }

  // Step 4: post-read identity verification (TOCTOU detection)
  // Must lstat the same lexical path as preStat for consistent comparison.
  let postStat;
  try {
    postStat = lstatFn(addonFile, lstatOpts);
  } catch {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'prebuilt addon identity check failed');
  }

  // Compare full stable identity fields (bigint)
  if (preStat.dev !== postStat.dev ||
      preStat.ino !== postStat.ino ||
      preStat.mode !== postStat.mode ||
      preStat.nlink !== postStat.nlink ||
      preStat.size !== postStat.size ||
      preStat.mtimeNs !== postStat.mtimeNs ||
      preStat.ctimeNs !== postStat.ctimeNs) {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'prebuilt addon identity changed during read (TOCTOU detected)');
  }

  // Step 5: require addon from verified physical path (NO hooks)
  const addon = requireAddon(physicalAddonFile);

  // Step 6: post-require identity verification
  // Must lstat the same lexical path as preStat for consistent comparison.
  let postRequireStat;
  try {
    postRequireStat = lstatFn(addonFile, lstatOpts);
  } catch {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'prebuilt addon identity check failed after require');
  }

  if (preStat.dev !== postRequireStat.dev ||
      preStat.ino !== postRequireStat.ino ||
      preStat.mode !== postRequireStat.mode ||
      preStat.nlink !== postRequireStat.nlink ||
      preStat.size !== postRequireStat.size ||
      preStat.mtimeNs !== postRequireStat.mtimeNs ||
      preStat.ctimeNs !== postRequireStat.ctimeNs) {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'prebuilt addon identity changed during require (TOCTOU detected)');
  }

  // Verify exports match manifest
  const addonExports = Object.keys(addon).sort();
  const expectedExports = [...EXPECTED_EXPORTS].sort();
  if (addonExports.length !== expectedExports.length ||
      addonExports.some((v, i) => v !== expectedExports[i])) {
    throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'addon exports do not match manifest');
  }

  return addon;
}

// ---------------------------------------------------------------------------
// loadNativeAddon: production addon loader (dev + prebuilt)
// ---------------------------------------------------------------------------

export function loadNativeAddon(addonPath) {
  // 1. Explicit path — only in dev mode, must be within build dir
  if (addonPath) {
    if (process.env.RELEASE_SKILL_NATIVE_DEV !== '1') {
      throw new ReleaseError(
        SAFE_WRITE_UNAVAILABLE,
        'explicit addonPath is only allowed in development mode',
      );
    }
    const physicalPath = isWithinPackageBuildDir(addonPath);
    if (!physicalPath) {
      throw new ReleaseError(
        SAFE_WRITE_UNAVAILABLE,
        'addonPath is outside the package build directory',
      );
    }
    // Require from verified physical path to prevent TOCTOU swap
    return requireAddon(physicalPath);
  }

  // 2. Development mode
  if (process.env.RELEASE_SKILL_NATIVE_DEV === '1') {
    const devPath = DEFAULT_ADDON_PATH;
    const physicalPath = isWithinPackageBuildDir(devPath);
    if (!physicalPath) {
      throw new ReleaseError(SAFE_WRITE_UNAVAILABLE, 'dev addon path is outside build directory');
    }
    // Require from verified physical path
    return requireAddon(physicalPath);
  }

  // 3. Prebuilt addon from manifest
  return readStableAddon();
}

// ---------------------------------------------------------------------------
// wrapHandle: wrap native directory handle (addon-agnostic)
// ---------------------------------------------------------------------------

function wrapHandle(addon, nativeHandle, nativeTokenMap, nativeIdentityMap) {
  const handle = {
    async openDir(name) {
      try {
        const nativeChild = addon.openDir(nativeHandle, name);
        return wrapHandle(addon, nativeChild, nativeTokenMap, nativeIdentityMap);
      } catch (err) {
        throw new ReleaseError(err.code || PATH_UNSAFE, sanitizeError(err));
      }
    },

    async readEntry(name) {
      try {
        return addon.readEntry(nativeHandle, name);
      } catch (err) {
        throw new ReleaseError(err.code || PATH_UNSAFE, sanitizeError(err));
      }
    },

    async readFile(name) {
      try {
        const result = addon.readFile(nativeHandle, name);
        if (result === null) return null;
        const publicResult = Object.freeze({
          bytes: result.bytes,
          size: Number(result.size),
          mode: Number(result.mode),
          dev: Number(result.dev),
          ino: Number(result.ino),
          nlink: Number(result.nlink),
          mtimeNs: Number(result.mtimeNs),
          ctimeNs: Number(result.ctimeNs),
        });
        nativeIdentityMap.set(publicResult, result);
        return publicResult;
      } catch (err) {
        throw new ReleaseError(err.code || PATH_UNSAFE, sanitizeError(err));
      }
    },

    async createTemp(name, mode, data) {
      try {
        const nativeResult = addon.createTemp(nativeHandle, name, mode, data);
        const publicToken = Object.freeze({ name: nativeResult.tempName });
        nativeTokenMap.set(publicToken, nativeResult);
        return publicToken;
      } catch (err) {
        throw new ReleaseError(err.code || PATH_UNSAFE, sanitizeError(err));
      }
    },

    async rename(publicToken, to, expectedIdentity) {
      try {
        const nativeToken = nativeTokenMap.get(publicToken);
        if (!nativeToken) {
          throw new ReleaseError(PATH_UNSAFE, 'rename: invalid or forged token');
        }
        if (expectedIdentity === undefined || expectedIdentity === null) {
          addon.rename(nativeHandle, nativeToken, to);
        } else {
          const nativeIdentity = nativeIdentityMap.get(expectedIdentity);
          if (!nativeIdentity) {
            throw new ReleaseError(PATH_UNSAFE, 'rename: invalid or forged expected identity');
          }
          addon.rename(nativeHandle, nativeToken, to, nativeIdentity);
        }
        nativeTokenMap.delete(publicToken);
      } catch (err) {
        throw new ReleaseError(err.code || PATH_UNSAFE, sanitizeError(err));
      }
    },

    async abortTemp(publicToken) {
      try {
        const nativeToken = nativeTokenMap.get(publicToken);
        if (!nativeToken) {
          throw new ReleaseError(PATH_UNSAFE, 'abortTemp: invalid or forged token');
        }
        const nativeResult = addon.abortTemp(nativeHandle, nativeToken);
        nativeTokenMap.delete(publicToken);
        // Build a new frozen object — never forward the native plain object directly.
        return Object.freeze({
          removed: !!nativeResult.removed,
          reason: String(nativeResult.reason),
        });
      } catch (err) {
        throw new ReleaseError(err.code || PATH_UNSAFE, sanitizeError(err));
      }
    },

    async mkdir(name, mode) {
      try {
        addon.mkdir(nativeHandle, name, mode);
      } catch (err) {
        throw new ReleaseError(err.code || PATH_UNSAFE, sanitizeError(err));
      }
    },

    async rmdir(name) {
      try {
        addon.rmdir(nativeHandle, name);
      } catch (err) {
        throw new ReleaseError(err.code || PATH_UNSAFE, sanitizeError(err));
      }
    },

    async unlink(name) {
      try {
        addon.unlink(nativeHandle, name);
      } catch (err) {
        throw new ReleaseError(err.code || PATH_UNSAFE, sanitizeError(err));
      }
    },

    async chmod(name, mode) {
      try {
        addon.chmod(nativeHandle, name, mode);
      } catch (err) {
        throw new ReleaseError(err.code || PATH_UNSAFE, sanitizeError(err));
      }
    },

    async fsync() {
      try {
        addon.fsync(nativeHandle);
      } catch (err) {
        throw new ReleaseError(err.code || PATH_UNSAFE, sanitizeError(err));
      }
    },

    async close() {
      try {
        addon.close(nativeHandle);
      } catch (err) {
        throw new ReleaseError(err.code || PATH_UNSAFE, sanitizeError(err));
      }
    },
  };

  return Object.freeze(handle);
}

// ---------------------------------------------------------------------------
// createBackend: build backend from addon (addon-agnostic)
// ---------------------------------------------------------------------------

export function createBackend(addon) {
  // WeakMap: frozen public token -> native token object (A3)
  const nativeTokenMap = new WeakMap();
  // WeakMap: frozen readFile result -> addon-produced identity object. This
  // makes replace authorization unforgeable at the JS boundary.
  const nativeIdentityMap = new WeakMap();

  const backend = Object.freeze({
    async probe(root) {
      const primitives = [];
      let handle = null;
      let closeAttempted = false;
      try {
        handle = await backend.openRoot(root);

        const probeId = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const probeFinal = `${probeId}-final.txt`;

        const probeData = Buffer.from('probe-data-verify');
        const tmpToken = await handle.createTemp(`${probeId}.txt`, 0o600, probeData);
        primitives.push('createTemp');

        await handle.rename(tmpToken, probeFinal);
        primitives.push('rename');

        await handle.readEntry(probeFinal);
        primitives.push('readEntry');

        const readResult = await handle.readFile(probeFinal);
        if (!readResult) {
          throw new Error('probe readFile returned null for committed file');
        }
        if (!Buffer.isBuffer(readResult.bytes) ||
            !readResult.bytes.equals(probeData)) {
          throw new Error('probe readFile bytes mismatch');
        }
        if (readResult.size !== probeData.length) {
          throw new Error('probe readFile size mismatch');
        }
        primitives.push('readFile');

        await handle.fsync();
        primitives.push('fsync');

        await handle.chmod(probeFinal, 0o644);
        const postChmod = await handle.readFile(probeFinal);
        if (!postChmod) {
          throw new Error('probe readFile after chmod returned null');
        }
        if (postChmod.mode !== 0o644) {
          throw new Error(`probe chmod mode mismatch: expected 0o644, got 0o${postChmod.mode.toString(8)}`);
        }
        primitives.push('chmod');

        const abortToken = await handle.createTemp(`${probeId}-abort.txt`, 0o600, Buffer.from('abort'));
        const abortResult = await handle.abortTemp(abortToken);
        if (!abortResult || abortResult.removed !== true) {
          throw new Error('probe abortTemp must return {removed: true}');
        }
        primitives.push('abortTemp');

        await handle.unlink(probeFinal);
        primitives.push('unlink');

        // mkdir/rmdir: create 0700 subdirectory, verify with openDir, clean up
        const probeSubdir = `${probeId}-subdir`;
        await handle.mkdir(probeSubdir, 0o700);
        primitives.push('mkdir');

        const childHandle = await handle.openDir(probeSubdir);
        const childEntry = await childHandle.readEntry('.');
        if (!childEntry || childEntry.type !== 'directory') {
          throw new Error('probe mkdir did not create a directory');
        }
        if ((childEntry.mode & 0o777) !== 0o700) {
          throw new Error(`probe mkdir mode mismatch: expected 0700, got 0o${(childEntry.mode & 0o777).toString(8)}`);
        }
        await childHandle.close();

        await handle.rmdir(probeSubdir);
        primitives.push('rmdir');

        closeAttempted = true;
        await handle.close();
        handle = null;

        return Object.freeze({
          supported: true,
          platform: `${process.platform}-${process.arch}`,
          primitives: Object.freeze(primitives),
        });
      } catch {
        if (handle && !closeAttempted) {
          closeAttempted = true;
          try { await handle.close(); } catch { /* best-effort */ }
        }
        return Object.freeze({
          supported: false,
          platform: `${process.platform}-${process.arch}`,
          primitives: Object.freeze(primitives),
        });
      }
    },

    async openRoot(root) {
      if (typeof root !== 'string' || root.length === 0) {
        throw new ReleaseError(PATH_UNSAFE, 'openRoot requires a non-empty root path');
      }
      try {
        const nativeHandle = addon.openRoot(root);
        return wrapHandle(addon, nativeHandle, nativeTokenMap, nativeIdentityMap);
      } catch (err) {
        throw new ReleaseError(err.code || PATH_UNSAFE, sanitizeError(err));
      }
    },

    async openEntry(rootOrPath, relativePath) {
      if (typeof rootOrPath !== 'string' || rootOrPath.length === 0) {
        throw new ReleaseError(PATH_UNSAFE, 'openEntry requires a root path');
      }

      if (relativePath === undefined || relativePath === null) {
        throw new ReleaseError(PATH_UNSAFE,
          'openEntry requires (root, relativePath); single absolutePath is not supported');
      }

      if (typeof relativePath !== 'string' || relativePath.length === 0) {
        throw new ReleaseError(PATH_UNSAFE, 'openEntry requires a non-empty relative path');
      }

      if (relativePath.startsWith('/') || relativePath.includes('\\')) {
        throw new ReleaseError(PATH_UNSAFE,
          'openEntry: relative path must not be absolute or contain backslashes');
      }
      if (relativePath.includes('\0')) {
        throw new ReleaseError(PATH_UNSAFE, 'openEntry: relative path must not contain NUL');
      }

      const rawSegments = relativePath.split('/');
      for (const seg of rawSegments) {
        if (seg.length === 0) {
          throw new ReleaseError(PATH_UNSAFE,
            'openEntry: relative path must not contain empty segments');
        }
        if (seg === '.' || seg === '..') {
          throw new ReleaseError(PATH_UNSAFE, 'openEntry: relative path must not contain . or ..');
        }
      }
      const segments = rawSegments;
      if (segments.length === 0) {
        throw new ReleaseError(PATH_UNSAFE, 'openEntry: relative path is empty');
      }

      const handleStack = [];
      const rootHandle = await backend.openRoot(rootOrPath);
      handleStack.push(rootHandle);
      let primaryResult;
      let primaryError;
      try {
        for (let i = 0; i < segments.length - 1; i++) {
          const childHandle = await handleStack[handleStack.length - 1].openDir(segments[i]);
          handleStack.push(childHandle);
        }

        const leaf = segments[segments.length - 1];
        const result = await handleStack[handleStack.length - 1].readFile(leaf);

        if (result === null) {
          throw new ReleaseError(PATH_UNSAFE, 'openEntry: file does not exist');
        }
        primaryResult = Object.freeze({
          type: 'file',
          size: result.size,
          mode: result.mode,
        });
      } catch (err) {
        primaryError = err instanceof ReleaseError ? err : new ReleaseError(PATH_UNSAFE, sanitizeError(err));
      }

      // Close in reverse order, tracking failures
      const closeFailures = [];
      for (let i = handleStack.length - 1; i >= 0; i--) {
        try {
          await handleStack[i].close();
        } catch (closeErr) {
          closeFailures.push(sanitizeError(closeErr));
        }
      }

      if (primaryError) {
        if (closeFailures.length > 0) {
          primaryError.details.closeFailures = closeFailures;
        }
        throw primaryError;
      }

      if (closeFailures.length > 0) {
        throw new ReleaseError(
          PATH_UNSAFE,
          'openEntry: handle close failed after successful operation',
          { closeFailures },
        );
      }

      return primaryResult;
    },
  });

  return backend;
}
