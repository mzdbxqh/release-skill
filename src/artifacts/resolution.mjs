/**
 * Safe conflict materialization and resolution submit with new plan derivation.
 *
 * @module artifacts/resolution
 */

import { mkdir, open, readFile, stat, lstat, chmod } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';

import {
  ReleaseError,
  PLAN_STALE,
  SENSITIVE_CONFLICT,
  MISSING_PARAMETERS,
  PATH_UNSAFE,
  FORBIDDEN_CONTENT_DETECTED,
} from '../core/errors.mjs';
import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import { inspectArtifacts } from './inspect.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024; // 2 MiB

// ---------------------------------------------------------------------------
// Buffer decode — handles both Buffer and JSON-roundtrip {type:'Buffer',data}
// ---------------------------------------------------------------------------

/**
 * Decode a value that may be a native Buffer or a JSON-roundtrip
 * {type:'Buffer',data:[...]} object into a proper Buffer.
 * Fails closed on illegal shapes.
 *
 * @param {*} value
 * @param {string} label - For error messages.
 * @returns {Buffer|null} Decoded buffer, or null if value is nullish.
 * @throws {ReleaseError} MISSING_PARAMETERS if shape is illegal.
 */
function decodeBuffer(value, label) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
    if (!value.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        `illegal conflict ${label} byte array`,
        { label },
      );
    }
    return Buffer.from(value.data);
  }
  throw new ReleaseError(
    MISSING_PARAMETERS,
    `illegal conflict ${label} shape: expected Buffer or {type:'Buffer',data:[...]}`,
    { label, received: typeof value },
  );
}

/**
 * Decode and validate conflict buffers: fatal UTF-8, no NUL/control chars.
 *
 * @param {object} conflict
 * @returns {{ base: Buffer|null, current: Buffer|null, generated: Buffer|null }}
 */
function decodeAndValidateConflictBuffers(conflict) {
  const base = decodeBuffer(conflict.base, 'base');
  const current = decodeBuffer(conflict.current, 'current');
  const generated = decodeBuffer(conflict.generated, 'generated');

  for (const [label, buf] of [['base', base], ['current', current], ['generated', generated]]) {
    if (!buf) continue;
    assertSafeContent(buf, label);
  }

  return { base, current, generated };
}

/**
 * Assert content is safe: valid UTF-8, no NUL, no control characters (except
 * TAB/LF/CR), and within size limit.
 */
