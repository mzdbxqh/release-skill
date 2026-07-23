/**
 * Deterministic project verification gates.
 *
 * Gates are local checks only. They use spawn without a shell, receive a
 * minimal environment, and never participate in remote publication writes.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, cp, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { ReleaseError, GATE_FAILED } from './errors.mjs';
import { canonicalJson, sha256Hex } from './digest.mjs';
import { computeFrozenSnapshot } from '../snapshot/frozen.mjs';
import { resolveUnitScopedPath } from '../snapshot/public-path.mjs';

const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const PLATFORM_ENV = process.platform === 'win32'
  ? ['PATH', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']
  : ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR'];

function gateError(gate, message, details = {}) {
  return new ReleaseError(GATE_FAILED, `verification gate "${gate?.id ?? 'unknown'}" ${message}`, {
    gateId: gate?.id,
    ...details,
  });
}

function isInside(parent, candidate) {
  const rel = relative(parent, candidate);
  const separator = process.platform === 'win32' ? '\\' : '/';
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${separator}`));
}

function matchesSubset(actual, expected) {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    return actual === expected;
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => (
    Object.hasOwn(actual, key) && matchesSubset(actual[key], value)
  ));
}

function validateGate(gate) {
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
    throw gateError(gate, 'must be an object');
  }
  if (typeof gate.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(gate.id)) {
    throw gateError(gate, 'has an invalid id');
  }
  if (!['snapshot-verify', 'consumer-verify'].includes(gate.phase)) {
    throw gateError(gate, 'has an invalid phase');
  }
  if (!gate.scope || typeof gate.scope.unit !== 'string') {
    throw gateError(gate, 'must declare scope.unit');
  }
  if (gate.phase === 'consumer-verify' && !['npm', 'claude-plugin', 'codex-plugin', 'kimi-plugin'].includes(gate.scope.distribution)) {
    throw gateError(gate, 'consumer-verify must declare a supported scope.distribution');
  }
  if (!Array.isArray(gate.command) || gate.command.length === 0 || gate.command.some((value) => typeof value !== 'string')) {
    throw gateError(gate, 'command must be a non-empty string array');
  }
  if (gate.cwd !== undefined && typeof gate.cwd !== 'string') {
    throw gateError(gate, 'cwd must be a string');
  }
  if (!Number.isInteger(gate.timeoutMs) || gate.timeoutMs < 1 || gate.timeoutMs > 7_200_000) {
    throw gateError(gate, 'timeoutMs must be an integer between 1 and 7200000');
  }
  if (!Array.isArray(gate.envAllowlist) || gate.envAllowlist.some((key) => typeof key !== 'string' || !ENV_KEY_PATTERN.test(key))) {
    throw gateError(gate, 'envAllowlist must contain uppercase environment names');
  }
  if (gate.expectedJson !== undefined && (
    !gate.expectedJson || typeof gate.expectedJson !== 'object' || Array.isArray(gate.expectedJson)
  )) {
    throw gateError(gate, 'expectedJson must be an object');
  }
}

function filteredEnv(allowlist, suppliedEnv, fixedEnv = {}) {
  const result = {};
  for (const key of PLATFORM_ENV) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  for (const key of allowlist) {
    if (suppliedEnv?.[key] !== undefined) result[key] = String(suppliedEnv[key]);
  }
  for (const [key, value] of Object.entries(fixedEnv)) {
    if (value !== undefined) result[key] = String(value);
  }
  return result;
}

async function resolveSafeCwd(executionRoot, cwd, gate) {
  const rootStat = await lstat(executionRoot).catch((error) => {
    throw gateError(gate, 'execution root is missing', { cause: error.code });
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw gateError(gate, 'execution root must be a real directory');
  }
  const rootReal = await realpath(executionRoot);
  const lexical = resolve(rootReal, cwd ?? '.');
  if (!isInside(rootReal, lexical)) throw gateError(gate, 'cwd escapes the execution root');

  const rel = relative(rootReal, lexical);
  let current = rootReal;
  for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    const stat = await lstat(current).catch((error) => {
      throw gateError(gate, 'cwd does not exist', { cause: error.code });
    });
    if (stat.isSymbolicLink()) throw gateError(gate, 'cwd contains a symlink');
  }
  const physical = await realpath(lexical);
  if (!isInside(rootReal, physical)) throw gateError(gate, 'cwd resolves outside the execution root');
  return physical;
}

function outputSummary(value) {
  const text = value ?? '';
  return {
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

function executeGateProcess(executable, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const useProcessGroup = process.platform !== 'win32';
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: useProcessGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminationReason = null;
    let hardKillTimer = null;

    const signalTree = (signal) => {
      try {
        if (useProcessGroup && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // A process that already exited is handled by close below.
      }
    };
    const terminate = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      signalTree('SIGTERM');
      hardKillTimer = setTimeout(() => signalTree('SIGKILL'), 500);
      hardKillTimer.unref?.();
    };
    const append = (chunks, chunk, currentBytes) => {
      const remaining = Math.max(0, OUTPUT_LIMIT_BYTES - currentBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
    };
    child.stdout.on('data', (chunk) => {
      append(stdoutChunks, chunk, stdoutBytes);
      stdoutBytes += chunk.length;
      if (stdoutBytes > OUTPUT_LIMIT_BYTES) terminate('output-limit');
    });
    child.stderr.on('data', (chunk) => {
      append(stderrChunks, chunk, stderrBytes);
      stderrBytes += chunk.length;
      if (stderrBytes > OUTPUT_LIMIT_BYTES) terminate('output-limit');
    });
    const timeoutTimer = setTimeout(() => terminate('timeout'), options.timeoutMs);
    timeoutTimer.unref?.();
    child.on('error', (error) => {
      clearTimeout(timeoutTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      error.stdout = Buffer.concat(stdoutChunks).toString('utf8');
      error.stderr = Buffer.concat(stderrChunks).toString('utf8');
      error.failureKind = terminationReason ?? 'spawn-error';
      rejectPromise(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeoutTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      const result = {
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code,
        signal,
      };
      if (terminationReason || code !== 0) {
        const error = new Error(terminationReason ?? `process exited with code ${code}`);
        Object.assign(error, result, {
          failureKind: terminationReason ?? 'non-zero-exit',
          killed: Boolean(terminationReason),
        });
        rejectPromise(error);
      } else {
        resolvePromise(result);
      }
    });
  });
}

async function appendFailureEvidence({
  evidence,
  gate,
  gateDigest,
  inputDigest,
  startedAt,
  failureKind,
  exitCode,
  signal,
  stdout,
  stderr,
}) {
  const stdoutInfo = outputSummary(stdout);
  const stderrInfo = outputSummary(stderr);
  await evidence?.append({
    phase: gate.phase,
    status: 'failed',
    decision: 'fail-closed',
    gateId: gate.id,
    gateDigest,
    inputDigest,
    failureKind,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    signal: signal ?? null,
    stdoutBytes: stdoutInfo.bytes,
    stdoutSha256: stdoutInfo.sha256,
    stderrBytes: stderrInfo.bytes,
    stderrSha256: stderrInfo.sha256,
  });
}

/** Execute one frozen gate definition against an isolated execution root. */
export async function runVerificationGate({
  gate,
  executionRoot,
  evidence,
  env = {},
  fixedEnv = {},
  inputDigest: expectedInputDigest,
}) {
  validateGate(gate);
  const cwd = await resolveSafeCwd(executionRoot, gate.cwd, gate);
  const [executable, ...args] = gate.command;
  const gateDigest = sha256Hex(canonicalJson(gate));
  const observedInput = await computeFrozenSnapshot(executionRoot);
  if (expectedInputDigest && observedInput.digest !== expectedInputDigest) {
    throw gateError(gate, 'execution input changed before process start', {
      expectedInputDigest,
      observedInputDigest: observedInput.digest,
    });
  }
  const inputDigest = observedInput.digest;
  const startedAt = new Date().toISOString();
  await evidence?.append({
    phase: gate.phase,
    status: 'started',
    gateId: gate.id,
    gateDigest,
    inputDigest,
    unitId: gate.scope.unit,
    ...(gate.scope.distribution ? { distribution: gate.scope.distribution } : {}),
    executable,
    args,
    cwd: gate.cwd ?? '.',
    timeoutMs: gate.timeoutMs,
    envAllowlist: gate.envAllowlist,
  });

  let stdout = '';
  let stderr = '';
  try {
    const result = await executeGateProcess(executable, args, {
      cwd,
      env: filteredEnv(gate.envAllowlist, env, fixedEnv),
      timeoutMs: gate.timeoutMs,
    });
    stdout = result.stdout ?? '';
    stderr = result.stderr ?? '';
  } catch (error) {
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
    const failureKind = error.failureKind ?? 'non-zero-exit';
    await appendFailureEvidence({
      evidence,
      gate,
      gateDigest,
      inputDigest,
      startedAt,
      failureKind,
      exitCode: error.exitCode,
      signal: error.signal,
      stdout,
      stderr,
    });
    throw gateError(gate, `failed (${failureKind})`, { failureKind });
  }

  if (gate.expectedJson !== undefined) {
    let actual;
    try {
      actual = JSON.parse(stdout);
    } catch {
      await appendFailureEvidence({
        evidence, gate, gateDigest, inputDigest, startedAt, failureKind: 'invalid-json', exitCode: 0, signal: null, stdout, stderr,
      });
      throw gateError(gate, 'returned invalid JSON', { failureKind: 'invalid-json' });
    }
    if (!matchesSubset(actual, gate.expectedJson)) {
      await appendFailureEvidence({
        evidence, gate, gateDigest, inputDigest, startedAt, failureKind: 'json-mismatch', exitCode: 0, signal: null, stdout, stderr,
      });
      throw gateError(gate, 'JSON output does not match expectedJson', { failureKind: 'json-mismatch' });
    }
  }

  const stdoutInfo = outputSummary(stdout);
  const stderrInfo = outputSummary(stderr);
  const result = {
    id: gate.id,
    phase: gate.phase,
    unitId: gate.scope.unit,
    ...(gate.scope.distribution ? { distribution: gate.scope.distribution } : {}),
    gateDigest,
    inputDigest,
    status: 'passed',
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    stdoutBytes: stdoutInfo.bytes,
    stdoutSha256: stdoutInfo.sha256,
    stderrBytes: stderrInfo.bytes,
    stderrSha256: stderrInfo.sha256,
  };
  await evidence?.append({ ...result, phase: gate.phase, status: 'completed', gateId: gate.id });
  return result;
}

