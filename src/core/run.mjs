/**
 * Shared run validation, loading, and atomic writing for release runs.
 *
 * Provides:
 * - `validateRun(run)` -- validate a run object against the release-run schema
 * - `loadRun(runPath)` -- load, parse, and validate a run file
 * - `writeRunAtomic(runPath, run)` -- validate and write a run file atomically
 *
 * Used by publish, reconcile, and verify commands to ensure run records
 * conform to the formal schema.
 *
 * @module core/run
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import Ajv from 'ajv';

import { computePlanDigest } from './plan.mjs';
import { ReleaseError, GATE_FAILED } from './errors.mjs';

// ---------------------------------------------------------------------------
// Embedded release-run JSON Schema
// ---------------------------------------------------------------------------

const RELEASE_RUN_SCHEMA = {
  $id: 'https://release-skill.dev/schemas/release-run/v1',
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Release Run',
  description: 'Schema for a release run record capturing execution checkpoints',
  type: 'object',
  required: ['runId', 'status', 'checkpoints'],
  additionalProperties: false,
  properties: {
    runId: {
      type: 'string',
      minLength: 1,
      description: 'Unique identifier for this run',
    },
    status: {
      type: 'string',
      enum: ['PUBLISHING', 'PUBLISHED', 'VERIFIED', 'PARTIAL', 'BLOCKED'],
      description: 'Current status of the run',
    },
    command: {
      type: 'string',
      enum: ['assess', 'prepare', 'publish', 'reconcile', 'verify'],
      description: 'The command that initiated this run',
    },
    planDigest: {
      type: 'string',
      description: 'SHA-256 digest of the release plan used',
    },
    sourceRunId: {
      type: 'string',
      minLength: 1,
      description: 'Run ID of the source run (for reconcile runs)',
    },
    startedAt: {
      type: 'string',
      format: 'date-time',
      description: 'ISO 8601 timestamp when the run started',
    },
    finishedAt: {
      type: 'string',
      format: 'date-time',
      description: 'ISO 8601 timestamp when the run finished',
    },
    checkpoints: {
      type: 'array',
      items: {
        type: 'object',
        required: ['actionId', 'actionType', 'status'],
        additionalProperties: false,
        properties: {
          actionId: {
            type: 'string',
            minLength: 1,
            description: 'Identifier of the external action',
          },
          actionType: {
            type: 'string',
            enum: [
              'push-commit',
              'push-snapshot',
              'create-tag',
              'npm-publish',
              'github-release',
              'claude-marketplace-install',
              'codex-marketplace-install',
            ],
            description: 'Type of external action',
          },
          status: {
            type: 'string',
            enum: ['succeeded', 'failed', 'skipped', 'pending'],
            description: 'Result status of this checkpoint',
          },
          preObserve: {
            type: 'string',
            enum: ['CONSISTENT', 'MISSING', 'CONFLICTING'],
            description: 'Remote state before execution',
          },
          postObserve: {
            type: 'string',
            enum: ['CONSISTENT', 'MISSING', 'CONFLICTING'],
            description: 'Remote state after execution',
          },
          startedAt: {
            type: 'string',
            format: 'date-time',
          },
          finishedAt: {
            type: 'string',
            format: 'date-time',
          },
          remoteRef: {
            type: 'object',
            description: 'Remote resource identifiers',
            additionalProperties: false,
            properties: {
              commit: { type: 'string' },
              tag: { type: 'string' },
              version: { type: 'string' },
              url: { type: 'string' },
            },
          },
          error: {
            type: 'object',
            description: 'Error details when status is failed',
            additionalProperties: false,
            properties: {
              code: {
                type: 'string',
                enum: [
                  'CONFIG_INVALID',
                  'BASELINE_CHANGED',
                  'DIRTY_SCOPE_CONFLICT',
                  'GATE_FAILED',
                  'AUTH_MISSING',
                  'REMOTE_CONFLICT',
                  'HOOK_TIMEOUT',
                  'PARTIAL_RELEASE',
                  'POST_PUBLISH_VERIFY_FAILED',
                ],
              },
              message: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Schema validator (compiled once)
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });
const validateRunSchema = ajv.compile(RELEASE_RUN_SCHEMA);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a run object against the embedded release-run schema.
 *
 * @param {Object} run - The run object to validate.
 * @throws {ReleaseError} GATE_FAILED if the run does not match the schema.
 */
