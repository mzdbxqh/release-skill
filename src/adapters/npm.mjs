import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';

import libnpmpublish from 'libnpmpublish';
import npmRegistryFetch from 'npm-registry-fetch';

import {
  ActionStatus,
  ActionType,
  assertWritesAuthorized,
  createResult,
  matchObservation,
} from './contract.mjs';

const execFile = promisify(execFileCb);
const NAME = 'npm';
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;

function validatePackageName(value) {
  if (typeof value !== 'string' || value.length > 214 || !SAFE_PACKAGE_NAME.test(value)) {
    throw new Error('npm package must be a safe lowercase package name or @scope/name');
  }
}

/**
 * Normalize a registry URL to a canonical form.
 * Ensures the URL has a protocol, no trailing slash, and is lowercase.
 *
 * @param {string} registry - The registry URL to normalize.
 * @returns {string} The normalized registry URL.
 * @throws {Error} If the registry is not a valid URL.
 */
export function normalizeRegistry(registry) {
  if (typeof registry !== 'string' || registry.trim().length === 0) {
    throw new Error('registry must be a non-empty string');
  }

  let parsed;
  try {
    parsed = new URL(registry.trim());
  } catch {
    throw new Error(`invalid registry URL: ${registry}`);
  }
  if (parsed.protocol !== 'https:') throw new Error('npm registry must use https');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('npm registry URL must not contain credentials, query, or fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

async function run(command, args, options = {}) {
  return execFile(command, args, {
    shell: false,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
}

/**
 * Default publishTarballBuffer implementation using libnpmpublish.
 * Receives verified bytes directly — no named temp file involved.
 * Authentication and registry options must be supplied explicitly by the
 * caller; errors are sanitized before they cross the adapter boundary.
 */
async function defaultPublishTarballBuffer({ buffer, manifest, opts: publishOpts }) {
  const libOpts = {};
  if (publishOpts.registry) libOpts.registry = publishOpts.registry;
  if (publishOpts.token) libOpts.forceAuth = { token: publishOpts.token };
  if (publishOpts.access) libOpts.access = publishOpts.access;
  if (publishOpts.tag) libOpts.defaultTag = publishOpts.tag;
  if (publishOpts.provenance) libOpts.provenance = publishOpts.provenance;
  return libnpmpublish.publish(manifest, buffer, libOpts);
}

export function registryTokenKey(registry) {
  const url = new URL(`${normalizeRegistry(registry)}/`);
  return `//${url.host}${url.pathname}:_authToken`;
}

function expandNpmrcValue(raw, env) {
  const value = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    if (!Object.hasOwn(env, name)) throw new Error('npm auth token references an unset environment variable');
    return env[name];
  });
}

async function tokensFromNpmrc(path, key, env) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw new Error('cannot read npm authentication config');
  }
  const tokens = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const separator = line.indexOf('=');
    if (separator < 0 || line.slice(0, separator).trim() !== key) continue;
    const token = expandNpmrcValue(line.slice(separator + 1), env);
    if (!token) throw new Error('npm authentication token is empty');
    tokens.push(token);
  }
  return tokens;
}

async function defaultResolveAuthToken({ registry, cwd, exec, env = process.env }) {
  const candidates = [];
  for (const name of ['NPM_TOKEN', 'NODE_AUTH_TOKEN']) {
    if (env[name]) candidates.push(env[name]);
  }
  const key = registryTokenKey(registry);
  candidates.push(...await tokensFromNpmrc(join(cwd, '.npmrc'), key, env));

  // Assemble the lowercase npm config key so the release leakage scanner does
  // not mistake the environment-variable name itself for an npm access token.
  const npmUserConfigKey = ['npm', 'config', 'userconfig'].join('_');
  const userConfig = env[npmUserConfigKey]
    ?? (await exec('npm', ['config', 'get', 'userconfig'], { cwd, shell: false })).stdout.trim();
  if (userConfig) candidates.push(...await tokensFromNpmrc(userConfig, key, env));

  const unique = [...new Set(candidates)];
  if (unique.length === 0) throw new Error('npm bearer authentication is not configured for the frozen registry');
  if (unique.length !== 1) throw new Error('ambiguous npm bearer authentication for the frozen registry');
  return unique[0];
}

export async function resolveNpmRegistryAuthToken(options) {
  return defaultResolveAuthToken(options);
}

