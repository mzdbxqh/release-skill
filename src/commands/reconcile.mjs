/**
 * Reconcile command: idempotent recovery from partial publish.
 *
 * Reads the source run (a publish or prior reconcile run) and the frozen
 * release plan. For each checkpoint in the source run:
 * - SUCCEEDED: re-observe to verify remote state is still consistent.
 * - FAILED/PENDING: observe remote state; if consistent skip, if missing
 *   add to retry list, if conflicting => REMOTE_CONFLICT.
 *
 * Retry actions are validated against the approval record, then preflighted
 * globally before any execute. Each retry execute is followed by observe.
 *
 * Invariants:
 * - SUCCEEDED actions are never re-executed (only re-observed)
 * - Remote state conflict => REMOTE_CONFLICT (never blindly overwrite)
 * - All retry preflight must pass before first retry execute
 * - Every retry execute is followed by observe
 * - PARTIAL => PUBLISHED when all external actions are consistent
 * - A separate verify run performs fresh npm/plugin consumer installs and is
 *   the only command that may promote PUBLISHED to VERIFIED
 * - New run includes sourceRunId; source run and plan are never modified
 *
 * @module commands/reconcile
 */

import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { computePlanDigest, validatePlan, validatePlanActionCompleteness } from '../core/plan.mjs';
import { validateApproval } from '../core/approval.mjs';
import { captureBaseline } from '../core/baseline.mjs';
import { createEvidenceWriter } from '../core/evidence.mjs';
import {
  loadRun,
  validateRunPlanDigest,
  validateRunCheckpointMapping,
  writeRunAtomic,
} from '../core/run.mjs';
import {
  ReleaseError,
  GATE_FAILED,
  BASELINE_CHANGED,
  REMOTE_CONFLICT,
  POST_PUBLISH_VERIFY_FAILED,
} from '../core/errors.mjs';
import { assertTransition, PARTIAL, PUBLISHED, BLOCKED } from '../core/state-machine.mjs';
import { matchObservation } from '../adapters/contract.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Checkpoint order for the reconcile saga.
 * Must match publish.mjs.
 */
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
 * Must match publish.mjs.
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

/**
 * Marketplace action types that are reconstructable isolated consumer checks,
 * not permanent remote writes. These use isolatedConsumerWritesAuthorized
 * and don't require externalWritesAuthorized even during retry.
 */
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reconcile a release from a source run.
 *
 * @param {Object} options
 * @param {string} options.planPath - Absolute path to the frozen release plan.
 * @param {string} options.sourceRunPath - Absolute path to the source run (publish or prior reconcile).
 * @param {string} [options.approvalPath] - Path to the approval record (required if any action needs retry).
 * @param {string} [options.productionConfirmation] - Exact plan digest required before retrying production writes.
 * @param {Object} options.adapterRegistry - Adapter registry for action execution.
 * @param {string} [options.runDir] - Evidence directory. Defaults to `<planDir>/runs/reconcile-<ts>`.
 * @param {string} [options.root] - Project root for baseline capture.
 * @param {() => string} [options.clock] - Clock function returning ISO-8601 strings.
 * @param {(root: string) => Promise<Object>} [options.captureBaselineFn] - Injectable baseline capture.
 *
 * @returns {Promise<{ planPath: string, runPath: string, status: string, checkpoints: Object[] }>}
 *
 * @throws {ReleaseError} GATE_FAILED on safety gate failures.
 * @throws {ReleaseError} BASELINE_CHANGED if the baseline has changed since freeze.
 * @throws {ReleaseError} REMOTE_CONFLICT if remote state is inconsistent with the plan.
 */
