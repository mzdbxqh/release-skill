/**
 * Shared approval validation for publish and reconcile commands.
 *
 * Centralises the safety gates that an approval record must pass before
 * any external write actions can proceed:
 * - planDigest matches the computed plan digest
 * - baseline.gitTreeHash matches the plan baseline
 * - targetVersion matches the plan's first unit target version
 * - approvedActions exactly equals plan external action ids (no superset, no subset)
 * - approval has not expired
 * - approval duration does not exceed 24 hours
 * - approvedAt is not in the future (beyond 5-minute clock skew tolerance)
 *
 * @module core/approval
 */

import { ReleaseError, GATE_FAILED } from './errors.mjs';
import { computePlanDigest } from './plan.mjs';
import { sha256Hex } from './digest.mjs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { WORKSPACE_DIGEST_ALGORITHM } from './baseline.mjs';
import { readTrustedPackageResource } from './trusted-resource.mjs';

const approvalSchema = JSON.parse((await readTrustedPackageResource(
  'schemas/approval-record.schema.json',
)).toString('utf8'));
const approvalAjv = new Ajv({ allErrors: true, strict: false });
addFormats(approvalAjv);
const validateApprovalSchema = approvalAjv.compile(approvalSchema);

export function validateApprovalRecordSchema(approval) {
  if (validateApprovalSchema(approval)) return;
  const errors = validateApprovalSchema.errors ?? [];
  throw new ReleaseError(
    GATE_FAILED,
    `approval record schema validation failed: ${errors.map((error) => `${error.instancePath || '/'}: ${error.message}`).join('; ')}`,
    { validationErrors: errors },
  );
}

export function computeApprovalDigest(rawApproval) {
  return sha256Hex(typeof rawApproval === 'string' || Buffer.isBuffer(rawApproval)
    ? rawApproval
    : JSON.stringify(rawApproval, null, 2));
}

export function assertImmutableApprovalAuthority(approvalPath, plan, rawApproval) {
  if (!plan?.production) return;
  const planDigest = computePlanDigest(plan);
  const approvalDigest = computeApprovalDigest(rawApproval);
  const absolute = resolve(approvalPath);
  const planDirectory = dirname(absolute);
  if (
    basename(absolute) !== `${approvalDigest}.json` ||
    basename(planDirectory) !== planDigest ||
    basename(dirname(planDirectory)) !== 'approvals'
  ) {
    throw new ReleaseError(
      GATE_FAILED,
      'production commands require approvals/<planDigest>/<approvalDigest>.json immutable authority',
      { approvalPath, planDigest, approvalDigest },
    );
  }
  return approvalDigest;
}

/**
 * Validate an approval record against a loaded plan.
 *
 * @param {Object} plan        The parsed release plan (must already pass schema validation).
 * @param {Object} approval    The parsed approval record.
 * @param {Object} [options]
 * @param {() => string} [options.clock]  Clock function returning ISO-8601 strings.
 *
 * @throws {ReleaseError} GATE_FAILED if any validation check fails.
 */