export function validateRun(run) {
  const valid = validateRunSchema(run);
  if (!valid) {
    const errors = validateRunSchema.errors ?? [];
    const summary = errors
      .map((e) => `${e.instancePath || '/'}: ${e.message}`)
      .join('; ');
    throw new ReleaseError(
      GATE_FAILED,
      `release run schema validation failed: ${summary}`,
      { validationErrors: errors },
    );
  }
}

/**
 * Load, parse, and validate a run file from disk.
 *
 * @param {string} runPath - Absolute path to the run file.
 * @returns {Promise<Object>} The validated run object.
 * @throws {ReleaseError} GATE_FAILED if the file cannot be read, parsed, or validated.
 */
export async function loadRun(runPath) {
  let raw;
  try {
    raw = await readFile(runPath, 'utf8');
  } catch (err) {
    throw new ReleaseError(
      GATE_FAILED,
      `cannot read release run: ${err.message}`,
      { runPath, cause: err.code },
    );
  }

  let run;
  try {
    run = JSON.parse(raw);
  } catch (err) {
    throw new ReleaseError(
      GATE_FAILED,
      `release run is not valid JSON: ${err.message}`,
      { runPath },
    );
  }

  validateRun(run);
  return run;
}

/**
 * Validate a run's planDigest against a loaded plan.
 *
 * When `requirePresence` is true (default for source runs used by
 * reconcile/verify), a missing planDigest is treated as a validation failure.
 *
 * @param {Object} run - The validated run object.
 * @param {Object} plan - The loaded release plan.
 * @param {Object} [options]
 * @param {boolean} [options.requirePresence=true] - Require planDigest to be present.
 * @throws {ReleaseError} GATE_FAILED if planDigest is missing or does not match.
 */
export function validateRunPlanDigest(run, plan, options = {}) {
  const requirePresence = options.requirePresence !== false;
  const expectedDigest = computePlanDigest(plan);

  if (!run.planDigest) {
    if (requirePresence) {
      throw new ReleaseError(
        GATE_FAILED,
        'source run is missing required planDigest field',
        { runId: run.runId },
      );
    }
    return; // Optional: silently pass if not required
  }

  if (run.planDigest !== expectedDigest) {
    throw new ReleaseError(
      GATE_FAILED,
      `run planDigest mismatch: run says ${String(run.planDigest).slice(0, 16)}..., plan is ${expectedDigest.slice(0, 16)}...`,
      { runDigest: run.planDigest, planDigest: expectedDigest },
    );
  }
}

/**
 * Validate that a source run's checkpoints map 1:1 to plan actions.
 * Missing or unknown actions fail closed.
 *
 * @param {Object} run - The validated source run object.
 * @param {Object[]} planActions - The plan's externalActions array.
 * @throws {ReleaseError} GATE_FAILED on mapping failures.
 */
export function validateRunCheckpointMapping(run, planActions) {
  const planActionIds = new Set(planActions.map((a) => a.id));
  const runCheckpointIds = new Set(run.checkpoints.map((cp) => cp.actionId));

  // Every plan action must have a checkpoint
  for (const action of planActions) {
    if (!runCheckpointIds.has(action.id)) {
      throw new ReleaseError(
        GATE_FAILED,
        `source run missing checkpoint for plan action "${action.id}"`,
        { actionId: action.id },
      );
    }
  }

  // Every checkpoint must map to a plan action (no unknown actions)
  for (const cp of run.checkpoints) {
    if (!planActionIds.has(cp.actionId)) {
      throw new ReleaseError(
        GATE_FAILED,
        `source run has checkpoint for unknown action "${cp.actionId}"`,
        { actionId: cp.actionId },
      );
    }
  }
}

/**
 * Write a run file atomically to disk.
 *
 * Validates the run against the schema before writing.
 * Uses temp-file + rename for atomicity.
 *
 * @param {string} runPath - Absolute path to write the run to.
 * @param {Object} run - The run object to write.
 * @returns {Promise<void>}
 * @throws {ReleaseError} GATE_FAILED on schema validation failure.
 */
export async function writeRunAtomic(runPath, run) {
  validateRun(run);

  const json = JSON.stringify(run, null, 2);
  const dir = dirname(runPath);
  const tmpPath = `${dir}/.release-run-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmpPath, json, 'utf8');
  await rename(tmpPath, runPath);
}
