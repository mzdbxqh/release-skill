/**
 * Publish command: Saga-pattern checkpoint execution with safety gates.
 *
 * Reads a frozen, approved release plan and executes external actions
 * through registered adapters. Every step is a checkpoint: failure stops
 * subsequent actions and records PARTIAL status.
 *
 * Safety gates (all verified before any adapter execute):
 * 1. Plan schema validation
 * 2. Plan digest verification
 * 3. Approval record schema validation
 * 4. Approval-plan digest match
 * 5. Approval expiry check
 * 6. Target version match
 * 7. Approved actions allowlist check
 * 8. Action type adapter availability
 * 9. Baseline hash comparison (rejects stale baseline, calls zero adapter execute)
 * 10. Remote preflight (adapter-level)
 *
 * Invariants:
 * - Baseline change => BASELINE_CHANGED, zero adapter execute calls
 * - Any checkpoint failure => PARTIAL, no subsequent adapter execute calls
 * - System never auto-deletes remote tags, overwrites releases, or unpublishes npm
 *
 * @module commands/publish
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { computePlanDigest, validatePlan, validatePlanActionCompleteness } from '../core/plan.mjs';
import { validateApproval } from '../core/approval.mjs';
import { captureBaseline } from '../core/baseline.mjs';
import { createEvidenceWriter } from '../core/evidence.mjs';
import { writeRunAtomic } from '../core/run.mjs';
import {
  ReleaseError,
  GATE_FAILED,
  BASELINE_CHANGED,
  PARTIAL_RELEASE,
} from '../core/errors.mjs';
import { assertTransition, PUBLISHING, PUBLISHED, PARTIAL } from '../core/state-machine.mjs';
import { matchObservation } from '../adapters/contract.mjs';
import {
  resolveFrozenPath,
  verifyFrozenFile,
  verifyFrozenGitRepository,
  verifyFrozenSnapshot,
} from '../snapshot/frozen.mjs';

function assertInsideAssetRoot(assetRoot, candidate, label) {
  const rel = relative(assetRoot, candidate);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new ReleaseError(GATE_FAILED, `${label} must be a child of the production asset root`);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTION_NOT_ALLOWED = 'ACTION_NOT_ALLOWED';

/** Checkpoint order for the publish saga. */
const CHECKPOINT_ORDER = [
  'push-commit',
  'push-snapshot',
  'create-tag',
  'npm-publish',
  'github-release',
  'claude-marketplace-install',
  'codex-marketplace-install',
];

/**
 * Map plan action type to adapter ActionType.
 *
 * Plan uses `push-commit`, `push-snapshot`, `create-tag`, `npm-publish`,
 * `github-release`. The adapter contract uses `git-push`, `git-tag`,
 * `npm-publish`, `github-release`.
 */
const ADAPTER_ACTION_TYPE_MAP = {
  'push-commit': 'git-push',
  'push-snapshot': 'push-snapshot',
  'create-tag': 'git-tag',
  'npm-publish': 'npm-publish',
  'github-release': 'github-release',
  'claude-marketplace-install': 'claude-marketplace-install',
  'codex-marketplace-install': 'codex-marketplace-install',
};

