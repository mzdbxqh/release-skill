import { createHash } from 'node:crypto';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdtemp, open, readFile, realpath, rm, unlink } from 'node:fs/promises';

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

async function run(command, args, options = {}) {
  return execFile(command, args, {
    shell: false,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
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

async function createDetachedVerifiedTarball(action, root) {
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

  const tempDir = await mkdtemp(join(dirname(lexical), '.publish-fd-'));
  const tempPath = join(tempDir, 'package.tgz');
  let detached;
  try {
    const writer = await open(tempPath, 'wx', 0o400);
    try {
      await writer.writeFile(bytes);
      await writer.sync();
    } finally {
      await writer.close();
    }
    detached = await open(tempPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    await unlink(tempPath);
    await rm(tempDir, { recursive: true, force: true });
    return detached;
  } catch (err) {
    await detached?.close().catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
    throw err;
  }
}

async function spawnNpmPublishFromHandle({ handle, args, cwd }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('npm', args, {
      cwd,
      shell: false,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe', handle.fd],
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

async function queryVersion(action, cwd, exec) {
  try {
    const { stdout } = await exec(
      'npm',
      ['view', `${action.package}@${action.version}`, 'version', '--json'],
      { cwd, shell: false },
    );
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
  const publishFromHandle = deps.publishFromHandle ?? (deps.exec
    ? ({ handle, args, cwd }) => exec('npm', args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe', handle.fd] })
    : spawnNpmPublishFromHandle);
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
          const access = action.access ?? (action.tarballPath ? null : 'public');
          if (!['public', 'restricted'].includes(access)) {
            throw new Error('npm-publish requires explicit access: public or restricted');
          }
          const cwd = resolvePackageCwd(action.cwd, context.root);
          if (action.tarballPath) await verifyTarball(action, context.root);
          await exec('npm', ['whoami'], { cwd, shell: false }).catch(() => {
            throw new Error('npm authentication not configured');
          });
          const remote = await queryVersion(action, cwd, exec);
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
      try {
        if (action.actionType === ActionType.NPM_PACK) {
          const { stdout } = await exec('npm', ['pack', '--json'], { cwd: action.cwd ? resolvePackageCwd(action.cwd, context.root) : context.root, shell: false });
          const parsed = JSON.parse(stdout);
          const info = Array.isArray(parsed) ? parsed[0] : parsed;
          return createResult({ actionType: action.actionType, status: ActionStatus.EXECUTED, observation: info });
        }
        if (action.actionType !== ActionType.NPM_PUBLISH) throw new Error(`unsupported action type: ${action.actionType}`);
        validatePackageName(action.package);
        const cwd = resolvePackageCwd(action.cwd, context.root);
        const detached = action.tarballPath ? await createDetachedVerifiedTarball(action, context.root) : null;
        const args = ['publish'];
        if (detached) args.push(process.platform === 'linux' ? '/proc/self/fd/3' : '/dev/fd/3');
        const access = action.access ?? (action.tarballPath ? null : 'public');
        if (!['public', 'restricted'].includes(access)) {
          throw new Error('npm-publish requires explicit access: public or restricted');
        }
        args.push('--access', access);
        if (action.provenance === true) args.push('--provenance');
        if (action.tag) args.push('--tag', action.tag);
        if (detached) {
          try {
            await publishFromHandle({ handle: detached, args, cwd });
          } finally {
            await detached.close();
          }
        } else {
          await exec('npm', args, { cwd, shell: false });
        }
        return createResult({ actionType: action.actionType, status: ActionStatus.EXECUTED });
      } catch (err) {
        return createResult({ actionType: action.actionType, status: ActionStatus.EXECUTE_FAILED, error: err.message });
      }
    },

    async observe(action, context) {
      try {
        if (action.actionType === ActionType.NPM_PACK) {
          return createResult({ actionType: action.actionType, status: ActionStatus.OBSERVED, observation: { local: true } });
        }
        if (action.actionType !== ActionType.NPM_PUBLISH) throw new Error(`unsupported action type: ${action.actionType}`);
        validatePackageName(action.package);
        const cwd = resolvePackageCwd(action.cwd, context.root);
        const { stdout } = await exec(
          'npm',
          ['view', `${action.package}@${action.version}`, 'version', 'dist.integrity', 'dist.tarball', '--json'],
          { cwd, shell: false },
        );
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
