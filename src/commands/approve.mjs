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
import { resolve, dirname } from 'node:path';
import Ajv from 'ajv';

import { computePlanDigest, validatePlan, validatePlanActionCompleteness } from '../core/plan.mjs';
import { ReleaseError, PLAN_DIGEST_MISMATCH, GATE_FAILED } from '../core/errors.mjs';

// ---------------------------------------------------------------------------
// Embedded approval-record JSON Schema
// ---------------------------------------------------------------------------

const APPROVAL_RECORD_SCHEMA = {
  $id: 'https://release-skill.dev/schemas/approval-record/v1',
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Approval Record',
  description: 'Schema for human approval record bound to a frozen release plan',
  type: 'object',
  required: [
    'planDigest', 'baseline',
    'approvedActions', 'actor', 'approvedAt', 'expiresAt',
  ],
  anyOf: [
    { required: ['targetVersion'] },
    { required: ['unitVersions'] },
  ],
  additionalProperties: false,
  properties: {
    planDigest: { type: 'string', minLength: 1 },
    baseline: {
      type: 'object',
      required: ['gitTreeHash'],
      additionalProperties: false,
      properties: {
        gitTreeHash: { type: 'string', minLength: 1 },
        workspaceDigest: { type: 'string', minLength: 1 },
      },
    },
    targetVersion: { type: 'string', minLength: 1 },
    unitVersions: {
      type: 'object',
      minProperties: 1,
      additionalProperties: { type: 'string', minLength: 1 },
    },
    approvedActions: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
      uniqueItems: true,
    },
    actor: { type: 'string', minLength: 1 },
    approvedAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    exceptions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rule', 'reason', 'responsible', 'expiresAt'],
        additionalProperties: false,
        properties: {
          rule: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
          responsible: { type: 'string', minLength: 1 },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Schema validator
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });
const validateApprovalSchema = ajv.compile(APPROVAL_RECORD_SCHEMA);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate an approval record against the schema.
 *
 * @param {object} record - The approval record.
 * @throws {ReleaseError} GATE_FAILED on schema violations.
 */
function validateApprovalRecord(record) {
  const valid = validateApprovalSchema(record);
  if (!valid) {
    const errors = validateApprovalSchema.errors ?? [];
    const summary = errors
      .map((e) => `${e.instancePath || '/'}: ${e.message}`)
      .join('; ');
    throw new ReleaseError(
      GATE_FAILED,
      `approval record schema validation failed: ${summary}`,
      { validationErrors: errors },
    );
  }
}

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
 *   Defaults to `<planDir>/approval-record.json`.
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
  validateApprovalRecord(approvalRecord);

  // --- Step 7: Write approval record ---
  const writePath = outputPath ?? resolve(dirname(planPath), 'approval-record.json');
  await writeFile(writePath, JSON.stringify(approvalRecord, null, 2), 'utf8');

  return approvalRecord;
}