export function validateApproval(plan, approval, options = {}) {
  const clockFn = typeof options.clock === 'function' ? options.clock : () => new Date().toISOString();

  // --- Required fields ---
  if (!approval || typeof approval !== 'object') {
    throw new ReleaseError(
      GATE_FAILED,
      'approval record is missing or not an object',
      {},
    );
  }

  if (!approval.planDigest || !approval.baseline?.gitTreeHash || !approval.expiresAt) {
    throw new ReleaseError(
      GATE_FAILED,
      'approval record missing required fields: planDigest, baseline.gitTreeHash, or expiresAt',
      { approval },
    );
  }

  if (plan.production?.mode === 'github-npm-v1') {
    if (plan.baseline?.workspaceDigestAlgorithm !== WORKSPACE_DIGEST_ALGORITHM) {
      throw new ReleaseError(
        GATE_FAILED,
        `production plan workspace digest algorithm is missing or obsolete; expected ${WORKSPACE_DIGEST_ALGORITHM}`,
        { expected: WORKSPACE_DIGEST_ALGORITHM, actual: plan.baseline?.workspaceDigestAlgorithm ?? null },
      );
    }
    if (approval.baseline?.workspaceDigestAlgorithm !== WORKSPACE_DIGEST_ALGORITHM) {
      throw new ReleaseError(
        GATE_FAILED,
        `production approval workspace digest algorithm is missing or obsolete; expected ${WORKSPACE_DIGEST_ALGORITHM}`,
        { expected: WORKSPACE_DIGEST_ALGORITHM, actual: approval.baseline?.workspaceDigestAlgorithm ?? null },
      );
    }
  }
  if (
    plan.baseline?.workspaceDigestAlgorithm &&
    approval.baseline?.workspaceDigestAlgorithm !== plan.baseline.workspaceDigestAlgorithm
  ) {
    throw new ReleaseError(
      GATE_FAILED,
      'approval workspace digest algorithm does not match the frozen plan',
      {
        planAlgorithm: plan.baseline.workspaceDigestAlgorithm,
        approvalAlgorithm: approval.baseline?.workspaceDigestAlgorithm ?? null,
      },
    );
  }

  // --- planDigest match ---
  const actualDigest = computePlanDigest(plan);
  if (approval.planDigest !== actualDigest) {
    throw new ReleaseError(
      GATE_FAILED,
      `approval planDigest mismatch: approval says ${String(approval.planDigest).slice(0, 16)}..., plan is ${actualDigest.slice(0, 16)}...`,
      { approvalDigest: approval.planDigest, planDigest: actualDigest },
    );
  }

  // --- baseline.gitTreeHash match ---
  if (approval.baseline.gitTreeHash !== plan.baseline?.gitTreeHash) {
    throw new ReleaseError(
      GATE_FAILED,
      `approval baseline mismatch: approval says ${approval.baseline.gitTreeHash}, plan says ${plan.baseline?.gitTreeHash}`,
      { approvalTreeHash: approval.baseline.gitTreeHash, planTreeHash: plan.baseline?.gitTreeHash },
    );
  }

  // --- baseline.workspaceDigest match ---
  if (plan.baseline?.workspaceDigest) {
    if (!approval.baseline?.workspaceDigest) {
      throw new ReleaseError(
        GATE_FAILED,
        'approval record missing baseline.workspaceDigest (plan has workspaceDigest)',
        { planWorkspaceDigest: plan.baseline.workspaceDigest },
      );
    }
    if (approval.baseline.workspaceDigest !== plan.baseline.workspaceDigest) {
      throw new ReleaseError(
        GATE_FAILED,
        `approval workspaceDigest mismatch: approval says ${approval.baseline.workspaceDigest}, plan says ${plan.baseline.workspaceDigest}`,
        { approvalWorkspaceDigest: approval.baseline.workspaceDigest, planWorkspaceDigest: plan.baseline.workspaceDigest },
      );
    }
  }

  // --- Bind approval to every unit id + targetVersion pair ---
  const units = plan.units ?? [];
  const expectedUnitVersions = {};
  const versions = new Set();
  for (const unit of units) {
    if (!unit.targetVersion || typeof unit.targetVersion !== 'string' || unit.targetVersion.trim() === '') {
      throw new ReleaseError(
        GATE_FAILED,
        `unit "${unit.id ?? '(unknown)'}" is missing targetVersion; all units must have a non-empty targetVersion`,
        { unitId: unit.id },
      );
    }
    expectedUnitVersions[unit.id] = unit.targetVersion;
    versions.add(unit.targetVersion);
  }

  if (approval.unitVersions) {
    const expectedIds = Object.keys(expectedUnitVersions).sort();
    const approvedIds = Object.keys(approval.unitVersions).sort();
    if (JSON.stringify(expectedIds) !== JSON.stringify(approvedIds)) {
      throw new ReleaseError(
        GATE_FAILED,
        'approval unitVersions keys do not exactly match plan units',
        { expectedIds, approvedIds },
      );
    }
    for (const unitId of expectedIds) {
      if (approval.unitVersions[unitId] !== expectedUnitVersions[unitId]) {
        throw new ReleaseError(
          GATE_FAILED,
          `target version mismatch for unit "${unitId}": plan says ${expectedUnitVersions[unitId]}, approval says ${approval.unitVersions[unitId]}`,
          { unitId, planVersion: expectedUnitVersions[unitId], approvalVersion: approval.unitVersions[unitId] },
        );
      }
    }
    if (approval.targetVersion !== undefined) {
      if (versions.size !== 1) {
        throw new ReleaseError(
          GATE_FAILED,
          'approval targetVersion is ambiguous for heterogeneous unitVersions; omit targetVersion',
          { targetVersion: approval.targetVersion, expectedUnitVersions },
        );
      }
      const [planVersion] = versions;
      if (approval.targetVersion !== planVersion) {
        throw new ReleaseError(
          GATE_FAILED,
          `approval targetVersion conflicts with unitVersions: expected ${planVersion}, got ${approval.targetVersion}`,
          { planVersion, approvalVersion: approval.targetVersion },
        );
      }
    }
  } else {
    if (versions.size !== 1) {
      throw new ReleaseError(
        GATE_FAILED,
        'heterogeneous multi-unit plan requires approval.unitVersions',
        { expectedUnitVersions },
      );
    }
    const planVersion = units[0]?.targetVersion;
    if (!approval.targetVersion || planVersion !== approval.targetVersion) {
      throw new ReleaseError(
        GATE_FAILED,
        `target version mismatch: plan says ${planVersion}, approval says ${approval.targetVersion ?? '(missing)'}`,
        { planVersion, approvalVersion: approval.targetVersion },
      );
    }
  }

  // --- approvedActions exact set equality (not just superset) ---
  const approvedSet = new Set(approval.approvedActions ?? []);
  const planActionIds = new Set((plan.externalActions ?? []).map((a) => a.id));

  // Every plan action must be in the approved set
  for (const action of plan.externalActions ?? []) {
    if (!approvedSet.has(action.id)) {
      throw new ReleaseError(
        GATE_FAILED,
        `action "${action.id}" is not in the approved actions list`,
        { actionId: action.id, approvedActions: [...approvedSet] },
      );
    }
  }

  // No extra actions in the approved set (exact match required)
  for (const approvedId of approvedSet) {
    if (!planActionIds.has(approvedId)) {
      throw new ReleaseError(
        GATE_FAILED,
        `approved actions list contains "${approvedId}" which is not a plan action; exact set equality required`,
        { approvedId, planActionIds: [...planActionIds] },
      );
    }
  }

  // --- Time validation ---
  const approvedAtDate = new Date(approval.approvedAt);
  if (Number.isNaN(approvedAtDate.getTime())) {
    throw new ReleaseError(
      GATE_FAILED,
      `invalid approvedAt: "${approval.approvedAt}"`,
      { approvedAt: approval.approvedAt },
    );
  }

  const expiresAtDate = new Date(approval.expiresAt);
  if (Number.isNaN(expiresAtDate.getTime())) {
    throw new ReleaseError(
      GATE_FAILED,
      `invalid expiresAt: "${approval.expiresAt}"`,
      { expiresAt: approval.expiresAt },
    );
  }

  if (expiresAtDate.getTime() <= approvedAtDate.getTime()) {
    throw new ReleaseError(
      GATE_FAILED,
      `expiresAt (${approval.expiresAt}) must be after approvedAt (${approval.approvedAt})`,
      { approvedAt: approval.approvedAt, expiresAt: approval.expiresAt },
    );
  }

  // --- Max 24h approval window ---
  const MAX_APPROVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const approvalDurationMs = expiresAtDate.getTime() - approvedAtDate.getTime();
  if (approvalDurationMs > MAX_APPROVAL_MS) {
    throw new ReleaseError(
      GATE_FAILED,
      `approval duration ${Math.round(approvalDurationMs / 3600000)}h exceeds maximum 24h`,
      { approvedAt: approval.approvedAt, expiresAt: approval.expiresAt, durationHours: approvalDurationMs / 3600000 },
    );
  }

  // --- Reject future approvedAt (beyond 5-minute clock skew tolerance) ---
  const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes
  const now = clockFn();
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new ReleaseError(
      GATE_FAILED,
      `invalid clock value: "${now}"`,
      { clock: now },
    );
  }
  if (approvedAtDate.getTime() > nowDate.getTime() + CLOCK_SKEW_TOLERANCE_MS) {
    throw new ReleaseError(
      GATE_FAILED,
      `approvedAt (${approval.approvedAt}) is in the future (current time: ${now})`,
      { approvedAt: approval.approvedAt, now },
    );
  }

  // --- Expiry (publish/reconcile require current approval; verify may only
  // revalidate the immutable approval identity after publication) ---
  if (options.requireUnexpired !== false && nowDate > expiresAtDate) {
    throw new ReleaseError(
      GATE_FAILED,
      `approval expired at ${approval.expiresAt}, current time is ${now}`,
      { expiresAt: approval.expiresAt, now },
    );
  }

}
