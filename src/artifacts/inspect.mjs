/**
 * Artifact inspection and initialization (read-only).
 *
 * Provides:
 * - `inspectArtifacts({ root, scope, output, mode })` — capture base/current/candidate
 *   and compute an artifact plan with `nextAction`.
 * - `initArtifacts({ root, output })` — dry-run bootstrap: detect drift between
 *   policy-declared artifacts and current worktree, produce a plan that
 *   references `artifacts adopt --bootstrap-plan`.
 *
 * Both functions are strictly read-only with respect to inventory targets:
 * - They never write to artifact paths in the worktree.
 * - They only write a plan file to `.release-skill/runs/` or an explicit `--output`.
 * - `targetUnchanged` is always `true`.
 *
 * @module artifacts/inspect
 */

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ReleaseError,
  ARTIFACT_POLICY_INVALID,
  DIRTY_SCOPE_CONFLICT,
  PATH_UNSAFE,
  PLAN_STALE,
} from '../core/errors.mjs';
import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import { loadArtifactPolicy } from './policy.mjs';
import { buildInventory } from './inventory.mjs';
import { readEntry, digestEntryManifest } from './entry.mjs';
import { buildProducerGraph } from './graph.mjs';
import { createBuiltInProducerRegistry, runProducerClosure } from './producer-registry.mjs';
import { readRepositoryIdentity } from './git-authority.mjs';
import { classifyArtifact } from './state.mjs';
import { assemblePlan, writePlan } from './artifact-plan.mjs';
import {
  mergeEntry, mergeText, mergeTree,
  mergeMarkdown, mergeJson, mergeYaml,
} from './merge/entry-merge.mjs';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check if a directory contains a nested git root (other than the top-level one).
 *
 * Nested git roots in the inventory signal a configuration error.
 * Uses `git ls-tree -r --name-only HEAD` to find all tracked trees, then
 * checks each for a `.git` subdirectory.
 *
 * @param {string} root - Repository root.
 * @returns {Promise<boolean>} True if nested git roots are found.
 */