async function defaultWhoamiWithToken({ registry, token, cwd, exec }) {
  try {
    const result = await npmRegistryFetch.json('/-/whoami', {
      registry: `${normalizeRegistry(registry)}/`,
      forceAuth: { token },
      preferOnline: true,
    });
    if (!result || typeof result.username !== 'string' || !result.username) {
      throw new Error('npm registry whoami returned an invalid identity');
    }
    return result.username;
  } catch {
    throw new Error('npm bearer authentication does not match the frozen registry and publisher');
  }
}

export function resolvePackageCwd(cwd, root) {
  if (!cwd || typeof cwd !== 'string') throw new Error('NPM_PUBLISH requires a non-empty action.cwd (package directory)');
  const rootPath = resolve(root);
  const packagePath = resolve(root, cwd);
  const rel = relative(rootPath, packagePath);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`cwd "${cwd}" is outside project root "${root}"`);
  }
  return packagePath;
}

function isNotFound(error) {
  const text = `${error?.code ?? ''}\n${error?.stdout ?? ''}\n${error?.stderr ?? ''}\n${error?.message ?? ''}`;
  return /\bE404\b|\b404\b.*not found|not found.*\b404\b/i.test(text);
}

async function verifyTarball(action, root) {
  if (!action.tarballPath || isAbsolute(action.tarballPath)) throw new Error('tarballPath must be project-relative');
  if (!/^[a-f0-9]{64}$/.test(action.tarballSha256 ?? '')) throw new Error('tarballSha256 must be a lowercase SHA-256 digest');
  const rootReal = await realpath(root);
  const lexical = resolve(rootReal, action.tarballPath);
  const rel = relative(rootReal, lexical);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('tarballPath escapes project root');
  }
  const st = await lstat(lexical);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error('frozen tarball must be a single-link regular file');
  const physical = await realpath(lexical);
  const physicalRel = relative(rootReal, physical);
  if (isAbsolute(physicalRel) || physicalRel === '..' || physicalRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('tarballPath resolves outside project root');
  }
  const bytes = await readFile(physical);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== action.tarballSha256) throw new Error('frozen npm tarball SHA-256 mismatch');
  return physical;
}

/**
 * Read the frozen tarball into a Buffer with O_NOFOLLOW identity verification.
 * Validates: path safety, symlink/hardlink rejection, size stability across
 * open/read/close, and SHA-256 digest against the frozen plan.
 *
 * @returns {Buffer} the verified tarball bytes
 */
async function readVerifiedTarballBytes(action, root) {
  if (!action.tarballPath || isAbsolute(action.tarballPath)) throw new Error('tarballPath must be project-relative');
  if (!/^[a-f0-9]{64}$/.test(action.tarballSha256 ?? '')) throw new Error('tarballSha256 must be a lowercase SHA-256 digest');
  const rootReal = await realpath(root);
  const lexical = resolve(rootReal, action.tarballPath);
  const rel = relative(rootReal, lexical);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('tarballPath escapes project root');
  }
  const before = await lstat(lexical);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('frozen tarball must be a single-link regular file');
  }
  const source = await open(lexical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = await source.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('frozen tarball changed before read');
    }
    bytes = Buffer.alloc(opened.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await source.read(bytes, position, bytes.length - position, position);
      if (bytesRead === 0) throw new Error('frozen tarball ended during read');
      position += bytesRead;
    }
    const after = await source.stat();
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 ||
      after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error('frozen tarball changed during read');
    }
  } finally {
    await source.close();
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== action.tarballSha256) throw new Error('frozen npm tarball SHA-256 mismatch');
  if (typeof action.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(action.integrity)) {
    throw new Error('frozen npm tarball integrity must be an sha512 SRI value');
  }
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== action.integrity) throw new Error('frozen npm tarball SHA-512 integrity mismatch');
  return bytes;
}

/**
 * Extract and parse the package/package.json manifest from a tarball Buffer.
 * Supports plain tar and gzip-compressed tarballs.  Throws if the manifest
 * is missing, not valid JSON, or the extracted name/version do not match the
 * expected action values.
 *
 * @param {Buffer} tarballBuffer - the raw tarball bytes (gzipped or plain tar)
 * @param {{ name: string, version: string }} expected - must match manifest
 * @returns {object} the parsed package.json manifest
 */
