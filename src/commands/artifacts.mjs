/**
 * Artifacts CLI command routing.
 *
 * Handles artifact inspection, resolution, and durable apply commands.
 *
 * JSON error output always includes:
 * - `status`, `safeToWrite`, `targetUnchanged`, `evidenceDir`
 * - A unique `nextAction` with a `command` field
 *
 * @module commands/artifacts
 */

import {
  ReleaseError,
  MISSING_PARAMETERS,
} from '../core/errors.mjs';
import {
  inspectArtifacts, initArtifacts,
  captureInspectInputs, inspectFromInputs, verifyInputsUnchanged,
} from '../artifacts/inspect.mjs';
import { writePlan } from '../artifacts/artifact-plan.mjs';
import { planAdoption, discardBootstrapHunk } from '../artifacts/adoption.mjs';
import { materializeResolution, submitResolution } from '../artifacts/resolution.mjs';
import { acquireProjectLock, breakProjectLock } from '../artifacts/project-lock.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadArtifactPolicy } from '../artifacts/policy.mjs';
import { readEntry } from '../artifacts/entry.mjs';
import { createBuiltInProducerRegistry, runProducerClosure } from '../artifacts/producer-registry.mjs';
import { buildProducerGraph } from '../artifacts/graph.mjs';

// ---------------------------------------------------------------------------
// Valid subcommands
// ---------------------------------------------------------------------------

