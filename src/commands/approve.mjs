/**
 * Approve command: record approval for a frozen release plan.
 *
 * Reads a frozen release plan, validates its digest against the expected value,
 * constructs an approval record, validates it, and writes it to disk.
 *
 * Approval invariants:
 * - `planDigest` must match the actual plan digest (otherwise PLAN_DIGEST_MISMATCH).
 * - `approvedActions` must be explicit (no wildcards).
 * - Approval expires after a default of 24 hours.
 * - If the plan's baseline has changed since freeze, approval is invalidated.
 *
 * @module commands/approve
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';

import {
  assertAuthorityFileTarget,
  assertImmutablePlanAuthority,
  computePlanDigest,
  prepareAuthorityDirectory,
  validatePlan,
  validatePlanActionCompleteness,
} from '../core/plan.mjs';
import { ReleaseError, PLAN_DIGEST_MISMATCH, GATE_FAILED } from '../core/errors.mjs';
import { computeApprovalDigest, validateApprovalRecordSchema } from '../core/approval.mjs';
import { WORKSPACE_DIGEST_ALGORITHM } from '../core/baseline.mjs';

// ---------------------------------------------------------------------------
// Default clock
// ---------------------------------------------------------------------------

function defaultClock() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Approve a frozen release plan.
 *
 * Steps:
 * 1. Read the plan from `planPath`.
 * 2. Compute the plan's actual digest.
 * 3. Compare against `expectedDigest`; throw PLAN_DIGEST_MISMATCH if different.
 * 4. Validate the plan against the release-plan schema.
 * 5. Build the approval record with explicit action IDs, actor, and timestamps.
 * 6. Validate the approval record against the approval-record schema.
 * 7. Write the approval record to disk.
 *
 * @param {Object} options
 * @param {string} options.planPath - Absolute path to the frozen release plan.
 * @param {string} options.expectedDigest - Expected SHA-256 digest of the plan.
 * @param {string} options.actor - Identity of the approver.
 * @param {number} [options.expiresInMs=86400000] - Approval validity in ms (default 24h).
 * @param {() => string} [options.clock] - Clock function returning ISO-8601 strings.
 * @param {string} [options.outputPath] - Path to write the approval record.
 *   Defaults to `<releaseDir>/approval-record.json`; a digest-addressed copy is
 *   preserved at `<releaseDir>/approvals/<planDigest>/<approvalDigest>.json`.
 *
 * @returns {Promise<object>} The validated ApprovalRecord.
 *
 * @throws {ReleaseError} PLAN_DIGEST_MISMATCH if the plan digest does not match.
 * @throws {ReleaseError} GATE_FAILED on schema validation or other gate failures.
 */
