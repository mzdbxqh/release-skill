/**
 * Artifact plan assembly, digest computation, and atomic protocol write.
 *
 * The plan is a content-addressed document that binds every immutable input
 * (repository identity, policy digest, base/current/producer manifest digests)
 * to a single `nextAction` recommendation.
 *
 * Plans are written only to:
 * - `.release-skill/runs/<run-id>/artifact-plan.json` (protocol run directory)
 * - User-specified `--output` path
 *
 * Writing uses a temporary file + fsync + rename to ensure atomicity.
 * No inventory target is ever written by this module.
 *
 * @module artifacts/artifact-plan
 */

import { writeFile, mkdir, readFile, rename, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import { canonicalJson, sha256Hex } from '../core/digest.mjs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble a canonical artifact plan from classified inputs.
 *
 * The plan covers:
 * - `apiVersion`: fixed contract version
 * - `operation`: 'inspect' | 'init' | 'status'
 * - `bindings`: all immutable input digests
 * - `artifacts`: per-artifact decision array
 * - `safeToWrite`: true only when every artifact is safe
 * - `targetUnchanged`: always true for read-only operations
 * - `nextAction`: a single recommended command
 * - `planDigest`: `sha256:<hex>` of the canonical plan
 *
 * @param {object} options
 * @param {'inspect'|'init'|'status'} options.operation - Operation type.
 * @param {object} options.bindings - Immutable input bindings.
 * @param {string} options.bindings.repositoryIdentity - Repository identity hash.
 * @param {string} options.bindings.policyDigest - Policy digest.
 * @param {string} options.bindings.baseManifestDigest - Base manifest digest.
 * @param {string} options.bindings.currentManifestDigest - Current manifest digest.
 * @param {string} options.bindings.producerClosureDigest - Producer closure digest.
 * @param {Array<object>} options.artifacts - Artifact decisions.
 * @param {boolean} options.safeToWrite - Whether all artifacts are safe to write.
 * @param {boolean} options.targetUnchanged - Whether targets are unchanged.
 * @returns {object} Frozen artifact plan with planDigest.
 */
export function assemblePlan({
  operation,
  bindings,
  artifacts = [],
  safeToWrite = false,
  targetUnchanged = true,
} = {}) {
  const nextAction = chooseNextAction(operation, artifacts, safeToWrite);

  const plan = {
    apiVersion: 'release-skill.dev/artifact-plan/v1',
    operation,
    bindings: Object.freeze({ ...bindings }),
    artifacts: Object.freeze(artifacts.map((a) => Object.freeze({ ...a }))),
    safeToWrite,
    targetUnchanged,
    nextAction,
  };

  // Compute planDigest over the canonical form (without the digest field itself)
  const canonical = canonicalJson(plan);
  plan.planDigest = `sha256:${sha256Hex(canonical)}`;

  return Object.freeze(plan);
}

/**
 * Write a plan atomically to the specified path.
 *
 * Uses temporary file + fsync + rename for atomicity.
 * Creates parent directories if needed.
 *
 * @param {object} plan - Frozen artifact plan.
 * @param {string} outputPath - Absolute path to write the plan.
 */
export async function writePlan(plan, outputPath) {
  const dir = dirname(outputPath);
  await mkdir(dir, { recursive: true });

  const tmpPath = `${outputPath}.tmp`;
  const content = JSON.stringify(plan, null, 2);

  // Write to temp file with fsync
  const fh = await open(tmpPath, 'w');
  try {
    await writeFile(fh, content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }

  // Atomic rename
  await rename(tmpPath, outputPath);
}

// ---------------------------------------------------------------------------
// Internal: nextAction selection
// ---------------------------------------------------------------------------

/**
 * Choose a single nextAction for the plan.
 *
 * The nextAction is always a single object with a `command` field.
 * Priority:
 * 1. If any artifact has status that blocks writes → `artifacts adopt`
 * 2. If any artifact needs acceptance → `artifacts accept`
 * 3. Otherwise → `artifacts apply` (all clean/mergeable)
 *
 * @param {string} operation - The plan operation type.
 * @param {Array<object>} artifacts - Artifact decisions.
 * @param {boolean} safeToWrite - Whether all artifacts are safe to write.
 * @returns {{ command: string }}
 */
function chooseNextAction(operation, artifacts, safeToWrite) {
  // Statuses that require adoption
  const BLOCKING = new Set([
    'ADOPTION_REQUIRED', 'CONFLICT', 'BASE_UNAVAILABLE',
    'POLICY_INVALID', 'POLICY_CHANGE_PENDING',
  ]);

  // Statuses that need acceptance
  const NEEDS_ACCEPT = new Set(['GENERATOR_CHANGED', 'MERGEABLE']);

  if (operation === 'init') {
    // Init always recommends adopt with bootstrap-plan
    return Object.freeze({
      command: 'artifacts adopt --bootstrap-plan',
    });
  }

  if (!safeToWrite) {
    // Find the highest-priority blocking status
    const blocking = artifacts.filter((a) => BLOCKING.has(a.status));
    if (blocking.length > 0) {
      return Object.freeze({
        command: 'artifacts adopt --plan',
      });
    }
  }

  if (artifacts.some((a) => NEEDS_ACCEPT.has(a.status))) {
    return Object.freeze({
      command: 'artifacts accept --plan',
    });
  }

  return Object.freeze({
    command: 'artifacts apply --plan',
  });
}