const VALID_SUBCOMMANDS = new Set([
  'status', 'inspect', 'init', 'adopt', 'bootstrap', 'resolve',
  'break-lock', 'update', 'apply',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run an artifacts subcommand.
 *
 * @param {object} options
 * @param {string} options.subcommand - One of 'status', 'inspect', 'init', 'adopt', 'bootstrap'.
 * @param {string[]} options.args - Raw CLI arguments.
 * @param {string} options.root - Repository root (absolute).
 * @returns {Promise<object>} Command result with status, plan, nextAction.
 * @throws {ReleaseError} MISSING_PARAMETERS on invalid subcommand.
 */
export async function runArtifactsCommand({ subcommand, args, root } = {}) {
  if (!VALID_SUBCOMMANDS.has(subcommand)) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      `unknown artifacts subcommand: "${subcommand}"; valid: ${[...VALID_SUBCOMMANDS].join(', ')}`,
      { subcommand, valid: [...VALID_SUBCOMMANDS] },
    );
  }

  // --- Adopt subcommand ---
  if (subcommand === 'adopt') {
    const lock = await acquireProjectLock({ root, command: 'adopt', mode: 'exclusive' });
    try {
      return await handleAdopt({ args, root });
    } finally {
      await lock.release();
    }
  }

  // --- Bootstrap subcommand (discard/replace) ---
  if (subcommand === 'bootstrap') {
    const lock = await acquireProjectLock({ root, command: 'bootstrap', mode: 'exclusive' });
    try {
      return await handleBootstrap({ args, root });
    } finally {
      await lock.release();
    }
  }

  // --- Apply/update --apply use the same durable transaction authority ---
  if (subcommand === 'apply'
      || (subcommand === 'update' && args.includes('--apply'))) {
    return handleApply({ args, root });
  }
  if (subcommand === 'update') {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'update requires --apply --plan <path> and --plan-digest <digest>',
      { subcommand: 'update' },
    );
  }

  // --- Resolve subcommand (materialize/submit) ---
  if (subcommand === 'resolve') {
    return handleResolve({ args, root });
  }

  // --- Break-lock subcommand ---
  if (subcommand === 'break-lock') {
    return handleBreakLock({ args, root });
  }

  // Parse common optional flags from args
  const outputIdx = args.indexOf('--output');
  const output = outputIdx !== -1 && args[outputIdx + 1]
    ? args[outputIdx + 1]
    : undefined;

  // Resolve mode from subcommand
  const modeMap = {
    status: 'status',
    inspect: 'inspect',
    init: 'init',
  };
  const mode = modeMap[subcommand];

  // Short lock for status/inspect/init:
  // 1. Acquire lock → capture immutable inputs → release lock
  // 2. Run inspection (classify, assemble) without lock
  // 3. Acquire lock → verify inputs unchanged → write plan → release lock
  if (mode) {
    // init uses its own validation (nested git roots, partial stages)
    if (mode === 'init') {
      const lock = await acquireProjectLock({ root, command: subcommand, mode: 'exclusive' });
      try {
        const result = await initArtifacts({ root, output });
        return formatResult(result, output);
      } finally {
        await lock.release();
      }
    }

    // Phase 1: Acquire lock → capture inputs → release
    let inputs;
    {
      const lock = await acquireProjectLock({ root, command: subcommand, mode: 'exclusive' });
      try {
        inputs = await captureInspectInputs({ root });
      } finally {
        await lock.release();
      }
    }

    // Phase 2: Run inspection (classify + assemble) without lock
    const result = inspectFromInputs({ inputs, mode });

    // Phase 3: Acquire lock → verify inputs unchanged → write plan → release
    {
      const lock = await acquireProjectLock({ root, command: subcommand, mode: 'exclusive' });
      try {
        await verifyInputsUnchanged({ root, inputs });
        if (output) {
          await writePlan(result.plan, output);
        }
      } finally {
        await lock.release();
      }
    }

    const runId = `inspect-${Date.now().toString(36)}`;
    return formatResult({ ...result, evidenceDir: `.release-skill/runs/${runId}` }, output);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format the result for CLI output.
 */
function formatResult(result, outputPath) {
  return Object.freeze({
    status: result.status,
    safeToWrite: result.safeToWrite,
    targetUnchanged: result.targetUnchanged,
    evidenceDir: result.evidenceDir,
    nextAction: result.nextAction,
    plan: result.plan,
    ...(outputPath ? { planPath: outputPath } : {}),
  });
}

/**
 * Parse a flag value from args array.
 */
function getFlag(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

/**
 * Build a producer runner that uses the real built-in producer registry.
 * Returns a function compatible with planAdoption's runProducer option.
 */
async function buildProducerRunner(root) {
  const registry = await createBuiltInProducerRegistry();
  return async ({ artifactIds, inputSnapshot, graph }) => {
    const result = await runProducerClosure({
      registry,
      graph,
      inputSnapshot,
      artifactIds,
    });
    return {
      byArtifact: result.byArtifact,
      implementationDigest: null, // captured from registry per-producer
    };
  };
}

/**
 * Handle the `artifacts adopt` subcommand.
 *
 * Reads the init plan, loads the policy, reads current/generated entries
 * from the plan's firstCandidate fields, runs producer closure, and
 * computes an adoption plan with protected hunks and downstream closure.
 */
async function handleAdopt({ args, root }) {
  const planPath = getFlag(args, '--plan') ?? getFlag(args, '--bootstrap-plan');
  const adoptIndex = args.indexOf('adopt');
  const positional = adoptIndex >= 0 && args[adoptIndex + 1] && !args[adoptIndex + 1].startsWith('--')
    ? args[adoptIndex + 1]
    : undefined;
  const artifactId = getFlag(args, '--artifact') ?? positional;
  const expectedDigest = getFlag(args, '--plan-digest');

  if (!planPath || !artifactId) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'adopt requires <generated-artifact-id> and --plan <path> or --bootstrap-plan <path>',
      { subcommand: 'adopt' },
    );
  }

  // Read and validate the plan
  const planRaw = await readFile(planPath, 'utf8');
  const plan = JSON.parse(planRaw);

  if (expectedDigest && plan.planDigest !== expectedDigest) {
    throw new ReleaseError(
      'PLAN_STALE',
      'plan digest does not match expected --plan-digest',
      { expected: expectedDigest, actual: plan.planDigest },
    );
  }

  // Load policy
  const { policy } = await loadArtifactPolicy({ root });

  // Read current entries from worktree
  const currentEntries = new Map();
  for (const artifact of plan.artifacts ?? []) {
    if (artifact.path) {
      const entry = await readEntry({ root, path: artifact.path, source: 'worktree' });
      if (entry.kind === 'regular') {
        const bytes = await readFile(join(root, artifact.path));
        currentEntries.set(artifact.id, Object.freeze({ ...entry, bytes, content: bytes }));
      } else {
        currentEntries.set(artifact.id, entry);
      }
    } else {
      currentEntries.set(artifact.id, { kind: 'absent' });
    }
  }

  // Read generated entries from plan's firstCandidate (real data, not fake absent)
  const generatedEntries = new Map();
  for (const artifact of plan.artifacts ?? []) {
    if (artifact.firstCandidate) {
      const fc = artifact.firstCandidate;
      const bytes = Buffer.isBuffer(fc.bytes)
        ? Buffer.from(fc.bytes)
        : (typeof fc.bytesBase64 === 'string'
          ? Buffer.from(fc.bytesBase64, 'base64')
          : (fc.bytes?.type === 'Buffer' && Array.isArray(fc.bytes.data)
            ? Buffer.from(fc.bytes.data)
            : null));
      if (bytes) {
        generatedEntries.set(artifact.id, {
          kind: 'regular',
          bytes,
          sha256: fc.sha256,
        });
      } else {
        generatedEntries.set(artifact.id, { kind: 'absent' });
      }
    } else {
      generatedEntries.set(artifact.id, { kind: 'absent' });
    }
  }

  // Build producer runner (real registry)
  const runProducer = await buildProducerRunner(root);

  // Compute adoption plan
  const adoptionPlan = await planAdoption({
    plan,
    policy,
    artifactId,
    currentEntries,
    generatedEntries,
    runProducer,
  });

  return Object.freeze({
    ...adoptionPlan,
    nextAction: adoptionPlan.status === 'ADOPTION_REQUIRED'
      ? Object.freeze({ command: 'artifacts bootstrap discard|replace --artifact <id> --hunk-digest <digest>' })
      : Object.freeze({ command: 'artifacts accept --plan' }),
  });
}