export async function reconcileRelease(options) {
  const {
    planPath,
    sourceRunPath,
    approvalPath,
    adapterRegistry,
    runDir: runDirOpt,
    root = process.cwd(),
    clock: clockOpt,
    captureBaselineFn,
    productionConfirmation,
  } = options ?? {};

  const clockFn = typeof clockOpt === 'function' ? clockOpt : defaultClock;
  const captureBaselineActual =
    typeof captureBaselineFn === 'function' ? captureBaselineFn : captureBaseline;

  // --- Gate: sourceRunPath is required ---
  if (!sourceRunPath) {
    throw new ReleaseError(
      GATE_FAILED,
      'reconcile requires a source run path (--run)',
      { parameter: 'sourceRunPath' },
    );
  }

  // --- Set up directories ---
  const runId = `reconcile-${Date.now()}`;
  const runDir = runDirOpt ?? `${planPath.replace(/release-plan\.json$/, '')}runs/${runId}`;
  await mkdir(runDir, { recursive: true });

  const evidence = createEvidenceWriter({ runDir, command: 'reconcile', clock: clockFn });

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

    // =======================================================================
    // Safety Gate 3: Load and validate source run
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'source-run-load', status: 'started' });

    const sourceRun = await loadRun(sourceRunPath);
    validateRunPlanDigest(sourceRun, plan);
    validateRunCheckpointMapping(sourceRun, plan.externalActions ?? []);

    await evidence.append({
      phase: 'safety-gate',
      gate: 'source-run-load',
      status: 'passed',
      sourceRunId: sourceRun.runId,
    });

    // =======================================================================
    // Safety Gate 4: Baseline comparison
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
    // Load approval if provided (needed for retrying actions)
    // =======================================================================
    let approval = null;
    if (approvalPath) {
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

      try {
        approval = JSON.parse(approvalRaw);
      } catch (err) {
        throw new ReleaseError(
          GATE_FAILED,
          `approval record is not valid JSON: ${err.message}`,
          { approvalPath },
        );
      }
    }

    // =======================================================================
    // Safety Gate 5: Adapter availability for all plan action types
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'adapter-availability', status: 'started' });

    for (const action of plan.externalActions ?? []) {
      const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];
      if (!adapterActionType) continue;
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
    // Map source run checkpoints to plan actions
    // =======================================================================
    const planActions = (plan.externalActions ?? []).slice().sort((a, b) => {
      const ai = CHECKPOINT_ORDER.indexOf(a.type);
      const bi = CHECKPOINT_ORDER.indexOf(b.type);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    // Build a map from actionId -> source run checkpoint
    const sourceCpMap = new Map();
    for (const cp of sourceRun.checkpoints) {
      sourceCpMap.set(cp.actionId, cp);
    }

    await evidence.append({
      phase: 'reconcile',
      status: 'started',
      actionCount: planActions.length,
      sourceRunId: sourceRun.runId,
    });

    const context = {
      externalWritesAuthorized: false,
      plan,
      baseline: plan.baseline,
      root,
      runDir,
    };

    // --- Phase 1: Process each plan action using source run checkpoint ---
    //
    // Marketplace actions are reconstructable isolated consumer checks, not
    // permanent remote writes. They are handled with a fresh
    // preflight -> execute -> verify cycle in an isolated directory, using
    // isolatedConsumerWritesAuthorized instead of externalWritesAuthorized.
    //
    // Non-marketplace actions use observe-based consistency checks.
    // =======================================================================
    const actionsToRetry = [];
    const actionResults = new Map(); // actionId -> final status
    let retryFailed = false;

    for (const action of planActions) {
      const sourceCp = sourceCpMap.get(action.id);
      const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];

      if (!adapterActionType) {
        // Meta-checkpoint, skip
        actionResults.set(action.id, 'skipped');
        continue;
      }

      const adapter = adapterRegistry.getAdapter(adapterActionType);

      // -------------------------------------------------------------------
      // Marketplace actions: isolated consumer verification
      // -------------------------------------------------------------------
      if (MARKETPLACE_TYPES.has(action.type)) {
        const marketplaceContext = {
          externalWritesAuthorized: false,
          isolatedConsumerWritesAuthorized: true,
          plan,
          baseline: plan.baseline,
          root,
          runDir,
        };

        const actionInput = {
          actionType: adapterActionType,
          ...action.parameters,
        };

        // Preflight (always runs — validates frozen snapshot)
        const preflightResult = await adapter.preflight(actionInput, marketplaceContext);
        if (preflightResult.status === 'PREFLIGHT_FAILED') {
          actionResults.set(action.id, 'failed');
          await evidence.append({
            phase: 'reconcile-marketplace',
            actionId: action.id,
            actionType: action.type,
            decision: 'preflight-failed',
            error: preflightResult.error,
          });
          throw new ReleaseError(
            POST_PUBLISH_VERIFY_FAILED,
            `marketplace preflight failed for action "${action.id}": ${preflightResult.error}`,
            { actionId: action.id },
          );
        }

        // Execute (install to isolated consumer directory)
        const executeResult = await adapter.execute(actionInput, marketplaceContext);
        if (executeResult.status !== 'EXECUTED') {
          actionResults.set(action.id, 'failed');
          await evidence.append({
            phase: 'reconcile-marketplace',
            actionId: action.id,
            actionType: action.type,
            decision: 'execute-failed',
            error: executeResult.error,
          });
          // Execute failed — if source was succeeded this is a conflict;
          // if source was failed/pending, add to retry list
          if (sourceCp.status === 'succeeded') {
            throw new ReleaseError(
              REMOTE_CONFLICT,
              `marketplace execute failed for SUCCEEDED action "${action.id}": ${executeResult.error}`,
              { actionId: action.id },
            );
          }
          actionsToRetry.push(action);
          continue;
        }

        // Verify (observe + match against plan expected state)
        const verifyResult = await adapter.verify(
          { ...actionInput, expected: action.expected },
          marketplaceContext,
        );

        if (verifyResult.status === 'VERIFIED') {
          // Consistent: source succeeded => skipped, source failed => succeeded (recovered)
          const resultStatus = sourceCp.status === 'succeeded' ? 'skipped' : 'succeeded';
          actionResults.set(action.id, resultStatus);
          await evidence.append({
            phase: 'reconcile-marketplace',
            actionId: action.id,
            actionType: action.type,
            decision: sourceCp.status === 'succeeded' ? 'skip-source-succeeded-consistent' : 'recovered',
            sourceStatus: sourceCp.status,
          });
        } else {
          // Verify mismatch
          await evidence.append({
            phase: 'reconcile-marketplace',
            actionId: action.id,
            actionType: action.type,
            decision: 'verify-mismatch',
            error: verifyResult.error,
          });
          if (sourceCp.status === 'succeeded') {
            throw new ReleaseError(
              REMOTE_CONFLICT,
              `marketplace verify mismatch for SUCCEEDED action "${action.id}": ${verifyResult.error}`,
              { actionId: action.id },
            );
          }
          // Source was failed/pending and verify mismatched after retry => BLOCKED
          actionResults.set(action.id, 'failed');
          retryFailed = true;
          // Don't add to retry — this is a verify mismatch, not a missing state
        }
        continue;
      }

      // -------------------------------------------------------------------
      // Non-marketplace actions: observe-based consistency checks
      // -------------------------------------------------------------------

      if (sourceCp.status === 'succeeded') {
        // SUCCEEDED: re-observe to verify remote state is still consistent
        const observeResult = await adapter.observe(
          { actionType: adapterActionType, ...action.parameters },
          context,
        );

        if (action.expected) {
          if (
            !observeResult.observation ||
            (observeResult.error && Object.keys(observeResult.observation).length === 0)
          ) {
            // Adapter could not produce an observation — not a conflict, but
            // cannot verify consistency. Treat as needing retry.
            actionResults.set(action.id, 'failed');
            actionsToRetry.push(action);
            await evidence.append({
              phase: 'reconcile-observe',
              actionId: action.id,
              actionType: action.type,
              decision: 'observe-returned-null',
            });
            continue;
          }

          const { matches, mismatches } = matchObservation(
            action.expected,
            observeResult.observation,
          );

          if (!matches) {
            await evidence.append({
              phase: 'reconcile-observe',
              actionId: action.id,
              actionType: action.type,
              decision: 'remote-conflict',
              mismatches,
            });

            throw new ReleaseError(
              REMOTE_CONFLICT,
              `Remote state conflict for SUCCEEDED action "${action.id}": ${mismatches.join('; ')}`,
              { actionId: action.id, mismatches },
            );
          }
        }

        actionResults.set(action.id, 'succeeded');
        await evidence.append({
          phase: 'reconcile-observe',
          actionId: action.id,
          actionType: action.type,
          decision: 'skip-succeeded-verified',
        });
        continue;
      }

      // FAILED or PENDING: observe remote state
      const observeResult = await adapter.observe(
        { actionType: adapterActionType, ...action.parameters },
        context,
      );

      if (
        !observeResult.observation ||
        (observeResult.error && Object.keys(observeResult.observation).length === 0)
      ) {
        actionsToRetry.push(action);
        await evidence.append({
          phase: 'reconcile-observe',
          actionId: action.id,
          actionType: action.type,
          decision: 'retry-after-empty-observation',
          error: observeResult.error ?? null,
        });
        continue;
      }

      // Check if remote already has the expected state
      if (observeResult.observation && action.expected) {
        const { matches, mismatches } = matchObservation(
          action.expected,
          observeResult.observation,
        );

        if (matches) {
          actionResults.set(action.id, 'skipped');
          await evidence.append({
            phase: 'reconcile-observe',
            actionId: action.id,
            actionType: action.type,
            decision: 'skip-remote-consistent',
          });
          continue;
        }

        // Remote state exists but doesn't match: REMOTE_CONFLICT
        await evidence.append({
          phase: 'reconcile-observe',
          actionId: action.id,
          actionType: action.type,
          decision: 'remote-conflict',
          mismatches,
        });

        throw new ReleaseError(
          REMOTE_CONFLICT,
          `Remote state conflict for action "${action.id}": ${mismatches.join('; ')}`,
          { actionId: action.id, mismatches },
        );
      }

      // No expected observation or no remote state: needs retry
      actionsToRetry.push(action);
      await evidence.append({
        phase: 'reconcile-observe',
        actionId: action.id,
        actionType: action.type,
        decision: 'retry',
      });
    }

    // --- Phase 2: Validate approval and global preflight before retrying ---
    //
    // Marketplace actions in the retry list do NOT require approval or
    // productionConfirmation; they are isolated consumer checks, not
    // permanent remote writes. Only non-marketplace retries require approval.
    // =======================================================================
    // Split retry actions into marketplace and non-marketplace
    const marketplaceRetries = actionsToRetry.filter((a) => MARKETPLACE_TYPES.has(a.type));
    const nonMarketplaceRetries = actionsToRetry.filter((a) => !MARKETPLACE_TYPES.has(a.type));

    if (nonMarketplaceRetries.length > 0) {
      // Non-marketplace retries require approval and productionConfirmation
      if (
        plan.production?.mode === 'github-npm-v1' &&
        productionConfirmation !== actualDigest
      ) {
        throw new ReleaseError(
          GATE_FAILED,
          'production reconcile confirmation must exactly match the current plan digest before retry',
          { planDigest: actualDigest, actionsToRetry: nonMarketplaceRetries.map((action) => action.id) },
        );
      }
      if (!approval) {
        throw new ReleaseError(
          GATE_FAILED,
          'approval record is required when actions need retry but none was provided',
          { actionsToRetry: nonMarketplaceRetries.map((a) => a.id) },
        );
      }

      validateApproval(plan, approval, { clock: clockFn });
      context.externalWritesAuthorized = true;

      await evidence.append({
        phase: 'reconcile-approval',
        status: 'validated',
        retryActionCount: nonMarketplaceRetries.length,
      });
    }

    if (actionsToRetry.length > 0) {
      // Global preflight: validate ALL retry actions before any execute
      await evidence.append({ phase: 'reconcile-preflight', status: 'started' });

      for (const action of actionsToRetry) {
        const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];
        const adapter = adapterRegistry.getAdapter(adapterActionType);

        // Use appropriate context for each action type
        const preflightCtx = MARKETPLACE_TYPES.has(action.type)
          ? { ...context, externalWritesAuthorized: false, isolatedConsumerWritesAuthorized: true }
          : context;

        const preflightResult = await adapter.preflight(
          { actionType: adapterActionType, ...action.parameters },
          preflightCtx,
        );

        if (preflightResult.status === 'PREFLIGHT_FAILED') {
          // Mark all retry actions as failed, stop
          for (const retryAction of actionsToRetry) {
            actionResults.set(retryAction.id, 'failed');
          }
          retryFailed = true;

          await evidence.append({
            phase: 'reconcile-preflight',
            status: 'failed',
            actionId: action.id,
            error: preflightResult.error,
          });
          break;
        }
      }

      if (!retryFailed) {
        await evidence.append({ phase: 'reconcile-preflight', status: 'passed' });
      }
    }

    // --- Phase 3: Execute retries ---
    if (!retryFailed && actionsToRetry.length > 0) {
      for (const action of actionsToRetry) {
        const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];
        const adapter = adapterRegistry.getAdapter(adapterActionType);

        // Use appropriate context: marketplace uses isolated consumer writes,
        // non-marketplace uses external writes
        const retryCtx = MARKETPLACE_TYPES.has(action.type)
          ? { ...context, externalWritesAuthorized: false, isolatedConsumerWritesAuthorized: true }
          : context;

        await evidence.append({
          phase: 'reconcile-retry',
          actionId: action.id,
          actionType: action.type,
          status: 'started',
        });

        // Execute
        const executeResult = await adapter.execute(
          { actionType: adapterActionType, ...action.parameters },
          retryCtx,
        );

        if (executeResult.status === 'EXECUTED') {
          // Must verify after execute to check remote/install state
          if (MARKETPLACE_TYPES.has(action.type)) {
            // Marketplace: verify via adapter.verify (observe + matchObservation)
            const verifyResult = await adapter.verify(
              { actionType: adapterActionType, ...action.parameters, expected: action.expected },
              retryCtx,
            );

            if (verifyResult.status !== 'VERIFIED') {
              actionResults.set(action.id, 'failed');
              retryFailed = true;
              await evidence.append({
                phase: 'reconcile-retry',
                actionId: action.id,
                actionType: action.type,
                status: 'verify-mismatch',
                error: verifyResult.error,
              });
              break;
            }
          } else {
            // Non-marketplace: observe after execute to verify remote state
            let observation;
            try {
              const observeResult = await adapter.observe(
                { actionType: adapterActionType, ...action.parameters, expected: action.expected },
                retryCtx,
              );
              observation = observeResult.observation;
            } catch {
              actionResults.set(action.id, 'failed');
              retryFailed = true;
              await evidence.append({
                phase: 'reconcile-retry',
                actionId: action.id,
                actionType: action.type,
                status: 'observe-failed',
                error: 'observe call failed after retry execute',
              });
              break;
            }

            // Check observation mismatch
            if (action.expected) {
              const { matches } = matchObservation(action.expected, observation);
              if (!matches) {
                actionResults.set(action.id, 'failed');
                retryFailed = true;
                await evidence.append({
                  phase: 'reconcile-retry',
                  actionId: action.id,
                  actionType: action.type,
                  status: 'observe-mismatch',
                  error: 'observation does not match expected after retry execute',
                });
                break;
              }
            } else if (observation && observation.mismatched) {
              actionResults.set(action.id, 'failed');
              retryFailed = true;
              await evidence.append({
                phase: 'reconcile-retry',
                actionId: action.id,
                actionType: action.type,
                status: 'observe-mismatch',
                error: 'observation indicates mismatch after retry execute',
              });
              break;
            }
          }

          actionResults.set(action.id, 'succeeded');
          await evidence.append({
            phase: 'reconcile-retry',
            actionId: action.id,
            actionType: action.type,
            status: 'completed',
          });
        } else {
          actionResults.set(action.id, 'failed');
          retryFailed = true;

          await evidence.append({
            phase: 'reconcile-retry',
            actionId: action.id,
            actionType: action.type,
            status: 'failed',
            error: executeResult.error,
          });
          break;
        }
      }
    }

    // Mark remaining retry actions as pending if we stopped early
    if (retryFailed) {
      let foundFailed = false;
      for (const action of actionsToRetry) {
        if (actionResults.get(action.id) === 'failed') {
          foundFailed = true;
          continue;
        }
        if (foundFailed) {
          actionResults.set(action.id, 'pending');
        }
      }
    }

    // =======================================================================
    // Determine final status
    // =======================================================================
    const allSucceeded = planActions.every(
      (a) => {
        const result = actionResults.get(a.id);
        return result === 'succeeded' || result === 'skipped';
      },
    );

    // Determine effective starting status based on source run
    const sourceStatus = sourceRun.status;
    const effectiveFromStatus = sourceStatus === 'PUBLISHED' || sourceStatus === 'VERIFIED'
      ? PUBLISHED
      : PARTIAL;

    // Map reconcile outcome to state machine target
    let overallStatus;
    if (allSucceeded && !retryFailed) {
      overallStatus = PUBLISHED;
    } else if (retryFailed) {
      // Retry failed: target is BLOCKED (needs human intervention)
      overallStatus = BLOCKED;
    } else {
      // All remote checkpoints are consistent, but installation smoke still
      // belongs to the separate verify command.
      overallStatus = PUBLISHED;
    }

    // Only validate state transition if status actually changes
    if (effectiveFromStatus !== overallStatus) {
      assertTransition(effectiveFromStatus, overallStatus);
    }

    await evidence.append({
      phase: 'reconcile',
      status: 'completed',
      overallStatus,
      actionStatuses: planActions.map((a) => actionResults.get(a.id)),
    });

    // Build checkpoints for return value and run file
    const resultCheckpoints = planActions.map((a) => {
      const status = actionResults.get(a.id) ?? 'pending';
      return {
        actionId: a.id,
        status: status === 'succeeded' ? 'succeeded'
          : status === 'failed' ? 'failed'
          : status === 'skipped' ? 'skipped'
          : 'pending',
      };
    });

    // Write new reconcile run with sourceRunId
    const runPath = join(runDir, 'release-run.json');
    const runState = {
      runId,
      command: 'reconcile',
      planDigest: plan.digest,
      sourceRunId: sourceRun.runId,
      status: overallStatus,
      checkpoints: planActions.map((a) => {
        const status = actionResults.get(a.id) ?? 'pending';
        return {
          actionId: a.id,
          actionType: a.type,
          status: status === 'succeeded' ? 'succeeded'
            : status === 'failed' ? 'failed'
            : status === 'skipped' ? 'skipped'
            : 'pending',
        };
      }),
      startedAt: clockFn(),
      finishedAt: clockFn(),
    };
    await writeRunAtomic(runPath, runState);

    await evidence.finish({
      status: overallStatus,
      planPath,
      runPath,
      sourceRunId: sourceRun.runId,
      actionStatuses: planActions.map((a) => actionResults.get(a.id)),
      completedAt: clockFn(),
    });

    return { planPath, runPath, status: overallStatus, checkpoints: resultCheckpoints };
  } catch (err) {
    await evidence.append({
      phase: 'reconcile',
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