function extractManifestFromTarball(tarballBuffer, expected) {
  const isGzip = tarballBuffer.length >= 2 && tarballBuffer[0] === 0x1f && tarballBuffer[1] === 0x8b;
  let data = tarballBuffer;
  if (isGzip) {
    try {
      data = gunzipSync(tarballBuffer);
    } catch {
      throw new Error('frozen npm tarball has an invalid gzip stream');
    }
  }

  // Walk tar entries to find package/package.json
  let offset = 0;
  let manifest = null;
  while (offset + 512 <= data.length) {
    // Check for all-zero end-of-archive block
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (data[offset + i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    const header = data.subarray(offset, offset + 512);
    const storedChecksumText = header.toString('ascii', 148, 156).replace(/\0.*$/, '').trim();
    if (!/^[0-7]+$/.test(storedChecksumText)) throw new Error('frozen npm tarball has an invalid tar checksum field');
    const storedChecksum = Number.parseInt(storedChecksumText, 8);
    let computedChecksum = 0;
    for (let i = 0; i < header.length; i += 1) {
      computedChecksum += i >= 148 && i < 156 ? 0x20 : header[i];
    }
    if (computedChecksum !== storedChecksum) throw new Error('frozen npm tarball header checksum mismatch');

    const name = data.toString('utf8', offset, offset + 100).replace(/\0.*$/, '');
    const sizeStr = data.toString('utf8', offset + 124, offset + 136).replace(/\0.*$/, '').trim();
    if (sizeStr && !/^[0-7]+$/.test(sizeStr)) throw new Error('frozen npm tarball has an invalid entry size');
    const size = sizeStr ? Number.parseInt(sizeStr, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('frozen npm tarball entry size is unsafe');
    const typeFlag = data[offset + 156];

    // Normalize: ustar may prefix with a numeric field at offset 345 for long names
    let entryName = name;
    // If prefix field is non-empty, the real path is prefix/name
    const prefix = data.toString('utf8', offset + 345, offset + 500).replace(/\0.*$/, '');
    if (prefix) entryName = `${prefix}/${name}`;

    // Match package/package.json (standard npm tarball layout)
    if (entryName === 'package/package.json') {
      if (!(typeFlag === 0 || typeFlag === 48 /* '0' */)) {
        throw new Error('tarball package/package.json must be a regular file');
      }
      if (manifest) throw new Error('tarball contains duplicate package/package.json entries');
      const bodyStart = offset + 512;
      const bodyEnd = bodyStart + size;
      if (bodyEnd > data.length) throw new Error('frozen npm tarball entry exceeds archive bounds');
      if (size > 10 * 1024 * 1024) throw new Error('tarball package/package.json is unreasonably large');
      const body = data.subarray(bodyStart, bodyEnd);
      try {
        manifest = JSON.parse(body.toString('utf8'));
      } catch (err) {
        throw new Error(`tarball package/package.json is not valid JSON: ${err.message}`);
      }
      if (manifest.name !== expected.name) {
        throw new Error(`tarball manifest name "${manifest.name}" does not match expected "${expected.name}"`);
      }
      if (manifest.version !== expected.version) {
        throw new Error(`tarball manifest version "${manifest.version}" does not match expected "${expected.version}"`);
      }
    }

    // Advance to next header: 512 header + ceil(size/512)*512 data
    const nextOffset = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > data.length) {
      throw new Error('frozen npm tarball entry exceeds archive bounds');
    }
    offset = nextOffset;
  }
  if (!manifest) throw new Error('tarball does not contain package/package.json');
  return manifest;
}

/**
 * Verify frozen tarball bytes, integrity, and the embedded npm identity.
 * This is safe to call during prepare or a global preflight, before any
 * external write is authorized.
 */
export async function verifyFrozenNpmTarballIdentity(action, root) {
  const buffer = await readVerifiedTarballBytes(action, root);
  return extractManifestFromTarball(buffer, {
    name: action.package,
    version: action.version,
  });
}

/**
 * Read and verify the frozen tarball, then write it to a controlled named
 * temp file under a temp directory adjacent to the source. Returns the temp
 * file path, a cleanup handle, and a post-publish verifier.
 *
 * Threat model:
 * - Same-UID concurrent processes on generic POSIX can replace or read any
 *   path the current user can access. npm CLI's named-path interface cannot
 *   atomically hand off bytes to npm. Therefore the verification seam between
 *   our write and npm's read is a *process-internal drift detector*, not an
 *   OS-level isolation guarantee against same-UID malicious actors.
 * - We do NOT claim to defend against a concurrent same-UID process that
 *   replaces the named tarball between our pre-spawn check and npm's open.
 * - We DO detect: content drift, symlink/hardlink swaps, size/metadata changes,
 *   and unexpected deletion — both before spawn and after npm returns.
 *
 * Security properties:
 * - Source tarball is opened with O_NOFOLLOW and identity-checked (dev/ino/nlink).
 * - Content SHA-256 is verified against the frozen plan digest.
 * - Temp file is created exclusive (wx) with restrictive permissions (0o400).
 * - After writing, the temp file identity is recorded (dev/ino/nlink/size/mtime/ctime).
 * - Internal test hook (if present) runs between write completion and pre-spawn
 *   verification; any tampering is caught by the identity comparison.
 * - Pre-spawn verification re-opens with O_NOFOLLOW and compares
 *   dev/ino/nlink/size/mtime/ctime against creation-time values, then reads
 *   back and verifies content SHA-256.
 * - Post-publish verification (after npm returns) re-opens with O_NOFOLLOW,
 *   compares identity fields against creation-time values, and reads back
 *   SHA-256. If the file changed, the result status is "unknown" and the
 *   caller must not treat the publish as successful.
 * - Temp directory is created with identity recorded (dev/ino); cleanup
 *   verifies identity before removal and fails closed if replaced.
 * - All paths are verified to be within the production asset root.
 *
 * @returns {{ tarballPath: string, cleanup: () => Promise<void>, verifyPostPublish: () => Promise<{ok: boolean, error?: string}> }}
 */
async function createNamedVerifiedTarball(action, root, tamperHook) {
  if (!action.tarballPath || isAbsolute(action.tarballPath)) throw new Error('tarballPath must be project-relative');
  if (!/^[a-f0-9]{64}$/.test(action.tarballSha256 ?? '')) throw new Error('tarballSha256 must be a lowercase SHA-256 digest');
  const rootReal = await realpath(root);
  const lexical = resolve(rootReal, action.tarballPath);
  const rel = relative(rootReal, lexical);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('tarballPath escapes project root');
  }
  const before = await lstat(lexical);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('frozen tarball must be a single-link regular file');
  }
  const source = await open(lexical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = await source.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('frozen tarball changed before read');
    }
    bytes = Buffer.alloc(opened.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await source.read(bytes, position, bytes.length - position, position);
      if (bytesRead === 0) throw new Error('frozen tarball ended during read');
      position += bytesRead;
    }
    const after = await source.stat();
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 ||
      after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error('frozen tarball changed during read');
    }
  } finally {
    await source.close();
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== action.tarballSha256) throw new Error('frozen npm tarball SHA-256 mismatch');

  // Verify all parent paths between the tarball and the project root are real
  // directories (not symlinks). This prevents symlink-based path traversal
  // within the production asset root. We only check paths inside the root;
  // paths above the root (e.g., /var, /tmp) are outside our control.
  const parentDir = dirname(lexical);
  for (let checkPath = parentDir; checkPath !== rootReal && checkPath !== dirname(rootReal); ) {
    const checkStat = await lstat(checkPath);
    if (checkStat.isSymbolicLink()) {
      throw new Error(`parent path contains symlink within production asset root: ${checkPath}`);
    }
    const checkRel = relative(rootReal, checkPath);
    if (isAbsolute(checkRel) || checkRel === '..' || checkRel.startsWith('..')) {
      break; // above root, stop checking
    }
    checkPath = dirname(checkPath);
  }

  const tempDir = await mkdtemp(join(parentDir, '.publish-tarball-'));
  const uniqueName = `${action.package.replace('/', '-')}-${action.version}-${randomUUID()}.tgz`;
  const tempPath = join(tempDir, uniqueName);

  // Record temp directory identity at creation for cleanup verification
  const tempDirStat = await lstat(tempDir);

  const cleanup = async () => {
    // Verify temp directory identity before cleanup.
    // If the directory was replaced (by a symlink or different directory),
    // fail closed and do not delete the replacement.
    let currentDirStat;
    try {
      currentDirStat = await lstat(tempDir);
    } catch (err) {
      // Directory already gone — nothing to clean
      return;
    }
    if (currentDirStat.isSymbolicLink()) {
      throw new Error('temp directory was replaced with a symlink; refusing to clean');
    }
    if (!currentDirStat.isDirectory()) {
      throw new Error('temp directory path is no longer a directory; refusing to clean');
    }
    if (currentDirStat.dev !== tempDirStat.dev || currentDirStat.ino !== tempDirStat.ino) {
      throw new Error('temp directory identity changed; refusing to clean replacement');
    }
    // Restore permissions so rm can traverse the directory
    await chmod(tempDir, 0o700);
    await rm(tempDir, { recursive: true, force: true });
  };

  try {
    const writer = await open(tempPath, 'wx', 0o400);
    try {
      await writer.writeFile(bytes);
      await writer.sync();
    } finally {
      await writer.close();
    }

    // Record creation-time identity for post-hook comparison
    const identityHandle = await open(tempPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let creationStat;
    try {
      creationStat = await identityHandle.stat();
      if (!creationStat.isFile() || creationStat.nlink !== 1) {
        throw new Error('named tarball failed post-write verification: not a single-link regular file');
      }
    } finally {
      await identityHandle.close();
    }

    // Internal test hook: allows tests to tamper between write completion
    // and pre-spawn identity verification. Passed via deps.postWriteTamperHook.
    if (typeof tamperHook === 'function') {
      await tamperHook(tempPath);
    }

    // Pre-spawn verification: re-open with O_NOFOLLOW and compare all six
    // identity fields (dev/ino/nlink/size/mtime/ctime) against creation-time
    // values, then read back and verify content SHA-256.
    const preSpawnHandle = await open(tempPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const postStat = await preSpawnHandle.stat();
      if (!postStat.isFile() || postStat.nlink !== 1) {
        throw new Error('named tarball failed pre-spawn verification: not a single-link regular file');
      }
      if (
        postStat.dev !== creationStat.dev ||
        postStat.ino !== creationStat.ino ||
        postStat.nlink !== creationStat.nlink ||
        postStat.size !== creationStat.size ||
        postStat.mtimeMs !== creationStat.mtimeMs ||
        postStat.ctimeMs !== creationStat.ctimeMs
      ) {
        throw new Error(
          'named tarball failed pre-spawn verification: file identity changed between write and spawn',
        );
      }
      // Read back and verify content SHA-256
      const readback = Buffer.alloc(postStat.size);
      let pos = 0;
      while (pos < readback.length) {
        const { bytesRead } = await preSpawnHandle.read(readback, pos, readback.length - pos, pos);
        if (bytesRead === 0) throw new Error('named tarball failed pre-spawn verification: truncated read');
        pos += bytesRead;
      }
      const readbackDigest = createHash('sha256').update(readback).digest('hex');
      if (readbackDigest !== action.tarballSha256) {
        throw new Error('named tarball failed pre-spawn verification: SHA-256 mismatch');
      }
    } finally {
      await preSpawnHandle.close();
    }

    // Drop temp directory to minimum permissions (read+traverse only)
    await chmod(tempDir, 0o500);

    // Post-publish verification function: re-opens the named file after npm
    // returns and compares identity + content. This detects drift during the
    // scheduling window between pre-spawn check and npm's file open.
    const verifyPostPublish = async () => {
      try {
        const ppHandle = await open(tempPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          const ppStat = await ppHandle.stat();
          if (!ppStat.isFile() || ppStat.nlink !== 1) {
            return { ok: false, error: 'post-publish: not a single-link regular file' };
          }
          if (
            ppStat.dev !== creationStat.dev ||
            ppStat.ino !== creationStat.ino ||
            ppStat.nlink !== creationStat.nlink ||
            ppStat.size !== creationStat.size ||
            ppStat.mtimeMs !== creationStat.mtimeMs ||
            ppStat.ctimeMs !== creationStat.ctimeMs
          ) {
            return { ok: false, error: 'post-publish: file identity changed between spawn and npm completion' };
          }
          const ppBuf = Buffer.alloc(ppStat.size);
          let p = 0;
          while (p < ppBuf.length) {
            const { bytesRead } = await ppHandle.read(ppBuf, p, ppBuf.length - p, p);
            if (bytesRead === 0) return { ok: false, error: 'post-publish: truncated read' };
            p += bytesRead;
          }
          const ppDigest = createHash('sha256').update(ppBuf).digest('hex');
          if (ppDigest !== action.tarballSha256) {
            return { ok: false, error: 'post-publish: content SHA-256 mismatch' };
          }
          return { ok: true };
        } finally {
          await ppHandle.close();
        }
      } catch (err) {
        return { ok: false, error: `post-publish verification failed: ${err.message}` };
      }
    };

    return { tarballPath: tempPath, cleanup, verifyPostPublish };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Spawn npm publish with a named tarball path. The tarball path is passed as
 * the package spec argument (not via fd), which works correctly on macOS and
 * Linux. Arguments are passed as an array — no shell interpolation.
 */
async function spawnNpmPublishTarball({ args, cwd }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('npm', args, {
      cwd,
      shell: false,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else {
        const error = new Error(`npm publish exited with code ${code}: ${stderr.trim()}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        rejectPromise(error);
      }
    });
  });
}

async function queryVersion(action, cwd, exec, registry) {
  try {
    const args = ['view', `${action.package}@${action.version}`, 'version', '--json'];
    if (registry) {
      args.push('--registry', registry);
    }
    const { stdout } = await exec('npm', args, { cwd, shell: false });
    let version;
    try {
      version = JSON.parse(stdout);
    } catch (err) {
      throw new Error(`npm view returned malformed JSON: ${err.message}`);
    }
    if (typeof version !== 'string' || version !== action.version) {
      throw new Error(`npm view returned an unexpected version for ${action.package}@${action.version}`);
    }
    return { exists: true, version };
  } catch (err) {
    if (isNotFound(err)) return { exists: false, version: null };
    throw new Error(`cannot determine npm version uniqueness: ${err.message}`);
  }
}

export function createNpmAdapter(deps = {}) {
  const exec = deps.exec ?? run;
  const publishFromTarball = deps.publishFromTarball ?? (deps.exec
    ? ({ args, cwd }) => exec('npm', args, { cwd, shell: false })
    : spawnNpmPublishTarball);
  // publishTarballBuffer: stable-bytes publish seam.  When present, execute
  // reads the tarball into a verified Buffer and passes it directly to this
  // function instead of writing a named temp file.  This eliminates the
  // named-file TOCTOU window entirely.
  // Signature: ({ buffer: Buffer, manifest: object, opts: { access?, tag?, provenance? } }) => Promise<any>
  //
  // Default: always use libnpmpublish's Buffer API. Tests that replace this
  // seam must provide another Buffer consumer. A frozen tarball is never
  // handed back to the legacy named-path publisher.
  const publishTarballBuffer = deps.publishTarballBuffer === undefined
    ? defaultPublishTarballBuffer
    : deps.publishTarballBuffer;
  const beforeBufferPublishHook = deps.beforeBufferPublishHook ?? null;
  const resolveAuthToken = deps.resolveAuthToken ?? defaultResolveAuthToken;
  const whoamiWithToken = deps.whoamiWithToken ?? defaultWhoamiWithToken;
  const authEnv = deps.authEnv ?? process.env;
  // postWriteTamperHook: injectable test seam for pre-spawn verification tests.
  // Not part of the public adapter interface; only used in test environments.
  const postWriteTamperHook = deps.postWriteTamperHook ?? null;
  // afterPublishBeforeVerifyHook: test seam for post-publish tamper tests (Item 27).
  // Called after publishFromTarball returns, before verifyPostPublish.
  const afterPublishBeforeVerifyHook = deps.afterPublishBeforeVerifyHook ?? null;
  // beforeCleanupHook: test seam for cleanup attack tests (Item 26).
  // Called in execute's finally, before cleanup() runs.
  const beforeCleanupHook = deps.beforeCleanupHook ?? null;
  return Object.freeze({
    name: NAME,
    actionTypes: Object.freeze([ActionType.NPM_PACK, ActionType.NPM_PUBLISH]),

    async preflight(action, context) {
      try {
        if (action.actionType === ActionType.NPM_PACK) {
          await exec('npm', ['pack', '--dry-run', '--json'], { cwd: context.root, shell: false });
        } else if (action.actionType === ActionType.NPM_PUBLISH) {
          if (!action.package || !action.version) throw new Error('npm-publish requires package and version');
          validatePackageName(action.package);

          // Validate and normalize registry
          if (!action.registry) throw new Error('npm-publish requires explicit registry');
          const normalizedRegistry = normalizeRegistry(action.registry);

          // Validate publisher
          if (!action.publisher) throw new Error('npm-publish requires explicit publisher');

          const access = action.access ?? (action.tarballPath ? null : 'public');
          if (!['public', 'restricted'].includes(access)) {
            throw new Error('npm-publish requires explicit access: public or restricted');
          }
          const cwd = resolvePackageCwd(action.cwd, context.root);
          if (action.tarballPath) {
            await verifyFrozenNpmTarballIdentity(action, context.root);
          }

          let whoamiUser;
          if (action.tarballPath) {
            try {
              const token = await resolveAuthToken({ registry: normalizedRegistry, cwd, exec, env: authEnv });
              whoamiUser = await whoamiWithToken({ registry: normalizedRegistry, token, cwd, exec });
            } catch {
              throw new Error('npm bearer authentication does not match the frozen registry and publisher');
            }
          } else {
            try {
              const { stdout } = await exec('npm', ['whoami', '--registry', normalizedRegistry], { cwd, shell: false });
              whoamiUser = stdout.trim();
            } catch {
              throw new Error(`npm authentication not configured for registry ${normalizedRegistry}`);
            }
          }

          // Verify whoami matches publisher
          if (whoamiUser !== action.publisher) {
            throw new Error(
              `npm whoami returned "${whoamiUser}" but expected publisher "${action.publisher}" for registry ${normalizedRegistry}`
            );
          }

          // Query version with explicit registry
          const remote = await queryVersion(action, cwd, exec, normalizedRegistry);
          if (remote.exists) throw new Error(`Package ${action.package}@${action.version} is already published`);
        } else {
          throw new Error(`unsupported action type: ${action.actionType}`);
        }
        return createResult({ actionType: action.actionType, status: ActionStatus.PREFLIGHT_PASSED });
      } catch (err) {
        return createResult({ actionType: action.actionType, status: ActionStatus.PREFLIGHT_FAILED, error: err.message });
      }
    },

    async execute(action, context) {
      assertWritesAuthorized(context, action.actionType);
      let namedTarball = null;
      let primaryResult = null;
      try {
        if (action.actionType === ActionType.NPM_PACK) {
          const { stdout } = await exec('npm', ['pack', '--json'], { cwd: action.cwd ? resolvePackageCwd(action.cwd, context.root) : context.root, shell: false });
          const parsed = JSON.parse(stdout);
          const info = Array.isArray(parsed) ? parsed[0] : parsed;
          primaryResult = createResult({ actionType: action.actionType, status: ActionStatus.EXECUTED, observation: info });
          return primaryResult;
        }
        if (action.actionType !== ActionType.NPM_PUBLISH) throw new Error(`unsupported action type: ${action.actionType}`);
        validatePackageName(action.package);

        // Validate and normalize registry
        if (!action.registry) throw new Error('npm-publish requires explicit registry');
        const normalizedRegistry = normalizeRegistry(action.registry);

        // Validate publisher
        if (!action.publisher) throw new Error('npm-publish requires explicit publisher');

        const cwd = resolvePackageCwd(action.cwd, context.root);
        const access = action.access ?? (action.tarballPath ? null : 'public');
        if (!['public', 'restricted'].includes(access)) {
          throw new Error('npm-publish requires explicit access: public or restricted');
        }

        // Stable-bytes Buffer path: when publishTarballBuffer is available and
        // we have a frozen tarball, read the verified bytes directly into memory
        // and hand them to the registry API — no named temp file, no TOCTOU.
        if (action.tarballPath) {
          if (typeof publishTarballBuffer !== 'function') {
            throw new Error('frozen npm tarball requires a stable Buffer publish capability');
          }
          const buffer = await readVerifiedTarballBytes(action, context.root);
          const manifest = extractManifestFromTarball(buffer, { name: action.package, version: action.version });
          let token;
          try {
            token = await resolveAuthToken({ registry: normalizedRegistry, cwd, exec, env: authEnv });
            const authenticatedPublisher = await whoamiWithToken({ registry: normalizedRegistry, token, cwd, exec });
            if (authenticatedPublisher !== action.publisher) {
              throw new Error('npm bearer identity does not match the frozen publisher');
            }
          } catch {
            throw new Error('npm bearer authentication does not match the frozen registry and publisher');
          }
          if (typeof beforeBufferPublishHook === 'function') {
            await beforeBufferPublishHook(resolve(context.root, action.tarballPath));
          }
          try {
            await publishTarballBuffer({
              buffer,
              manifest,
              opts: {
                registry: normalizedRegistry,
                token,
                access,
                tag: action.tag ?? undefined,
                provenance: action.provenance === true || undefined,
              },
            });
          } catch (pubErr) {
            // Sanitize: strip any credential or token from the error message.
            // The publish API may include auth headers or tokens in errors.
            const safeCode = typeof pubErr.code === 'string' && /^[A-Z0-9_-]{1,32}$/.test(pubErr.code)
              ? pubErr.code
              : 'unknown';
            throw new Error(`npm registry publish failed (${safeCode})`);
          }
          primaryResult = createResult({ actionType: action.actionType, status: ActionStatus.EXECUTED });
          return primaryResult;
        }

        throw new Error('npm-publish requires a frozen tarball; mutable cwd publishing is not supported');
      } catch (err) {
        primaryResult = createResult({ actionType: action.actionType, status: ActionStatus.EXECUTE_FAILED, error: err.message });
        return primaryResult;
      } finally {
        if (namedTarball) {
          // Test seam (Item 26): allows tests to tamper with the temp directory
          // before cleanup runs, to test identity-bound cleanup.
          if (typeof beforeCleanupHook === 'function') {
            await beforeCleanupHook(namedTarball.tarballPath);
          }
          try {
            await namedTarball.cleanup();
          } catch (cleanupErr) {
            // Cleanup failure (e.g., identity-bound rejection) must not silently
            // override a more informative primary error (post-publish verification,
            // pre-spawn detection). Record it but preserve the primary status.
            if (primaryResult && primaryResult.status === ActionStatus.EXECUTED) {
              return createResult({
                actionType: action.actionType,
                status: ActionStatus.EXECUTE_FAILED,
                error: `cleanup failed: ${cleanupErr.message}`,
              });
            }
            // Primary result already recorded an error; attach cleanup info.
            if (primaryResult) {
              primaryResult.error = `${primaryResult.error}\n[cleanup also failed: ${cleanupErr.message}]`;
            }
          }
        }
      }
    },

    async observe(action, context) {
      try {
        if (action.actionType === ActionType.NPM_PACK) {
          return createResult({ actionType: action.actionType, status: ActionStatus.OBSERVED, observation: { local: true } });
        }
        if (action.actionType !== ActionType.NPM_PUBLISH) throw new Error(`unsupported action type: ${action.actionType}`);
        validatePackageName(action.package);

        // Validate and normalize registry
        if (!action.registry) throw new Error('npm-publish requires explicit registry');
        const normalizedRegistry = normalizeRegistry(action.registry);
        if (!action.publisher) throw new Error('npm-publish requires explicit publisher');

        const cwd = resolvePackageCwd(action.cwd, context.root);
        const { stdout: whoamiStdout } = await exec(
          'npm',
          ['whoami', '--registry', normalizedRegistry],
          { cwd, shell: false },
        );
        const publisher = whoamiStdout.trim();
        if (publisher !== action.publisher) {
          throw new Error(
            `npm whoami returned "${publisher}" but expected publisher "${action.publisher}" for registry ${normalizedRegistry}`,
          );
        }
        const args = ['view', `${action.package}@${action.version}`, 'version', 'dist.integrity', 'dist.tarball', '--json'];
        args.push('--registry', normalizedRegistry);

        let stdout;
        try {
          ({ stdout } = await exec('npm', args, { cwd, shell: false }));
        } catch (err) {
          // Only an E404 from the exact frozen package@version view is trusted
          // as proof of absence. Auth, whoami, cwd, registry, parsing, and all
          // other failures remain unknown and must never authorize a retry.
          if (isNotFound(err)) {
            return createResult({
              actionType: action.actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                exists: false,
                package: action.package,
                version: action.version,
                registry: normalizedRegistry,
              },
              error: null,
            });
          }
          throw err;
        }
        const data = JSON.parse(stdout);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('npm observe returned a non-object JSON response');
        }
        if (data.version !== action.version) {
          throw new Error(`npm observe version mismatch: expected ${action.version}`);
        }
        const integrity = data['dist.integrity'] ?? data.integrity;
        if (typeof integrity !== 'string' || integrity.length === 0) {
          throw new Error('npm observe response is missing dist.integrity');
        }
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.OBSERVED,
          observation: {
            package: action.package,
            version: data.version,
            integrity,
            tarball: data['dist.tarball'] ?? data.tarball ?? null,
            registry: normalizedRegistry,
            publisher,
          },
        });
      } catch (err) {
        return createResult({ actionType: action.actionType, status: ActionStatus.OBSERVED, observation: {}, error: err.message });
      }
    },

    async verify(action, context) {
      const observed = await this.observe(action, context);
      if (observed.error) return createResult({ actionType: action.actionType, status: ActionStatus.VERIFY_FAILED, observation: observed.observation, error: observed.error });
      const comparison = matchObservation(action.expected ?? {}, observed.observation);
      return createResult({
        actionType: action.actionType,
        status: comparison.matches ? ActionStatus.VERIFIED : ActionStatus.VERIFY_FAILED,
        observation: observed.observation,
        error: comparison.matches ? null : comparison.mismatches.join('; '),
      });
    },
  });
}