async function makeTreeWritable(root) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('gate copy root must be a real directory');
  await chmod(root, stat.mode | 0o700);
  for (const child of await readdir(root, { withFileTypes: true })) {
    const absolute = join(root, child.name);
    const childStat = await lstat(absolute);
    if (childStat.isSymbolicLink()) throw new Error('gate copy must not contain symlinks');
    if (childStat.isDirectory()) await makeTreeWritable(absolute);
    else if (childStat.isFile() && childStat.nlink === 1) await chmod(absolute, childStat.mode | 0o600);
    else throw new Error('gate copy must contain only single-link regular files');
  }
}

/** Run snapshot gates on disposable writable copies and recheck the authority. */
export async function runSnapshotVerificationGates({
  gates = [],
  unitResults,
  runDir,
  evidence,
  env = {},
  copySnapshot = cp,
}) {
  const snapshotGates = gates.filter((item) => item.phase === 'snapshot-verify');
  if (snapshotGates.length === 0) return [];
  const byUnit = new Map(unitResults.map((item) => [item.unit.id, item]));
  const gateRoot = join(runDir, 'snapshot-gates');
  await mkdir(gateRoot, { recursive: true });
  const results = [];

  for (const gate of snapshotGates) {
    validateGate(gate);
    const unitResult = byUnit.get(gate.scope.unit);
    if (!unitResult) throw gateError(gate, 'references an unknown release unit');
    const source = unitResult.manifest.outputDir;
    const before = await computeFrozenSnapshot(source);
    const copyDir = resolveUnitScopedPath(gateRoot, gate.id);
    try {
      await copySnapshot(source, copyDir, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
      const copied = await computeFrozenSnapshot(copyDir);
      if (copied.digest !== before.digest) {
        throw gateError(gate, 'copied execution input does not match the frozen snapshot authority', {
          authorityDigest: before.digest,
          copiedInputDigest: copied.digest,
        });
      }
      await makeTreeWritable(copyDir);
      const executionInput = await computeFrozenSnapshot(copyDir);
      if (executionInput.digest !== copied.digest) {
        throw gateError(gate, 'execution input changed while making the disposable copy writable', {
          copiedInputDigest: copied.digest,
          executionInputDigest: executionInput.digest,
        });
      }
      results.push(await runVerificationGate({
        gate,
        executionRoot: copyDir,
        evidence,
        env,
        fixedEnv: { HOME: copyDir },
        inputDigest: executionInput.digest,
      }));
      const after = await computeFrozenSnapshot(source);
      if (after.digest !== before.digest) {
        throw gateError(gate, 'changed the frozen snapshot authority', {
          beforeDigest: before.digest,
          afterDigest: after.digest,
        });
      }
    } finally {
      await rm(copyDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return results;
}

export function selectConsumerVerificationGates(plan, unitId, distribution) {
  return (plan.verificationGates ?? []).filter((gate) => (
    gate.phase === 'consumer-verify' &&
    gate.scope?.unit === unitId &&
    gate.scope?.distribution === distribution
  ));
}

/** Run all exact unit/distribution consumer gates from the frozen plan. */
export async function runConsumerVerificationGates({
  plan,
  unitId,
  distribution,
  executionRoot,
  evidence,
  env = {},
  fixedEnv = {},
}) {
  const results = [];
  for (const gate of selectConsumerVerificationGates(plan, unitId, distribution)) {
    results.push(await runVerificationGate({ gate, executionRoot, evidence, env, fixedEnv }));
  }
  return results;
}