/**
 * Handle the `artifacts bootstrap discard|replace` subcommand.
 *
 * Records a per-hunk discard or replace decision with actor + reason,
 * re-reads currentEntries to verify bytes, and derives a new plan digest.
 */
async function handleBootstrap({ args, root }) {
  const bootstrapIndex = args.indexOf('bootstrap');
  const action = bootstrapIndex >= 0 && args[bootstrapIndex + 1] && !args[bootstrapIndex + 1].startsWith('--')
    ? args[bootstrapIndex + 1]
    : 'discard';
  if (action !== 'discard' && action !== 'replace') {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      `bootstrap subcommand must be "discard" or "replace", got "${action}"`,
      { action },
    );
  }

  const artifactId = getFlag(args, '--artifact');
  const hunkDigest = getFlag(args, '--hunk-digest');
  const planPath = getFlag(args, '--plan');
  const expectedDigest = getFlag(args, '--plan-digest');
  const actor = getFlag(args, '--actor');
  const reason = getFlag(args, '--reason');
  const replacementPath = getFlag(args, '--replacement-file');

  if (!artifactId || !hunkDigest || !planPath || !expectedDigest || !actor || !reason) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'bootstrap requires --artifact, --hunk-digest, --plan, --plan-digest, --actor, and --reason',
      { subcommand: 'bootstrap' },
    );
  }

  // Read the adoption plan
  const planRaw = await readFile(planPath, 'utf8');
  const adoptionPlan = JSON.parse(planRaw);

  // Re-read current entries from the exact artifact paths bound into the plan.
  const currentEntries = new Map();
  for (const id of new Set((adoptionPlan.protectedHunks ?? []).map((h) => h.artifactId))) {
    const artifactPath = adoptionPlan.artifactPaths?.[id];
    if (!artifactPath) {
      throw new ReleaseError('PLAN_STALE', `artifact path missing from adoption plan: ${id}`, { id });
    }
    const entry = await readEntry({ root, path: artifactPath, source: 'worktree' });
    if (entry.kind !== 'regular') {
      throw new ReleaseError('PLAN_STALE', `artifact is no longer a regular file: ${id}`, { id });
    }
    const bytes = await readFile(join(root, artifactPath));
    currentEntries.set(id, Object.freeze({ ...entry, bytes, content: bytes }));
  }

  // Read replacement bytes if action is replace
  let replacementBytes;
  if (action === 'replace' && replacementPath) {
    replacementBytes = await readFile(replacementPath);
  }

  const updated = await discardBootstrapHunk({
    adoptionPlan,
    currentEntries,
    artifactId,
    hunkDigest,
    expectedPlanDigest: expectedDigest,
    actor,
    reason,
    action,
    replacementBytes,
  });

  return Object.freeze({
    ...updated,
    nextAction: updated.status === 'ADOPTION_REQUIRED'
      ? Object.freeze({ command: 'artifacts bootstrap discard|replace --artifact <id> --hunk-digest <digest>' })
      : Object.freeze({ command: 'artifacts inspect --plan-digest <new-digest>' }),
  });
}