function assertSafeContent(bytes, label) {
  // Size check
  if (bytes.length > MAX_TEMPLATE_BYTES) {
    throw new ReleaseError(
      FORBIDDEN_CONTENT_DETECTED,
      `conflict ${label} exceeds size limit (${bytes.length} > ${MAX_TEMPLATE_BYTES})`,
      { label, size: bytes.length, limit: MAX_TEMPLATE_BYTES },
    );
  }

  // Fatal UTF-8 check
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReleaseError(
      FORBIDDEN_CONTENT_DETECTED,
      `conflict ${label} is not valid UTF-8`,
      { label },
    );
  }

  // NUL and control character scan
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0) {
      throw new ReleaseError(
        FORBIDDEN_CONTENT_DETECTED,
        `conflict ${label} contains NUL byte at offset ${i}`,
        { label, offset: i },
      );
    }
    // Allow TAB (0x09), LF (0x0A), CR (0x0D); reject other control chars
    if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) {
      throw new ReleaseError(
        FORBIDDEN_CONTENT_DETECTED,
        `conflict ${label} contains control character 0x${code.toString(16)} at offset ${i}`,
        { label, offset: i, charCode: code },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Sensitive content detection
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS = Object.freeze([
  /api[_-]?key\s*[=:]\s*["']?[A-Za-z0-9+/=_-]{16,}/i,
  /secret[_-]?key\s*[=:]\s*["']?[A-Za-z0-9+/=_-]{16,}/i,
  /password\s*[=:]\s*["']?[^\s"']{8,}/i,
  /token\s*[=:]\s*["']?[A-Za-z0-9+/=_-]{16,}/i,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{36}/,
]);

function containsSensitivePattern(bytes) {
  if (!bytes || bytes.length === 0) return false;
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return false; }
  return SENSITIVE_PATTERNS.some((p) => p.test(content));
}

function checkSensitiveConflict(artifact, decodedBuffers) {
  const buffers = [decodedBuffers.base, decodedBuffers.current, decodedBuffers.generated].filter(Boolean);
  for (const buf of buffers) {
    if (containsSensitivePattern(buf)) {
      return { sensitive: true, reason: 'conflict body contains sensitive data pattern' };
    }
  }
  return { sensitive: false };
}

function isValidSensitiveAuthorization(auth) {
  if (!auth || typeof auth !== 'object') return false;
  return typeof auth.actor === 'string' && auth.actor.trim().length > 0
    && typeof auth.reason === 'string' && auth.reason.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function assertSafeArtifactId(id) {
  if (!id || typeof id !== 'string') {
    throw new ReleaseError(PATH_UNSAFE, 'artifactId must be a non-empty string', { artifactId: id });
  }
  if (id.includes('/') || id.includes('\\') || id === '.' || id === '..'
    || id.includes('..') || id.includes('\0')) {
    throw new ReleaseError(PATH_UNSAFE, `artifactId contains unsafe path characters: "${id}"`, { artifactId: id });
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new ReleaseError(PATH_UNSAFE, `artifactId must be alphanumeric/dash/underscore/dot: "${id}"`, { artifactId: id });
  }
}

/**
 * Assert no symlinks at any directory level from root to resolvedPath.
 * Checks: .release-skill, resolution, artifactId dir, and the file itself.
 */
async function assertNoSymlinksInPath(root, artifactId) {
  const levels = [
    join(root, '.release-skill'),
    join(root, '.release-skill', 'resolution'),
    join(root, '.release-skill', 'resolution', artifactId),
  ];

  for (const dir of levels) {
    try {
      const st = await lstat(dir);
      if (st.isSymbolicLink()) {
        throw new ReleaseError(PATH_UNSAFE, `directory is a symlink: ${dir}`, { path: dir });
      }
    } catch (err) {
      if (err.code === 'ENOENT') continue; // doesn't exist yet, ok
      if (err instanceof ReleaseError) throw err;
      throw err;
    }
  }
}

async function assertSafeResolvedPath(root, artifactId, resolvedPath) {
  const resolutionDir = resolve(root, '.release-skill', 'resolution', artifactId);
  const resolved = resolve(resolvedPath);

  await assertNoSymlinksInPath(root, artifactId);

  const rel = relative(resolutionDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ReleaseError(
      PATH_UNSAFE,
      `resolvedPath must be inside resolution directory ${resolutionDir}`,
      { resolvedPath, resolutionDir },
    );
  }

  // Exact filename check: must be <artifactId>.resolved
  const filename = basename(resolvedPath);
  if (filename !== `${artifactId}.resolved`) {
    throw new ReleaseError(
      PATH_UNSAFE,
      `resolvedPath must be named "${artifactId}.resolved", got "${filename}"`,
      { resolvedPath, expected: `${artifactId}.resolved`, actual: filename },
    );
  }
  if (resolved !== resolve(resolutionDir, `${artifactId}.resolved`)) {
    throw new ReleaseError(
      PATH_UNSAFE,
      'resolvedPath must be the exact materialized resolution file',
      { resolvedPath },
    );
  }

  let st;
  try {
    st = await lstat(resolvedPath);
  } catch (err) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      `cannot stat resolved file: ${err.message}`,
      { resolvedPath, cause: err.code },
    );
  }
  if (st.isSymbolicLink()) {
    throw new ReleaseError(PATH_UNSAFE, 'resolvedPath must not be a symlink', { resolvedPath });
  }
  if (!st.isFile()) {
    throw new ReleaseError(PATH_UNSAFE, 'resolvedPath must be a regular file', { resolvedPath });
  }

  // Permission check: must be 0600 (owner read-write only)
  const perms = st.mode & 0o777;
  if (perms !== 0o600) {
    throw new ReleaseError(
      PATH_UNSAFE,
      `resolvedPath must have 0600 permissions, got ${(perms).toString(8)}`,
      { resolvedPath, permissions: perms },
    );
  }
}

// ---------------------------------------------------------------------------
// Conflict content formatting
// ---------------------------------------------------------------------------

function buildConflictTemplate(conflict, decodedBuffers) {
  const base = decodedBuffers.base ? decodedBuffers.base.toString('utf8') : '';
  const current = decodedBuffers.current ? decodedBuffers.current.toString('utf8') : '';
  const generated = decodedBuffers.generated ? decodedBuffers.generated.toString('utf8') : '';

  const lines = [
    '<<<<<<< CURRENT (human)',
    current,
    '||||||| BASE',
    base,
    '=======',
    generated,
    '>>>>>>> GENERATED (producer)',
  ];

  const template = Buffer.from(lines.join('\n'), 'utf8');

  // Size check on the assembled template
  if (template.length > MAX_TEMPLATE_BYTES) {
    throw new ReleaseError(
      FORBIDDEN_CONTENT_DETECTED,
      `assembled conflict template exceeds size limit (${template.length} > ${MAX_TEMPLATE_BYTES})`,
      { size: template.length, limit: MAX_TEMPLATE_BYTES },
    );
  }

  return template;
}

// ---------------------------------------------------------------------------
// Optimistic plan capture (injectable)
// ---------------------------------------------------------------------------

export async function withOptimisticPlanCapture(root, plan, expectedPlanDigest, fn, options = {}) {
  const capture = options.captureBindings ?? defaultCaptureBindings;

  const beforeCapture = await capture(root, plan);
  const beforeBindings = canonicalJson(beforeCapture.bindings ?? {});

  const planContentDigest = computePlanContentDigest(plan);
  const expectedWithoutPrefix = expectedPlanDigest.startsWith('sha256:')
    ? expectedPlanDigest.slice(7)
    : expectedPlanDigest;
  if (planContentDigest !== expectedWithoutPrefix) {
    throw new ReleaseError(
      PLAN_STALE,
      'plan content changed since this plan digest was issued',
      { expectedPlanDigest, recomputedDigest: `sha256:${planContentDigest}` },
    );
  }

  const planBindings = canonicalJson(plan.bindings ?? {});
  if (beforeBindings !== planBindings) {
    throw new ReleaseError(
      PLAN_STALE,
      'captured bindings differ from plan bindings — plan is stale',
      { expectedPlanDigest },
    );
  }

  const result = await fn();

  const afterCapture = await capture(root, plan);
  const afterBindings = canonicalJson(afterCapture.bindings ?? {});
  if (beforeBindings !== afterBindings) {
    throw new ReleaseError(
      PLAN_STALE,
      'plan bindings changed during resolution operation',
      { expectedPlanDigest },
    );
  }

  return result;
}

/**
 * Default capture: calls inspectArtifacts({root, mode:'inspect'}) to re-read
 * real bindings from the repository. Does NOT fall back to plan's own bindings.
 * If inspect fails (no policy, no git, etc.), the error propagates — this is
 * intentional: the caller must provide a real repository root or inject a
 * stable capture function for unit tests.
 */
async function defaultCaptureBindings(root, _plan) {
  const result = await inspectArtifacts({ root, mode: 'inspect' });
  return { bindings: result.plan.bindings };
}

// ---------------------------------------------------------------------------
// Plan digest computation (generic — strips only planDigest)
// ---------------------------------------------------------------------------

function computePlanContentDigest(plan) {
  const { planDigest: _stripped, ...rest } = plan;
  const plain = {};
  for (const [k, v] of Object.entries(rest)) {
    plain[k] = v;
  }
  return sha256Hex(canonicalJson(plain));
}

function computeResolutionDigest(plan) {
  const { planDigest: _stripped, ...rest } = plan;
  const plain = {};
  for (const [k, v] of Object.entries(rest)) {
    plain[k] = v;
  }
  return `sha256:${sha256Hex(canonicalJson(plain))}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function materializeResolution({
  root,
  plan,
  planDigest,
  artifactId,
  sensitiveAuthorization,
} = {}) {
  // --- Validate plan digest ---
  const recomputed = computePlanContentDigest(plan);
  const expectedHex = planDigest.startsWith('sha256:') ? planDigest.slice(7) : planDigest;
  if (recomputed !== expectedHex) {
    throw new ReleaseError(
      PLAN_STALE,
      'plan digest does not match expected --plan-digest',
      { expected: planDigest, recomputed: `sha256:${recomputed}` },
    );
  }

  // --- Safe artifactId ---
  assertSafeArtifactId(artifactId);

  // --- Locate artifact ---
  const artifact = (plan.artifacts ?? []).find((a) => a.id === artifactId);
  if (!artifact) {
    throw new ReleaseError(MISSING_PARAMETERS, `artifact "${artifactId}" not found in plan`, { artifactId });
  }
  if (artifact.status !== 'CONFLICT' && !artifact.conflict) {
    throw new ReleaseError(MISSING_PARAMETERS, `artifact "${artifactId}" is not in CONFLICT status`, { artifactId, status: artifact.status });
  }

  // --- Decode conflict buffers (handles Buffer + JSON roundtrip shape) ---
  const decodedBuffers = decodeAndValidateConflictBuffers(artifact.conflict ?? {});

  // --- Sensitive scan on decoded buffers ---
  const { sensitive, reason } = checkSensitiveConflict(artifact, decodedBuffers);
  if (sensitive && !isValidSensitiveAuthorization(sensitiveAuthorization)) {
    throw new ReleaseError(
      SENSITIVE_CONFLICT,
      `conflict for artifact "${artifactId}" contains sensitive data: ${reason}. ` +
      'Provide sensitiveAuthorization with non-empty actor and reason to override.',
      { artifactId, reason },
    );
  }

  // --- Build conflict template from decoded buffers ---
  const template = buildConflictTemplate(artifact.conflict ?? {}, decodedBuffers);
  const templateDigest = sha256Hex(template);

  // --- Symlink check at all directory levels BEFORE creating anything ---
  await assertNoSymlinksInPath(root, artifactId);

  // --- Create resolution directory with restricted permissions ---
  const resolutionDir = join(root, '.release-skill', 'resolution', artifactId);
  await mkdir(resolutionDir, { recursive: true, mode: 0o700 });

  // Re-assert permissions on existing directory
  const dirStat = await stat(resolutionDir);
  if ((dirStat.mode & 0o777) !== 0o700) {
    await chmod(resolutionDir, 0o700);
  }

  // --- Write resolved file with exclusive open + restricted permissions ---
  const resolvedPath = join(resolutionDir, `${artifactId}.resolved`);
  const fh = await open(resolvedPath, 'wx', 0o600);
  try {
    await fh.write(template, 0, template.length);
    await fh.sync();
  } finally {
    await fh.close();
  }

  return Object.freeze({
    directory: resolutionDir,
    resolvedPath,
    metadata: Object.freeze({
      artifactId,
      templateDigest,
      baseDigest: artifact.conflict?.baseDigest ?? null,
      currentDigest: artifact.conflict?.currentDigest ?? null,
      generatedDigest: artifact.conflict?.generatedDigest ?? null,
    }),
  });
}

export async function submitResolution({
  root,
  plan,
  planDigest,
  artifactId,
  resolvedPath,
  discardedHunkDigests = [],
  captureOptions,
} = {}) {
  assertSafeArtifactId(artifactId);
  await assertSafeResolvedPath(root, artifactId, resolvedPath);

  return withOptimisticPlanCapture(root, plan, planDigest, async () => {
    const resolvedContent = await readAndValidateResolvedFile(resolvedPath);
    assertConflictPointsResolved(plan, artifactId, resolvedContent);
    validateDiscardedHunks(plan, artifactId, discardedHunkDigests);
    verifyHumanHunksPreserved(plan, artifactId, resolvedContent, discardedHunkDigests);
    return deriveResolvedPlan(plan, artifactId, planDigest, resolvedPath, resolvedContent, discardedHunkDigests);
  }, captureOptions);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function readAndValidateResolvedFile(resolvedPath) {
  let content;
  try {
    content = await readFile(resolvedPath);
  } catch (err) {
    throw new ReleaseError(MISSING_PARAMETERS, `cannot read resolved file: ${err.message}`, { resolvedPath, cause: err.code });
  }

  assertSafeContent(content, 'resolved');

  const text = content.toString('utf8');
  if (text.includes('<<<<<<<') || text.includes('>>>>>>>') || text.includes('=======')) {
    throw new ReleaseError(MISSING_PARAMETERS, 'resolved file still contains conflict markers — resolve before submitting', { resolvedPath });
  }

  return content;
}

function assertConflictPointsResolved(plan, artifactId, resolvedContent) {
  const artifact = (plan.artifacts ?? []).find((a) => a.id === artifactId);
  if (!artifact || !artifact.conflict) return;
  if (resolvedContent.length === 0) {
    throw new ReleaseError(MISSING_PARAMETERS, `resolved file for artifact "${artifactId}" is empty but conflict existed`, { artifactId });
  }
}

/**
 * Validate discardedHunkDigests: must exist in plan (even if protectedHunks is
 * empty → always reject) and be unique.
 */
function validateDiscardedHunks(plan, artifactId, discardedHunkDigests) {
  if (discardedHunkDigests.length === 0) return;

  const artifact = (plan.artifacts ?? []).find((a) => a.id === artifactId);
  const knownDigests = new Set(
    (artifact?.protectedHunks ?? []).map((h) => h.hunkDigest),
  );

  const seen = new Set();
  for (const digest of discardedHunkDigests) {
    if (seen.has(digest)) {
      throw new ReleaseError(MISSING_PARAMETERS, `duplicate discarded hunk digest: "${digest}"`, { artifactId, hunkDigest: digest });
    }
    seen.add(digest);

    // Always reject if not found — even when knownDigests is empty
    if (!knownDigests.has(digest)) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        `discarded hunk digest not found in plan: "${digest}"`,
        { artifactId, hunkDigest: digest, knownDigests: [...knownDigests] },
      );
    }
  }
}

/**
 * Verify undiscarded protected human hunks are present in the resolved body.
 * Strict byte-level inclusion — no trim, no string approximation.
 * Range validation and currentDigest verification — fail closed on mismatch.
 */
function verifyHumanHunksPreserved(plan, artifactId, resolvedContent, discardedHunkDigests) {
  const artifact = (plan.artifacts ?? []).find((a) => a.id === artifactId);
  if (!artifact?.protectedHunks || artifact.protectedHunks.length === 0) return;

  const discarded = new Set(discardedHunkDigests);

  // Decode current content from conflict (handles Buffer/JSON roundtrip)
  const currentContent = decodeBuffer(artifact.conflict?.current, 'current');
  if (!currentContent) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'protected human hunks require current conflict bytes',
      { artifactId },
    );
  }

  for (const hunk of artifact.protectedHunks) {
    if (discarded.has(hunk.hunkDigest)) continue;
    if (!hunk.range) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        'protected human hunk is missing its byte range',
        { artifactId, hunkDigest: hunk.hunkDigest },
      );
    }

    const { start, length } = hunk.range;

    // Range boundary check — fail closed
    if (start < 0 || length < 0 || start + length > currentContent.length) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        `protected hunk range out of bounds: start=${start}, length=${length}, content length=${currentContent.length}`,
        { artifactId, hunkDigest: hunk.hunkDigest, range: hunk.range, contentLength: currentContent.length },
      );
    }

    // Extract exact hunk bytes from current content
    const hunkBytes = currentContent.slice(start, start + length);

    // Verify currentDigest if provided — fail closed on mismatch
    if (hunk.currentDigest) {
      const actualDigest = sha256Hex(hunkBytes);
      if (actualDigest !== hunk.currentDigest) {
        throw new ReleaseError(
          MISSING_PARAMETERS,
          `protected hunk currentDigest mismatch: expected ${hunk.currentDigest}, got ${actualDigest}`,
          { artifactId, hunkDigest: hunk.hunkDigest, expected: hunk.currentDigest, actual: actualDigest },
        );
      }
    }

    // Strict byte-level inclusion in resolved content — no trim
    if (hunkBytes.length > 0) {
      if (resolvedContent.indexOf(hunkBytes) === -1) {
        throw new ReleaseError(
          MISSING_PARAMETERS,
          `protected human hunk not found in resolved body: "${hunk.hunkDigest}"`,
          { artifactId, hunkDigest: hunk.hunkDigest },
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Plan derivation (phase 2)
// ---------------------------------------------------------------------------

function deriveResolvedPlan(plan, artifactId, oldPlanDigest, resolvedPath, resolvedContent, discardedHunkDigests) {
  const resolvedDigest = sha256Hex(resolvedContent);
  const resolutionRelPath = `.release-skill/resolution/${artifactId}/${artifactId}.resolved`;

  const hunkDecisions = discardedHunkDigests.map((digest) => Object.freeze({
    hunkDigest: digest,
    action: 'discarded',
  }));

  const updatedArtifacts = (plan.artifacts ?? []).map((a) => {
    if (a.id !== artifactId) return Object.freeze({ ...a });
    return Object.freeze({
      ...a,
      status: 'RESOLVED',
      safeToWrite: false,
      resolvedDigest,
      resolutionPath: resolutionRelPath,
      hunkDecisions: Object.freeze(hunkDecisions),
      allowedActions: ['inspect'],
    });
  });

  const newPlan = Object.freeze({
    apiVersion: plan.apiVersion,
    operation: 'resolve',
    bindings: Object.freeze({ ...(plan.bindings ?? {}) }),
    artifacts: Object.freeze(updatedArtifacts),
    safeToWrite: false,
    targetUnchanged: true,
    nextAction: Object.freeze({ command: 'artifacts inspect --plan-digest <new-digest>' }),
    supersedesPlanDigest: oldPlanDigest,
    planDigest: undefined,
  });

  const digest = computeResolutionDigest(newPlan);
  return Object.freeze({ ...newPlan, planDigest: digest });
}