async function hasNestedGitRoots(root) {
  try {
    // Get all tracked tree paths from HEAD
    const { stdout } = await execFileAsync(
      'git',
      ['ls-tree', '-r', '-d', '--name-only', 'HEAD'],
      { cwd: root, shell: false, maxBuffer: 50 * 1024 * 1024 },
    );
    const dirs = stdout.split('\n').filter((s) => s.length > 0);
    for (const dir of dirs) {
      const absDir = join(root, dir);
      try {
        const nestedGit = join(absDir, '.git');
        await stat(nestedGit);
        return true; // Found a nested .git directory
      } catch {
        // No .git in this directory — OK
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if the working tree has partially staged artifact entries.
 *
 * A partial stage occurs when some files are staged but not committed,
 * and some artifact files have uncommitted modifications.
 *
 * @param {string} root - Repository root.
 * @returns {Promise<boolean>} True if partially staged entries exist.
 */
async function hasPartialStage(root) {
  try {
    // Check for staged changes (index vs HEAD)
    const { stdout: staged } = await execFileAsync(
      'git',
      ['diff', '--cached', '--name-only', '-z'],
      { cwd: root, shell: false },
    );
    const hasStaged = staged.split('\0').filter((s) => s.length > 0).length > 0;

    // Check for unstaged changes (working tree vs index)
    const { stdout: unstaged } = await execFileAsync(
      'git',
      ['diff', '--name-only', '-z'],
      { cwd: root, shell: false },
    );
    const hasUnstaged = unstaged.split('\0').filter((s) => s.length > 0).length > 0;

    // Partial stage = staged AND unstaged changes
    return hasStaged && hasUnstaged;
  } catch {
    return false;
  }
}

/**
 * Read all policy-declared artifact entries from the worktree.
 *
 * For each declared artifact in the policy, reads the entry at `sourcePath`
 * from the worktree. Returns a map of artifact ID → entry.
 *
 * @param {string} root - Repository root.
 * @param {object} policy - Validated artifact policy.
 * @returns {Promise<Map<string, object>>} Map of artifact ID → entry.
 */
async function readDeclaredEntries(root, policy) {
  const result = new Map();
  for (const artifact of policy.artifacts ?? []) {
    if (artifact.type === 'declared' && artifact.sourcePath) {
      const entry = await readEntry({ root, path: artifact.sourcePath, source: 'worktree' });
      result.set(artifact.id, entry);
    }
  }
  return result;
}

/**
 * Compute the current manifest digest from worktree entries.
 *
 * @param {Map<string, object>} entries - Map of artifact ID → entry.
 * @returns {string} Manifest digest string.
 */
function computeCurrentManifestDigest(entries) {
  const entryList = [];
  for (const [id, entry] of entries) {
    if (entry.kind === 'absent') {
      entryList.push({ path: id, type: 'absent', mode: '', sha256: '', size: 0 });
    } else if (entry.kind === 'regular') {
      entryList.push({
        path: entry.path ?? id,
        type: entry.type,
        mode: entry.mode,
        sha256: entry.sha256,
        size: entry.size,
      });
    } else if (entry.kind === 'tree') {
      // Use manifestDigest for tree entries
      entryList.push({
        path: id,
        type: 'tree',
        mode: '040000',
        sha256: entry.manifestDigest ?? '',
        size: 0,
      });
    }
  }
  return digestEntryManifest(entryList);
}

/**
 * Compute the producer closure digest for the policy's generated artifacts.
 *
 * If no generated artifacts exist, returns a stable empty digest.
 *
 * @param {object} policy - Validated artifact policy.
 * @returns {Promise<string>} Producer closure digest.
 */
async function computeProducerClosureDigest(policy) {
  const generatedArtifacts = (policy.artifacts ?? []).filter((a) => a.type === 'generated');
  if (generatedArtifacts.length === 0) {
    // No generated artifacts — return stable empty digest
    return `sha256:${sha256Hex(canonicalJson({ generated: 0 }))}`;
  }

  try {
    const registry = await createBuiltInProducerRegistry();
    const graph = buildProducerGraph(policy, registry);
    const digests = [];
    for (const id of graph.topologicalOrder) {
      const entry = registry.get(graph.producerOf(id));
      if (entry) digests.push(entry.implementationDigest);
    }
    return `sha256:${sha256Hex(canonicalJson(digests.sort()))}`;
  } catch {
    // Registry or graph creation failed — return fallback
    return `sha256:${sha256Hex(canonicalJson({ generated: generatedArtifacts.length, error: true }))}`;
  }
}

/**
 * Classify each artifact against the inventory and produce decisions.
 *
 * For `init` mode, uses a simplified classification that focuses on
 * whether bootstrap artifacts exist and match their declared content.
 *
 * @param {Map<string, object>} currentEntries - Current worktree entries.
 * @param {object} policy - Validated artifact policy.
 * @param {'inspect'|'init'|'status'} mode - Operation mode.
 * @returns {Array<object>} Artifact decisions.
 */
function classifyArtifacts(currentEntries, policy, mode) {
  const decisions = [];
  const emptyBase = { kind: 'absent' };

  for (const artifact of policy.artifacts ?? []) {
    const current = currentEntries.get(artifact.id) ?? { kind: 'absent' };
    const ownership = artifact.ownership ?? policy.inventory?.defaultOwnership ?? 'human';

    const decision = classifyArtifact({
      base: emptyBase,
      current,
      generated: emptyBase,
      ownership,
    });

    decisions.push(Object.freeze({
      id: artifact.id,
      type: artifact.type,
      path: artifact.sourcePath,
      status: decision.status,
      safeToWrite: decision.safeToWrite,
      allowedActions: decision.allowedActions,
      priority: decision.priority,
    }));
  }

  return decisions;
}

/**
 * Determine the overall plan status from individual artifact decisions.
 *
 * @param {Array<object>} decisions - Artifact decisions.
 * @param {'inspect'|'init'|'status'} mode - Operation mode.
 * @returns {string} Overall status.
 */
function determineOverallStatus(decisions, mode) {
  if (mode === 'init') {
    // Init mode: check if any artifact has drifted
    const hasDrift = decisions.some(
      (d) => d.status !== 'CLEAN' && d.status !== 'NEW',
    );
    return hasDrift ? 'BOOTSTRAP_DERIVED_DRIFT' : 'CLEAN';
  }

  // Inspect/status mode: any blocking status takes precedence
  const BLOCKING = new Set([
    'BASE_UNAVAILABLE', 'POLICY_INVALID', 'POLICY_CHANGE_PENDING',
    'ISOLATION_UNAVAILABLE', 'PATH_UNSAFE', 'PRODUCER_SCOPE_VIOLATION',
    'PRODUCER_NONDETERMINISTIC', 'STRUCTURE_INVALID', 'CONFLICT',
    'ADOPTION_REQUIRED',
  ]);

  const blocking = decisions.find((d) => BLOCKING.has(d.status));
  if (blocking) return blocking.status;

  // Check for drift
  const needsAction = decisions.some(
    (d) => d.status !== 'CLEAN',
  );
  return needsAction ? 'ASSESSED' : 'CLEAN';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect artifacts: capture base/current/candidate and compute an artifact plan.
 *
 * This is a read-only operation:
 * - Does not write to any inventory target.
 * - Does not create an artifact-lock.
 * - Optionally writes the plan to `output` or `.release-skill/runs/`.
 *
 * @param {object} options
 * @param {string} options.root - Repository root (absolute).
 * @param {string} [options.scope] - Scope filter for artifacts (reserved).
 * @param {string} [options.output] - Explicit path to write the plan.
 * @param {'inspect'|'init'|'status'} [options.mode='inspect'] - Operation mode.
 * @returns {Promise<ArtifactPlanResult>}
 */
export async function inspectArtifacts({
  root,
  scope,
  output,
  mode = 'inspect',
} = {}) {
  const inputs = await captureInspectInputs({ root });
  const result = inspectFromInputs({ inputs, mode });
  if (output) {
    await writePlan(result.plan, output);
  }
  const runId = `inspect-${Date.now().toString(36)}`;
  const evidenceDir = `.release-skill/runs/${runId}`;
  return Object.freeze({ ...result, evidenceDir });
}

// ---------------------------------------------------------------------------
// Phase functions for short-lock pattern
// ---------------------------------------------------------------------------

/**
 * Phase 1: Capture all immutable inputs from the repository.
 *
 * Reads policy, identity, inventory, and current artifact entries.
 * This is the step that must run under the project lock to ensure
 * a consistent snapshot.
 *
 * @param {object} options
 * @param {string} options.root - Repository root (absolute).
 * @returns {Promise<InspectInputs>} Frozen inputs snapshot.
 */
export async function captureInspectInputs({ root } = {}) {
  const { policy, policyDigest } = await loadArtifactPolicy({ root });
  const identity = await readRepositoryIdentity(root);
  const inventory = await buildInventory({ root, policy });
  const currentEntries = await readDeclaredEntries(root, policy);
  const currentManifestDigest = computeCurrentManifestDigest(currentEntries);
  const baseManifestDigest = `sha256:${sha256Hex(canonicalJson({ empty: true }))}`;
  const producerClosureDigest = await computeProducerClosureDigest(policy);

  return Object.freeze({
    root,
    policy,
    policyDigest,
    identity,
    inventory,
    currentEntries,
    currentManifestDigest,
    baseManifestDigest,
    producerClosureDigest,
    capturedAt: new Date().toISOString(),
  });
}

/**
 * Phase 2: Classify artifacts and assemble the plan from captured inputs.
 *
 * This is a pure computation step that can run without the project lock.
 * No filesystem reads are performed.
 *
 * @param {object} options
 * @param {InspectInputs} options.inputs - Captured inputs from Phase 1.
 * @param {'inspect'|'init'|'status'} [options.mode='inspect'] - Operation mode.
 * @returns {object} Plan result (plan, status, safeToWrite, targetUnchanged, nextAction).
 */
export function inspectFromInputs({ inputs, mode = 'inspect' } = {}) {
  const { policy, policyDigest, identity, currentEntries, currentManifestDigest, baseManifestDigest, producerClosureDigest } = inputs;

  const decisions = classifyArtifacts(currentEntries, policy, mode);
  const status = determineOverallStatus(decisions, mode);
  const safeToWrite = decisions.every((d) => d.safeToWrite);
  const plan = assemblePlan({
    operation: mode,
    bindings: {
      repositoryIdentity: identity.remoteUrlHash,
      policyDigest,
      baseManifestDigest,
      currentManifestDigest,
      producerClosureDigest,
    },
    artifacts: decisions,
    safeToWrite,
    targetUnchanged: true,
  });

  return Object.freeze({
    plan,
    status,
    safeToWrite,
    targetUnchanged: true,
    nextAction: plan.nextAction,
  });
}

/**
 * Phase 3: Verify that repository inputs have not drifted since capture.
 *
 * Re-reads the current artifact entries and manifest digest from the
 * repository and compares them against the previously captured inputs.
 * Throws PLAN_STALE if drift is detected.
 *
 * This is the step that must run under the project lock before writing
 * the plan, ensuring no concurrent mutations occurred during the
 * unlocked producer phase.
 *
 * @param {object} options
 * @param {string} options.root - Repository root (absolute).
 * @param {InspectInputs} options.inputs - Previously captured inputs.
 * @returns {Promise<void>}
 * @throws {ReleaseError} PLAN_STALE if inputs have drifted.
 */
export async function verifyInputsUnchanged({ root, inputs } = {}) {
  const { policy } = await loadArtifactPolicy({ root });
  const currentEntries = await readDeclaredEntries(root, policy);
  const currentManifestDigest = computeCurrentManifestDigest(currentEntries);

  if (currentManifestDigest !== inputs.currentManifestDigest) {
    throw new ReleaseError(
      PLAN_STALE,
      'artifact entries changed during inspection — inputs drifted',
      {
        capturedDigest: inputs.currentManifestDigest,
        currentDigest: currentManifestDigest,
      },
    );
  }
}

/**
 * Initialize artifacts: dry-run bootstrap inspection.
 *
 * Detects drift between policy-declared artifacts and the current worktree.
 * Does NOT create an artifact-lock. Only writes to protocol run directory
 * or explicit output path.
 *
 * Key constraints:
 * - Rejects nested git roots (ARTIFACT_POLICY_INVALID).
 * - Rejects partially staged artifact entries (DIRTY_SCOPE_CONFLICT).
 * - `targetUnchanged` is always `true`.
 * - `nextAction` references `artifacts adopt --bootstrap-plan`.
 *
 * @param {object} options
 * @param {string} options.root - Repository root (absolute).
 * @param {string} [options.output] - Explicit path to write the plan.
 * @returns {Promise<ArtifactPlanResult>}
 */
export async function initArtifacts({ root, output } = {}) {
  // 1. Validate: no nested git roots
  if (await hasNestedGitRoots(root)) {
    throw new ReleaseError(
      ARTIFACT_POLICY_INVALID,
      'nested git repositories detected in inventory scope',
      { root },
    );
  }

  // 2. Validate: no partially staged entries
  if (await hasPartialStage(root)) {
    throw new ReleaseError(
      DIRTY_SCOPE_CONFLICT,
      'partially staged artifact entries detected; commit or unstage first',
      { root },
    );
  }

  // 3. Delegate to inspectArtifacts in init mode
  return inspectArtifacts({ root, output, mode: 'init' });
}

// ---------------------------------------------------------------------------
// Merge integration
// ---------------------------------------------------------------------------

/**
 * Re-export merge and adoption APIs for downstream consumers (resolution, CLI).
 *
 * These are the same exports from `merge/entry-merge.mjs` and `adoption.mjs`,
 * surfaced here so that inspect.mjs is the single import point for artifact
 * operations.
 */
export { mergeEntry, mergeText, mergeTree, mergeMarkdown, mergeJson, mergeYaml };
export { planAdoption, discardBootstrapHunk } from './adoption.mjs';

/**
 * Run three-way merge across all artifacts in a plan.
 *
 * For each artifact binding, performs `mergeEntry` using the provided
 * base/current/generated entries and the artifact's declared driver.
 *
 * Returns a map of artifact ID → merge result.  Does NOT write to any
 * artifact target; all results are in-memory candidates.
 *
 * @param {object} options
 * @param {Array<object>} options.bindings - Plan artifact bindings (each with id, driver).
 * @param {Map<string, object>} options.baseEntries - Base entries keyed by artifact ID.
 * @param {Map<string, object>} options.currentEntries - Current entries keyed by artifact ID.
 * @param {Map<string, object>} options.generatedEntries - Generated entries keyed by artifact ID.
 * @returns {Map<string, { status: string, candidate?: object, conflicts?: object[] }>}
 */
export function mergeArtifactEntries({
  bindings,
  baseEntries,
  currentEntries,
  generatedEntries,
} = {}) {
  const results = new Map();

  for (const binding of bindings ?? []) {
    const id = binding.id;
    const driver = binding.driver ?? 'text';
    const base = baseEntries?.get(id) ?? { kind: 'absent' };
    const current = currentEntries?.get(id) ?? { kind: 'absent' };
    const generated = generatedEntries?.get(id) ?? { kind: 'absent' };

    const result = mergeEntry({ base, current, generated, driver });
    results.set(id, Object.freeze({
      status: result.status,
      candidate: result.candidate,
      conflicts: result.conflicts,
    }));
  }

  return Object.freeze(results);
}
