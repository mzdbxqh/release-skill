/**
 * Shared approval validation for publish and reconcile commands.
 *
 * Centralises the safety gates that an approval record must pass before
 * any external write actions can proceed:
 * - planDigest matches the computed plan digest
 * - baseline.gitTreeHash matches the plan baseline
 * - targetVersion matches the plan's first unit target version
 * - approvedActions covers all plan external action ids
 * - approval has not expired
 *
 * @module core/approval
 */

import { ReleaseError, GATE_FAILED } from './errors.mjs';
import { computePlanDigest } from './plan.mjs';

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

  // --- approvedActions allowlist ---
  const approvedSet = new Set(approval.approvedActions ?? []);
  for (const action of plan.externalActions ?? []) {
    if (!approvedSet.has(action.id)) {
      throw new ReleaseError(
        GATE_FAILED,
        `action "${action.id}" is not in the approved actions list`,
        { actionId: action.id, approvedActions: [...approvedSet] },
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

  // --- Expiry ---
  const now = clockFn();
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new ReleaseError(
      GATE_FAILED,
      `invalid clock value: "${now}"`,
      { clock: now },
    );
  }
  if (nowDate > expiresAtDate) {
    throw new ReleaseError(
      GATE_FAILED,
      `approval expired at ${approval.expiresAt}, current time is ${now}`,
      { expiresAt: approval.expiresAt, now },
    );
  }

}