export async function approvePlan(options) {
  const {
    planPath,
    expectedDigest,
    actor,
    expiresInMs = 24 * 60 * 60 * 1000, // 24 hours
    clock,
    outputPath,
  } = options ?? {};

  const clockFn = typeof clock === 'function' ? clock : defaultClock;

  // --- Validate required parameters ---
  if (!planPath || typeof planPath !== 'string') {
    throw new ReleaseError(PLAN_DIGEST_MISMATCH, 'planPath must be a non-empty string');
  }
  if (!expectedDigest || typeof expectedDigest !== 'string') {
    throw new ReleaseError(PLAN_DIGEST_MISMATCH, 'expectedDigest must be a non-empty string');
  }
  if (!actor || typeof actor !== 'string') {
    throw new ReleaseError(GATE_FAILED, 'actor must be a non-empty string');
  }

  // --- Step 1: Read the plan ---
  let planRaw;
  try {
    planRaw = await readFile(planPath, 'utf8');
  } catch (err) {
    throw new ReleaseError(
      GATE_FAILED,
      `cannot read release plan: ${err.message}`,
      { planPath, cause: err.code },
    );
  }

  let plan;
  try {
    plan = JSON.parse(planRaw);
  } catch (err) {
    throw new ReleaseError(
      GATE_FAILED,
      `release plan is not valid JSON: ${err.message}`,
      { planPath },
    );
  }

  // --- Step 2: Compute actual plan digest ---
  // The plan was written by writePlanAtomic, which embeds the digest.
  // We recompute from the stored content minus the digest field.
  const actualDigest = computePlanDigest(plan);
  assertImmutablePlanAuthority(planPath, plan);

  // --- Step 3: Compare digests ---
  if (actualDigest !== expectedDigest) {
    throw new ReleaseError(
      PLAN_DIGEST_MISMATCH,
      `plan digest mismatch: expected ${expectedDigest.slice(0, 16)}..., got ${actualDigest.slice(0, 16)}...`,
      { expectedDigest, actualDigest },
    );
  }

  // --- Step 4: Validate the plan ---
  validatePlan(plan);

  if (
    plan.production?.mode === 'github-npm-v1' &&
    plan.baseline?.workspaceDigestAlgorithm !== WORKSPACE_DIGEST_ALGORITHM
  ) {
    throw new ReleaseError(
      GATE_FAILED,
      `production plan workspace digest algorithm is missing or obsolete; re-run prepare (expected ${WORKSPACE_DIGEST_ALGORITHM})`,
      { expected: WORKSPACE_DIGEST_ALGORITHM, actual: plan.baseline?.workspaceDigestAlgorithm ?? null },
    );
  }

  // --- Step 4b: Validate action completeness ---
  const completenessResult = validatePlanActionCompleteness(plan);
  if (!completenessResult.passed) {
    throw new ReleaseError(
      GATE_FAILED,
      `plan action completeness gate failed: ${completenessResult.details.failures.join('; ')}`,
      { failures: completenessResult.details.failures },
    );
  }

  // --- Step 5a: Validate expiresInMs ---
  if (typeof expiresInMs !== 'number' || !Number.isFinite(expiresInMs) || expiresInMs <= 0) {
    throw new ReleaseError(
      GATE_FAILED,
      'expiresInMs must be a positive finite number',
      { expiresInMs },
    );
  }
  const MAX_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
  if (expiresInMs > MAX_EXPIRY_MS) {
    throw new ReleaseError(
      GATE_FAILED,
      `expiresInMs must not exceed 24 hours (${MAX_EXPIRY_MS}ms), got ${expiresInMs}ms`,
      { expiresInMs },
    );
  }

  // --- Step 5b: Materialize every unit version into the approval authority ---
  const units = plan.units ?? [];
  const versions = new Set();
  const unitVersions = {};
  for (const unit of units) {
    if (!unit.targetVersion || typeof unit.targetVersion !== 'string' || unit.targetVersion.trim() === '') {
      throw new ReleaseError(
        GATE_FAILED,
        `unit "${unit.id ?? '(unknown)'}" is missing targetVersion; all units must have a non-empty targetVersion`,
        { unitId: unit.id },
      );
    }
    versions.add(unit.targetVersion);
    unitVersions[unit.id] = unit.targetVersion;
  }
  const targetVersion = versions.size === 1 ? units[0]?.targetVersion : undefined;

  // --- Step 5c: Build approval record ---
  const approvedAt = clockFn();
  const approvedAtDate = new Date(approvedAt);
  if (Number.isNaN(approvedAtDate.getTime())) {
    throw new ReleaseError(
      GATE_FAILED,
      `invalid approvedAt timestamp: "${approvedAt}"`,
      { approvedAt },
    );
  }
  const expiresAt = new Date(approvedAtDate.getTime() + expiresInMs).toISOString();

  // Collect all external action IDs (explicit, no wildcards)
  const approvedActions = (plan.externalActions ?? []).map((a) => a.id);

  // Build baseline with workspaceDigest when plan has it
  const baseline = {
    gitTreeHash: plan.baseline.gitTreeHash,
  };
  if (plan.baseline.workspaceDigest) {
    baseline.workspaceDigest = plan.baseline.workspaceDigest;
  }
  if (plan.baseline.workspaceDigestAlgorithm) {
    baseline.workspaceDigestAlgorithm = plan.baseline.workspaceDigestAlgorithm;
  }

  const approvalRecord = {
    planDigest: actualDigest,
    baseline,
    unitVersions,
    ...(targetVersion ? { targetVersion } : {}),
    approvedActions,
    actor,
    approvedAt,
    expiresAt,
  };

  // --- Step 6: Validate approval record ---
  validateApprovalRecordSchema(approvalRecord);

  // --- Step 7: Preserve a digest-addressed authority and update convenience copy ---
  const planDir = dirname(resolve(planPath));
  const releaseDir = basename(planDir) === 'plans' && basename(planPath) === `${actualDigest}.json`
    ? dirname(planDir)
    : planDir;
  if (
    plan.production?.mode === 'github-npm-v1' &&
    outputPath &&
    resolve(outputPath) !== resolve(releaseDir, 'approval-record.json')
  ) {
    throw new ReleaseError(
      GATE_FAILED,
      'production approve requires the canonical approval-record.json alias next to the immutable plan authority; custom --output is supported only outside production',
      { outputPath: resolve(outputPath), expected: resolve(releaseDir, 'approval-record.json') },
    );
  }
  const json = JSON.stringify(approvalRecord, null, 2);
  const approvalDigest = computeApprovalDigest(json);
  const immutableApprovalPath = resolve(
    releaseDir,
    'approvals',
    actualDigest,
    `${approvalDigest}.json`,
  );
  await prepareAuthorityDirectory(dirname(immutableApprovalPath));
  await assertAuthorityFileTarget(immutableApprovalPath);
  try {
    await writeFile(immutableApprovalPath, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(immutableApprovalPath, 'utf8');
    if (existing !== json) {
      throw new ReleaseError(
        GATE_FAILED,
        'approval authority digest collision: existing bytes differ',
        { planDigest: actualDigest, approvalDigest, immutableApprovalPath },
      );
    }
  }

  const writePath = outputPath ?? resolve(releaseDir, 'approval-record.json');
  await prepareAuthorityDirectory(dirname(writePath));
  await assertAuthorityFileTarget(writePath);
  await writeFile(writePath, json, 'utf8');

  return Object.freeze({
    ...approvalRecord,
    approvalDigest,
    approvalPath: immutableApprovalPath,
    latestApprovalPath: writePath,
  });
}