/**
 * Handle the `artifacts resolve materialize|submit` subcommand.
 *
 * Subcommands:
 * - `materialize`: Scan conflict for sensitive content, create resolution
 *   directory (0700) with editable conflict file (0600).
 * - `submit`: Read resolved file, verify bindings unchanged, derive new plan.
 *
 * Flags:
 * --artifact <id>       Artifact to resolve
 * --plan <path>         Path to the artifact plan
 * --plan-digest <digest> Expected plan digest (stale guard)
 * --resolved-file <path> (submit only) Path to the resolved file
 * --discarded-hunks <digests> (submit only) Comma-separated hunk digests
 */
async function handleResolve({ args, root }) {
  const resolveIndex = args.indexOf('resolve');
  const action = resolveIndex >= 0 && args[resolveIndex + 1] && !args[resolveIndex + 1].startsWith('--')
    ? args[resolveIndex + 1]
    : 'materialize';

  if (action !== 'materialize' && action !== 'submit') {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      `resolve subcommand must be "materialize" or "submit", got "${action}"`,
      { action },
    );
  }

  const artifactId = getFlag(args, '--artifact');
  const planPath = getFlag(args, '--plan');
  const expectedDigest = getFlag(args, '--plan-digest');

  if (!artifactId || !planPath || !expectedDigest) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'resolve requires --artifact, --plan, and --plan-digest',
      { subcommand: 'resolve' },
    );
  }

  // Read and validate the plan
  const planRaw = await readFile(planPath, 'utf8');
  const plan = JSON.parse(planRaw);

  if (plan.planDigest !== expectedDigest) {
    throw new ReleaseError(
      'PLAN_STALE',
      'plan digest does not match expected --plan-digest',
      { expected: expectedDigest, actual: plan.planDigest },
    );
  }

  // Long lock for both materialize and submit
  const lock = await acquireProjectLock({ root, command: `resolve ${action}`, mode: 'exclusive' });
  try {
    if (action === 'materialize') {
      // Optional sensitive authorization
      const sensitiveActor = getFlag(args, '--sensitive-actor');
      const sensitiveReason = getFlag(args, '--sensitive-reason');
      const sensitiveAuthorization = sensitiveActor && sensitiveReason
        ? { actor: sensitiveActor, reason: sensitiveReason }
        : undefined;

      const result = await materializeResolution({
        root,
        plan,
        planDigest: expectedDigest,
        artifactId,
        sensitiveAuthorization,
      });

      return Object.freeze({
        status: 'MATERIALIZED',
        directory: result.directory,
        resolvedPath: result.resolvedPath,
        metadata: result.metadata,
        nextAction: Object.freeze({
          command: `artifacts resolve submit --artifact ${artifactId} --plan ${planPath} --plan-digest ${expectedDigest} --resolved-file ${result.resolvedPath}`,
        }),
      });
    }

    // action === 'submit'
    const resolvedPath = getFlag(args, '--resolved-file');
    if (!resolvedPath) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        'resolve submit requires --resolved-file',
        { subcommand: 'resolve submit' },
      );
    }

    const discardedRaw = getFlag(args, '--discarded-hunks');
    const discardedHunkDigests = discardedRaw
      ? discardedRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    const resolved = await submitResolution({
      root,
      plan,
      planDigest: expectedDigest,
      artifactId,
      resolvedPath,
      discardedHunkDigests,
    });

    return Object.freeze({
      ...resolved,
      nextAction: Object.freeze({
        command: 'artifacts inspect --plan-digest <new-digest>',
      }),
    });
  } finally {
    await lock.release();
  }
}

