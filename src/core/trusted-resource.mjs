/**
 * Read package-owned runtime resources without following untrusted links.
 * Installed adapters use this for schemas and native manifests.
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { CONFIG_INVALID, ReleaseError } from './errors.mjs';
import { PKG_ROOT } from './pkg-root.mjs';

function fail(code, resource, reason) {
  throw new ReleaseError(
    code,
    `package resource is untrusted or unavailable: ${resource}`,
    { resource, reason },
  );
}

function lexicalPath(resource, code) {
  if (typeof resource !== 'string' || resource.length === 0 || isAbsolute(resource)) {
    fail(code, String(resource), 'INVALID_RESOURCE_PATH');
  }
  const path = resolve(PKG_ROOT, resource);
  const rel = relative(PKG_ROOT, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(code, resource, 'RESOURCE_PATH_ESCAPE');
  }
  return path;
}

function assertStat(stat, resource, code) {
  if (stat.isSymbolicLink()) fail(code, resource, 'SYMLINK');
  if (!stat.isFile()) fail(code, resource, 'NOT_REGULAR_FILE');
  if (stat.nlink !== 1) fail(code, resource, 'UNEXPECTED_HARDLINK_COUNT');
}

function assertPhysicalContainment(physicalRoot, physicalPath, resource, code) {
  const rel = relative(physicalRoot, physicalPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(code, resource, 'PHYSICAL_PATH_ESCAPE');
  }
}

export function readTrustedPackageResourceSync(resource, { code = CONFIG_INVALID } = {}) {
  const path = lexicalPath(resource, code);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(code, resource, 'MISSING');
  }
  assertStat(stat, resource, code);

  let physicalRoot;
  let physicalPath;
  try {
    physicalRoot = realpathSync(PKG_ROOT);
    physicalPath = realpathSync(path);
  } catch {
    fail(code, resource, 'REALPATH_FAILED');
  }
  assertPhysicalContainment(physicalRoot, physicalPath, resource, code);
  try {
    return readFileSync(physicalPath);
  } catch {
    fail(code, resource, 'READ_FAILED');
  }
}

export async function readTrustedPackageResource(resource, { code = CONFIG_INVALID } = {}) {
  const path = lexicalPath(resource, code);
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    fail(code, resource, 'MISSING');
  }
  assertStat(stat, resource, code);

  let physicalRoot;
  let physicalPath;
  try {
    physicalRoot = await realpath(PKG_ROOT);
    physicalPath = await realpath(path);
  } catch {
    fail(code, resource, 'REALPATH_FAILED');
  }
  assertPhysicalContainment(physicalRoot, physicalPath, resource, code);
  try {
    return await readFile(physicalPath);
  } catch {
    fail(code, resource, 'READ_FAILED');
  }
}