const MARKETPLACE_TYPES = new Set([
  'claude-marketplace-install',
  'codex-marketplace-install',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultClock() {
  return new Date().toISOString();
}

/**
 * Deep-clone a JSON-serialisable value.
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Checkpoint execution
// ---------------------------------------------------------------------------

/**
 * Execute a single checkpoint action through the adapter registry.
 *
 * @param {Object} action - The external action from the plan.
 * @param {Object} adapterRegistry - The adapter registry.
 * @param {Object} context - Adapter context (plan, baseline, root, externalWritesAuthorized).
 * @returns {Promise<{ actionId: string, status: string, error: string|null }>}
 */
async function executeCheckpoint(action, adapterRegistry, context) {
  const { id: actionId, type: planActionType } = action;

  // write-remote-identifier is a meta-checkpoint: update the plan with
  // resource identifiers. No external adapter call.
  if (planActionType === 'write-remote-identifier') {
    return { actionId, status: 'SUCCEEDED', error: null };
  }

  const adapterActionType = ADAPTER_ACTION_TYPE_MAP[planActionType];
  if (!adapterActionType) {
    return {
      actionId,
      status: 'FAILED',
      error: `Unknown action type: ${planActionType}`,
    };
  }

  const adapter = adapterRegistry.getAdapter(adapterActionType);
  if (!adapter) {
    return {
      actionId,
      status: 'FAILED',
      error: `No adapter for action type: ${adapterActionType}`,
    };
  }

  // Preflight (read-only, no authorization required)
  const preflightResult = await adapter.preflight(
    { actionType: adapterActionType, ...action.parameters },
    context,
  );
  if (preflightResult.status === 'PREFLIGHT_FAILED') {
    return {
      actionId,
      status: 'FAILED',
      error: preflightResult.error ?? 'Preflight failed',
    };
  }

  // Execute (write action, requires externalWritesAuthorized)
  const executeResult = await adapter.execute(
    { actionType: adapterActionType, ...action.parameters },
    context,
  );

  if (executeResult.status === 'EXECUTED') {
    // Constraint E: execute success is not checkpoint success.
    // Call adapter.observe() to verify remote state.
    let observation;
    try {
      const observeResult = await adapter.observe(
        { actionType: adapterActionType, ...action.parameters, expected: action.expected },
        context,
      );
      observation = observeResult.observation;
    } catch {
      return {
        actionId,
        status: 'FAILED',
        error: 'observe call failed after execute',
      };
    }

    // Check for observation mismatch
    if (action.expected) {
      const { matches } = matchObservation(action.expected, observation);
      if (!matches) {
        return {
          actionId,
          status: 'FAILED',
          error: 'observation does not match expected state from frozen plan',
        };
      }
    } else if (observation && observation.mismatched) {
      return {
        actionId,
        status: 'FAILED',
        error: 'observation indicates mismatch',
      };
    }

    return { actionId, status: 'SUCCEEDED', error: null };
  }

  return {
    actionId,
    status: 'FAILED',
    error: executeResult.error ?? 'Execute failed',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a Saga-pattern publish against a frozen, approved release plan.
 *
 * @param {Object} options
 * @param {string} options.planPath - Absolute path to the frozen release plan.
 * @param {string} options.approvalPath - Absolute path to the approval record.
 * @param {Object} options.adapterRegistry - Adapter registry for action execution.
 * @param {string} [options.root] - Project root for baseline capture. Defaults to cwd.
 * @param {string} [options.runDir] - Evidence directory. Defaults to `<planDir>/runs/publish-<ts>`.
 * @param {() => string} [options.clock] - Clock function returning ISO-8601 strings.
 * @param {(root: string) => Promise<Object>} [options.captureBaselineFn] - Injectable baseline capture.
 *
 * @returns {Promise<{ planPath: string, status: string, checkpoints: Object[] }>}
 *
 * @throws {ReleaseError} GATE_FAILED on any safety gate failure.
 * @throws {ReleaseError} BASELINE_CHANGED if the baseline has changed since freeze.
 */
export async function publishRelease(options) {
  const {
    planPath,
    approvalPath,
    adapterRegistry,
    root = process.cwd(),
    runDir: runDirOpt,
    clock: clockOpt,
    captureBaselineFn,
    productionMode = false,
    productionConfirmation,
  } = options ?? {};

  const clockFn = typeof clockOpt === 'function' ? clockOpt : defaultClock;
  const captureBaselineActual = typeof captureBaselineFn === 'function'
    ? captureBaselineFn
    : captureBaseline;

  // --- Set up directories ---
  const runId = `publish-${Date.now()}`;
  const runDir = runDirOpt ?? `${planPath.replace(/release-plan\.json$/, '')}runs/${runId}`;
  await mkdir(runDir, { recursive: true });

  const evidence = createEvidenceWriter({ runDir, command: 'publish', clock: clockFn });

  try {
    // =======================================================================
    // Safety Gate 1: Load and validate plan schema
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'plan-load', status: 'started' });

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

    validatePlan(plan);

    await evidence.append({ phase: 'safety-gate', gate: 'plan-schema', status: 'passed' });

    // =======================================================================
    // Safety Gate 2: Verify plan digest
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'plan-digest', status: 'started' });

    const actualDigest = computePlanDigest(plan);
    if (plan.digest && plan.digest !== actualDigest) {
      throw new ReleaseError(
        GATE_FAILED,
        `plan digest mismatch: expected ${plan.digest.slice(0, 16)}..., computed ${actualDigest.slice(0, 16)}...`,
        { expected: plan.digest, actual: actualDigest },
      );
    }

    await evidence.append({ phase: 'safety-gate', gate: 'plan-digest', status: 'passed' });

    const isProductionPlan = plan.production?.mode === 'github-npm-v1';
    if (productionMode && !isProductionPlan) {
      throw new ReleaseError(GATE_FAILED, 'production publish requires a github-npm-v1 frozen plan');
    }
    if (isProductionPlan) {
      if (!plan.production.assetRoot || plan.production.assetRoot === '.') {
        throw new ReleaseError(GATE_FAILED, 'production plan requires a dedicated assetRoot');
      }
      if (!productionConfirmation || productionConfirmation !== actualDigest) {
        throw new ReleaseError(
          GATE_FAILED,
          'production confirmation must exactly match the current plan digest',
          { planDigest: actualDigest },
        );
      }
    }

    // =======================================================================
    // Safety Gate 2b: Validate plan action completeness
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'action-completeness', status: 'started' });

    const completenessResult = validatePlanActionCompleteness(plan);
    if (!completenessResult.passed) {
      await evidence.append({
        phase: 'safety-gate',
        gate: 'action-completeness',
        status: 'failed',
        failures: completenessResult.details.failures,
      });
      throw new ReleaseError(
        GATE_FAILED,
        `plan action completeness gate failed: ${completenessResult.details.failures.join('; ')}`,
        { failures: completenessResult.details.failures },
      );
    }

    await evidence.append({ phase: 'safety-gate', gate: 'action-completeness', status: 'passed' });

    if (isProductionPlan) {
      await evidence.append({ phase: 'safety-gate', gate: 'frozen-artifacts', status: 'started' });
      const assetRoot = await resolveFrozenPath(root, plan.production.assetRoot, 'production asset root');
      for (const unit of plan.units) {
        const frozen = unit.frozenSnapshot;
        const snapshot = await verifyFrozenSnapshot({
          root,
          snapshotPath: frozen.path,
          expectedDigest: frozen.manifestDigest,
        });
        assertInsideAssetRoot(assetRoot, snapshot.snapshotDir, 'frozen snapshot');
        const git = await verifyFrozenGitRepository({
          root,
          gitObjectDir: frozen.gitObjectDir,
          commit: frozen.commit,
          tree: frozen.tree,
        });
        assertInsideAssetRoot(assetRoot, git.gitDir, 'frozen git object directory');
        if (frozen.npm) {
          const tarball = await verifyFrozenFile({
            root,
            filePath: frozen.npm.tarballPath,
            expectedSha256: frozen.npm.tarballSha256,
            label: 'frozen npm tarball',
          });
          assertInsideAssetRoot(assetRoot, tarball.physical, 'frozen npm tarball');
        }
      }
      await evidence.append({ phase: 'safety-gate', gate: 'frozen-artifacts', status: 'passed' });
    }

    // =======================================================================
    // Safety Gates 3-7: Load and validate approval record (shared)
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'approval-load', status: 'started' });

    let approvalRaw;
    try {
      approvalRaw = await readFile(approvalPath, 'utf8');
    } catch (err) {
      throw new ReleaseError(
        GATE_FAILED,
        `cannot read approval record: ${err.message}`,
        { approvalPath, cause: err.code },
      );
    }

    let approval;
    try {
      approval = JSON.parse(approvalRaw);
    } catch (err) {
      throw new ReleaseError(
        GATE_FAILED,
        `approval record is not valid JSON: ${err.message}`,
        { approvalPath },
      );
    }

    validateApproval(plan, approval, { clock: clockFn });

    await evidence.append({ phase: 'safety-gate', gate: 'approval-validated', status: 'passed' });

    // =======================================================================
    // Safety Gate 8: Action type adapter availability
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'adapter-availability', status: 'started' });

    for (const action of plan.externalActions) {
      const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];
      if (!adapterActionType) {
        // write-remote-identifier and unknown types are handled at checkpoint time
        continue;
      }
      // Verify adapter exists for this action type
      try {
        adapterRegistry.getAdapter(adapterActionType);
      } catch {
        throw new ReleaseError(
          GATE_FAILED,
          `no adapter registered for action type "${adapterActionType}" (plan action "${action.id}")`,
          { actionId: action.id, adapterActionType },
        );
      }
    }

    await evidence.append({ phase: 'safety-gate', gate: 'adapter-availability', status: 'passed' });

    // =======================================================================
    // Safety Gate 9: Baseline comparison
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'baseline-check', status: 'started' });

    const currentBaseline = await captureBaselineActual(root);

    if (currentBaseline.gitTreeHash !== plan.baseline.gitTreeHash) {
      await evidence.append({
        phase: 'safety-gate',
        gate: 'baseline-check',
        status: 'failed',
        planTreeHash: plan.baseline.gitTreeHash,
        currentTreeHash: currentBaseline.gitTreeHash,
      });

      // BASELINE_CHANGED: zero adapter execute calls guaranteed
      throw new ReleaseError(
        BASELINE_CHANGED,
        `baseline has changed since plan freeze: plan=${plan.baseline.gitTreeHash}, current=${currentBaseline.gitTreeHash}`,
        { planTreeHash: plan.baseline.gitTreeHash, currentTreeHash: currentBaseline.gitTreeHash },
      );
    }

    if (
      plan.baseline.workspaceDigest &&
      currentBaseline.workspaceDigest !== plan.baseline.workspaceDigest
    ) {
      await evidence.append({
        phase: 'safety-gate',
        gate: 'baseline-check',
        status: 'failed',
        planWorkspaceDigest: plan.baseline.workspaceDigest,
        currentWorkspaceDigest: currentBaseline.workspaceDigest,
      });

      throw new ReleaseError(
        BASELINE_CHANGED,
        `workspace digest has changed since plan freeze: plan=${plan.baseline.workspaceDigest}, current=${currentBaseline.workspaceDigest}`,
        { planWorkspaceDigest: plan.baseline.workspaceDigest, currentWorkspaceDigest: currentBaseline.workspaceDigest },
      );
    }

    await evidence.append({
      phase: 'safety-gate',
      gate: 'baseline-check',
      status: 'passed',
      gitTreeHash: currentBaseline.gitTreeHash,
    });

    // =======================================================================
    // All safety gates passed -- prepare for execution
    // =======================================================================
    if (isProductionPlan && plan.status === 'PREPARED') {
      assertTransition('PREPARED', 'APPROVED');
      assertTransition('APPROVED', PUBLISHING);
    } else {
      assertTransition(plan.status, PUBLISHING);
    }

    // Deep-clone the plan for mutation
    const publishingPlan = deepClone(plan);
    publishingPlan.status = PUBLISHING;

    // Sort actions by checkpoint order
    const orderedActions = (publishingPlan.externalActions ?? []).slice().sort((a, b) => {
      const ai = CHECKPOINT_ORDER.indexOf(a.type);
      const bi = CHECKPOINT_ORDER.indexOf(b.type);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    // =======================================================================
    // Safety Gate 10: Global preflight - validate all actions before any execute
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'global-preflight', status: 'started' });

    for (const action of orderedActions) {
      if (action.type === 'write-remote-identifier') continue;

      const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];
      if (!adapterActionType) continue;

      const adapter = adapterRegistry.getAdapter(adapterActionType);
      const isMarketplace = MARKETPLACE_TYPES.has(action.type);
      const preflightContext = {
        externalWritesAuthorized: false,
        isolatedConsumerWritesAuthorized: isMarketplace,
        plan: publishingPlan,
        baseline: plan.baseline,
        root,
        runDir,
      };
      const preflightResult = await adapter.preflight(
        { actionType: adapterActionType, ...action.parameters },
        preflightContext,
      );
      if (preflightResult.status === 'PREFLIGHT_FAILED') {
        throw new ReleaseError(
          GATE_FAILED,
          `global preflight failed for action "${action.id}": ${preflightResult.error}`,
          { actionId: action.id, actionType: action.type },
        );
      }
    }

    await evidence.append({ phase: 'safety-gate', gate: 'global-preflight', status: 'passed' });

    // =======================================================================
    // Execute checkpoints
    // =======================================================================
    await evidence.append({
      phase: 'publish',
      status: 'started',
      checkpointCount: orderedActions.length,
    });

    const checkpoints = [];
    let stopped = false;

    for (const action of orderedActions) {
      if (stopped) {
        // All actions after failure are PENDING (never executed)
        checkpoints.push({ actionId: action.id, actionType: action.type, status: 'PENDING', error: null });
        action.status = 'PENDING';
        continue;
      }

      await evidence.append({
        phase: 'checkpoint',
        actionId: action.id,
        actionType: action.type,
        status: 'started',
      });

      const isMarketplace = MARKETPLACE_TYPES.has(action.type);
      const actionContext = {
        externalWritesAuthorized: !isMarketplace,
        isolatedConsumerWritesAuthorized: isMarketplace,
        plan: publishingPlan,
        baseline: plan.baseline,
        root,
        runDir,
      };
      const result = await executeCheckpoint(action, adapterRegistry, actionContext);
      checkpoints.push({ ...result, actionType: action.type });

      // Update plan action status
      action.status = result.status;

      await evidence.append({
        phase: 'checkpoint',
        actionId: action.id,
        actionType: action.type,
        status: result.status === 'SUCCEEDED' ? 'completed' : 'failed',
        error: result.error,
      });

      if (result.status === 'FAILED') {
        stopped = true;
      }
    }

    // Determine overall status
    const hasFailure = checkpoints.some((cp) => cp.status === 'FAILED');
    const allSucceeded = checkpoints.every((cp) => cp.status === 'SUCCEEDED');

    let overallStatus;
    if (allSucceeded) {
      overallStatus = PUBLISHED;
      publishingPlan.status = PUBLISHED;
    } else if (hasFailure) {
      overallStatus = PARTIAL;
      publishingPlan.status = PARTIAL;
    } else {
      overallStatus = PUBLISHING;
      publishingPlan.status = PUBLISHING;
    }

    // Assert valid state transition
    assertTransition(PUBLISHING, publishingPlan.status);

    await evidence.append({
      phase: 'publish',
      status: 'completed',
      overallStatus,
      checkpointStatuses: checkpoints.map((cp) => cp.status),
    });

    // Write run state to a SEPARATE release-run.json (plan is immutable).
    const runPath = join(runDir, 'release-run.json');
    const runState = {
      runId,
      command: 'publish',
      planDigest: plan.digest,
      status: overallStatus,
      checkpoints: checkpoints.map((cp, idx) => ({
        actionId: cp.actionId,
        actionType: orderedActions[idx]?.type ?? 'unknown',
        status: cp.status === 'SUCCEEDED' ? 'succeeded'
          : cp.status === 'FAILED' ? 'failed'
          : cp.status === 'PENDING' ? 'pending'
          : 'skipped',
        error: cp.error ? { code: 'GATE_FAILED', message: cp.error } : undefined,
      })),
      startedAt: clockFn(),
      finishedAt: clockFn(),
    };
    await writeRunAtomic(runPath, runState);

    await evidence.finish({
      status: overallStatus,
      planPath,
      runPath,
      checkpointStatuses: checkpoints.map((cp) => cp.status),
      finishedAt: clockFn(),
    });

    return { planPath, runPath, status: overallStatus, checkpoints };
  } catch (err) {
    await evidence.append({
      phase: 'publish',
      status: 'failed',
      error: { code: err.code, message: err.message },
    });

    await evidence.finish({
      status: 'FAILED',
      error: { code: err.code, message: err.message },
      failedAt: clockFn(),
    });

    throw err;
  }
}