/**
 * Handle the `artifacts break-lock` subcommand.
 *
 * Breaks a held project lock by matching the exact owner and writing audit
 * evidence. Requires --owner (JSON with all 6 fields) and --reason.
 *
 * The audit record contains no absolute paths.
 *
 * @param {object} options
 * @param {string[]} options.args - CLI arguments.
 * @param {string} options.root - Repository root.
 * @returns {Promise<object>} Audit record or structured error.
 */
async function handleBreakLock({ args, root }) {
  const ownerJson = getFlag(args, '--owner');
  const reason = getFlag(args, '--reason');

  // Validate required flags
  if (!ownerJson) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'break-lock requires --owner <JSON> with all 6 fields (pid, host, bootId, nonce, command, startedAt)',
      { subcommand: 'break-lock', missing: '--owner' },
    );
  }
  if (!reason) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'break-lock requires --reason <text> explaining why the lock is being broken',
      { subcommand: 'break-lock', missing: '--reason' },
    );
  }

  // Parse owner JSON
  let expectedOwner;
  try {
    expectedOwner = JSON.parse(ownerJson);
  } catch {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'break-lock --owner must be valid JSON',
      { subcommand: 'break-lock' },
    );
  }

  // Validate all 6 required fields
  const requiredFields = ['pid', 'host', 'bootId', 'nonce', 'command', 'startedAt'];
  const missingFields = requiredFields.filter((f) => expectedOwner[f] === undefined || expectedOwner[f] === null);
  if (missingFields.length > 0) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      `break-lock --owner JSON missing required fields: ${missingFields.join(', ')}`,
      { subcommand: 'break-lock', missingFields },
    );
  }

  // Delegate to breakProjectLock which does exact owner match + audit
  const auditRecord = await breakProjectLock({ root, expectedOwner, reason });

  return Object.freeze({
    status: 'LOCK_BROKEN',
    auditRecord,
  });
}

/**
 * Handle the `artifacts apply` subcommand.
 *
 * Applies an artifact plan with durable transaction journaling.
 * Requires --plan and --plan-digest flags.
 *
 * @param {object} options
 * @param {string[]} options.args - CLI arguments.
 * @param {string} options.root - Repository root.
 * @returns {Promise<object>} Transaction result.
 * @throws {ReleaseError} on validation failure.
 */
async function handleApply({ args, root }) {
  const planPath = getFlag(args, '--plan');
  const planDigest = getFlag(args, '--plan-digest');

  if (!planPath || !planDigest) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'apply requires --plan <path> and --plan-digest <digest>',
      { subcommand: args.includes('--apply') ? 'update' : 'apply' },
    );
  }

  // Loader failures are already sanitised, stable fail-closed errors. Preserve
  // them instead of replacing the actionable cause with a generic null-backend
  // error.
  const { loadSafeFs } = await import('../artifacts/safe-fs.mjs');
  const safeFs = await loadSafeFs();

  // Apply the plan
  const { applyArtifactPlan } = await import('../artifacts/transaction.mjs');
  const result = await applyArtifactPlan({
    root,
    planPath,
    planDigest,
    safeFs,
  });

  return Object.freeze({
    status: 'APPLIED',
    transactionId: result.transactionId,
    state: result.state,
    results: result.results,
    journal: result.journal,
  });
}
