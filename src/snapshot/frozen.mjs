import { createHash } from 'node:crypto';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { ReleaseError, GATE_FAILED } from '../core/errors.mjs';

const execFile = promisify(execFileCb);

function frozenError(message, details = {}) {
  return new ReleaseError(GATE_FAILED, message, details);
}

function isInside(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

export async function resolveFrozenPath(root, relativePath, label = 'frozen path') {
  if (!relativePath || typeof relativePath !== 'string' || isAbsolute(relativePath)) {
    throw frozenError(`${label} must be a non-empty project-relative path`);
  }
  const rootReal = await realpath(root);
  const lexical = resolve(rootReal, relativePath);
  if (!isInside(rootReal, lexical)) {
    throw frozenError(`${label} escapes project root`, { relativePath });
  }
  const lexicalStat = await lstat(lexical).catch((err) => {
    throw frozenError(`${label} is missing`, { relativePath, cause: err.code });
  });
  if (lexicalStat.isSymbolicLink()) {
    throw frozenError(`${label} must not be a symlink`, { relativePath });
  }
  const physical = await realpath(lexical).catch((err) => {
    throw frozenError(`${label} is missing`, { relativePath, cause: err.code });
  });
  if (!isInside(rootReal, physical)) {
    throw frozenError(`${label} resolves outside project root`, { relativePath });
  }
  return physical;
}

async function readStableRegularFile(filePath, displayPath) {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw frozenError(`frozen snapshot entry is not a single-link regular file: ${displayPath}`);
  }

  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw frozenError(`frozen snapshot entry changed before read: ${displayPath}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 ||
      after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
    ) {
      throw frozenError(`frozen snapshot entry changed during read: ${displayPath}`);
    }
    return { bytes, mode: opened.mode };
  } finally {
    await handle.close();
  }
}

/**
 * Compute the canonical snapshot digest.
 *
 * `excludeRootEntries` is reserved for consumer-owned transport metadata
 * that is not part of the published payload (currently Codex's root `.git`
 * checkout metadata). Exclusions only apply to direct children of the root;
 * all payload paths retain the normal fail-closed file checks.
 */
export async function computeFrozenSnapshot(snapshotDir, { excludeRootEntries = [] } = {}) {
  const root = await realpath(snapshotDir);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw frozenError('frozen snapshot root must be a real directory');
  }

  const entries = [];
  const excluded = new Set(excludeRootEntries);
  async function walk(dir) {
    const children = await readdir(dir, { withFileTypes: true });
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (dir === root && excluded.has(child.name)) continue;
      const absolute = join(dir, child.name);
      const rel = relative(root, absolute).split('\\').join('/');
      const st = await lstat(absolute);
      if (st.isSymbolicLink()) {
        throw frozenError(`frozen snapshot contains symlink: ${rel}`);
      }
      if (st.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const { bytes, mode } = await readStableRegularFile(absolute, rel);
      entries.push({
        path: rel,
        type: 'file',
        mode,
        size: bytes.length,
        contentDigest: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  await walk(root);
  // Match buildPublicStaging's locale-independent, code-unit ordering so the
  // digest computed at copy time can be re-derived from disk byte-for-byte.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { digest, entries };
}

export async function verifyFrozenSnapshot({ root, snapshotPath, expectedDigest }) {
  const snapshotDir = await resolveFrozenPath(root, snapshotPath, 'frozen snapshot path');
  const observed = await computeFrozenSnapshot(snapshotDir);
  if (!expectedDigest || observed.digest !== expectedDigest) {
    throw frozenError('frozen snapshot digest mismatch', {
      expectedDigest,
      observedDigest: observed.digest,
    });
  }
  return { snapshotDir, ...observed };
}

export async function verifyFrozenFile({ root, filePath, expectedSha256, label = 'frozen file' }) {
  const physical = await resolveFrozenPath(root, filePath, label);
  const { bytes } = await readStableRegularFile(physical, filePath);
  const observedSha256 = createHash('sha256').update(bytes).digest('hex');
  if (!expectedSha256 || observedSha256 !== expectedSha256) {
    throw frozenError(`${label} SHA-256 mismatch`, { expectedSha256, observedSha256 });
  }
  return { physical, observedSha256, size: bytes.length };
}

export async function verifyFrozenDirectoryStructure(directory, label = 'frozen directory') {
  async function walk(current) {
    const children = await readdir(current, { withFileTypes: true });
    for (const child of children) {
      const absolute = join(current, child.name);
      const st = await lstat(absolute);
      if (st.isSymbolicLink()) {
        throw frozenError(`${label} contains a symlink`);
      }
      if (st.isDirectory()) {
        await walk(absolute);
      } else if (!st.isFile() || st.nlink !== 1) {
        throw frozenError(`${label} contains an unsafe non-regular or hardlinked entry`);
      }
    }
  }
  await walk(directory);
}

export async function verifyFrozenGitRepository({ root, gitObjectDir, commit, tree, exec = execFile }) {
  const gitDir = await resolveFrozenPath(root, gitObjectDir, 'frozen git object directory');
  await verifyFrozenDirectoryStructure(gitDir, 'frozen git object directory');
  const { stdout } = await exec('git', ['--git-dir', gitDir, 'rev-parse', `${commit}^{tree}`], { shell: false });
  if (stdout.trim() !== tree) {
    throw frozenError('frozen git object tree mismatch', { commit, expectedTree: tree, observedTree: stdout.trim() });
  }
  return { gitDir, commit, tree };
}

async function verifyGitTreeContent({ snapshotDir, repositoryDir, commit, expectedSnapshotDigest, exec }) {
  const snapshot = await computeFrozenSnapshot(snapshotDir);
  if (snapshot.digest !== expectedSnapshotDigest) {
    throw frozenError('frozen snapshot changed while deriving Git objects', {
      expectedDigest: expectedSnapshotDigest,
      observedDigest: snapshot.digest,
    });
  }
  const { stdout: treeOut } = await exec(
    'git',
    ['--git-dir', repositoryDir, 'ls-tree', '-rz', commit],
    { shell: false, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  const treeEntries = Buffer.from(treeOut).toString('utf8').split('\0').filter(Boolean).map((record) => {
    const separator = record.indexOf('\t');
    const [mode, type] = record.slice(0, separator).split(' ');
    return { path: record.slice(separator + 1), mode, type };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const names = treeEntries.map((entry) => entry.path);
  const expectedNames = snapshot.entries.map((entry) => entry.path);
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw frozenError('frozen Git tree paths do not match the sealed public snapshot');
  }
  for (const [index, entry] of snapshot.entries.entries()) {
    const gitEntry = treeEntries[index];
    const expectedMode = entry.mode & 0o111 ? '100755' : '100644';
    if (gitEntry.type !== 'blob' || gitEntry.mode !== expectedMode) {
      throw frozenError(`frozen Git tree mode does not match the sealed public snapshot: ${entry.path}`, {
        expectedMode,
        observedMode: gitEntry.mode,
        observedType: gitEntry.type,
      });
    }
    const { stdout } = await exec(
      'git',
      ['--git-dir', repositoryDir, 'show', `${commit}:${entry.path}`],
      { shell: false, encoding: 'buffer', maxBuffer: Math.max(64 * 1024 * 1024, entry.size + 1024) },
    );
    const digest = createHash('sha256').update(Buffer.from(stdout)).digest('hex');
    if (digest !== entry.contentDigest) {
      throw frozenError(`frozen Git tree bytes do not match the sealed public snapshot: ${entry.path}`);
    }
  }
}

export async function buildFrozenGitRepository({ snapshotDir, repositoryDir, version, expectedSnapshotDigest, exec = execFile }) {
  if (!expectedSnapshotDigest) throw frozenError('Git object build requires the sealed snapshot digest');
  await mkdir(repositoryDir, { recursive: true });
  await exec('git', ['init', '--bare', repositoryDir], { shell: false });
  const indexPath = join(repositoryDir, 'release-index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  await exec('git', [
    '--git-dir', repositoryDir,
    '--work-tree', snapshotDir,
    'add', '--all', '--force', '--', '.',
  ], { cwd: snapshotDir, env, shell: false });
  const { stdout: treeOut } = await exec('git', ['--git-dir', repositoryDir, 'write-tree'], {
    env,
    shell: false,
  });
  const tree = treeOut.trim();
  const commitEnv = {
    ...env,
    GIT_AUTHOR_NAME: 'release-skill',
    GIT_AUTHOR_EMAIL: 'release-skill@localhost',
    GIT_COMMITTER_NAME: 'release-skill',
    GIT_COMMITTER_EMAIL: 'release-skill@localhost',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  const { stdout: commitOut } = await exec(
    'git',
    ['--git-dir', repositoryDir, 'commit-tree', tree, '-m', `Release ${version}`],
    { env: commitEnv, shell: false },
  );
  const commit = commitOut.trim();
  await verifyGitTreeContent({ snapshotDir, repositoryDir, commit, expectedSnapshotDigest, exec });
  return { tree, commit };
}

function contentEntries(entries) {
  return entries.map(({ path, size, contentDigest }) => ({ path, size, contentDigest }));
}

async function createDetachedReadHandle(bytes, directory) {
  const tempDir = await mkdtemp(join(directory, '.tar-fd-'));
  const tempPath = join(tempDir, 'package.tgz');
  let handle;
  try {
    const writer = await open(tempPath, 'wx', 0o400);
    try {
      await writer.writeFile(bytes);
      await writer.sync();
    } finally {
      await writer.close();
    }
    handle = await open(tempPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    await unlink(tempPath);
    await rm(tempDir, { recursive: true, force: true });
    return handle;
  } catch (err) {
    await handle?.close().catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
    throw err;
  }
}

async function runTarFromHandle(handle, args) {
  const fdPath = process.platform === 'linux' ? '/proc/self/fd/3' : '/dev/fd/3';
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('tar', args(fdPath), {
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
      else rejectPromise(new Error(`tar exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function verifyNpmTarballContent({ snapshotDir, tarballBytes, tarballDir, expectedSnapshotDigest }) {
  const listHandle = await createDetachedReadHandle(tarballBytes, tarballDir);
  let listOut;
  try {
    ({ stdout: listOut } = await runTarFromHandle(listHandle, (fdPath) => ['-tzf', fdPath]));
  } finally {
    await listHandle.close();
  }
  const listed = listOut.split(/\r?\n/).filter(Boolean);
  if (listed.length === 0 || listed.some((entry) => (
    !entry.startsWith('package/') || entry.startsWith('/') || entry.includes('\\') ||
    entry.split('/').some((segment) => segment === '..')
  ))) {
    throw frozenError('npm tarball contains an unsafe or unexpected path');
  }

  const verifyDir = await mkdtemp(join(tarballDir, '.verify-'));
  try {
    const extractHandle = await createDetachedReadHandle(tarballBytes, tarballDir);
    try {
      await runTarFromHandle(extractHandle, (fdPath) => ['-xzf', fdPath, '-C', verifyDir]);
    } finally {
      await extractHandle.close();
    }
    const original = await computeFrozenSnapshot(snapshotDir);
    if (original.digest !== expectedSnapshotDigest) {
      throw frozenError('frozen snapshot changed while deriving npm tarball', {
        expectedDigest: expectedSnapshotDigest,
        observedDigest: original.digest,
      });
    }
    const packed = await computeFrozenSnapshot(join(verifyDir, 'package'));
    if (JSON.stringify(contentEntries(packed.entries)) !== JSON.stringify(contentEntries(original.entries))) {
      throw frozenError('npm tarball bytes do not match the sealed public snapshot');
    }
  } finally {
    await rm(verifyDir, { recursive: true, force: true });
  }
}

export async function buildFrozenNpmTarball({ snapshotDir, tarballDir, expectedSnapshotDigest, exec = execFile }) {
  await mkdir(tarballDir, { recursive: true });
  const { stdout } = await exec(
    'npm',
    ['pack', snapshotDir, '--pack-destination', tarballDir, '--json', '--ignore-scripts'],
    { shell: false, encoding: 'utf8', timeout: 120_000 },
  );
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw frozenError('npm pack returned invalid JSON');
  }
  const info = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!info?.filename || !info?.integrity) {
    throw frozenError('npm pack did not return filename and integrity');
  }
  const tarballPath = join(tarballDir, info.filename);
  const { bytes } = await readStableRegularFile(tarballPath, info.filename);
  if (!expectedSnapshotDigest) throw frozenError('npm tarball build requires the sealed snapshot digest');
  await verifyNpmTarballContent({
    snapshotDir,
    tarballBytes: bytes,
    tarballDir,
    expectedSnapshotDigest,
  });
  return {
    tarballPath,
    integrity: info.integrity,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

export async function sealFrozenSnapshot(snapshotDir) {
  async function walk(dir) {
    const children = await readdir(dir, { withFileTypes: true });
    for (const child of children) {
      const absolute = join(dir, child.name);
      const st = await lstat(absolute);
      if (st.isDirectory()) {
        await walk(absolute);
        await chmod(absolute, 0o555);
      } else if (st.isFile()) {
        await chmod(absolute, st.mode & 0o111 ? 0o555 : 0o444);
      }
    }
  }
  await walk(snapshotDir);
  await chmod(snapshotDir, 0o555);
}
