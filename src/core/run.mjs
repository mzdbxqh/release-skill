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

import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve, basename, relative, isAbsolute } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { assertImmutablePlanAuthority, computePlanDigest } from './plan.mjs';
import { sha256Hex } from './digest.mjs';
import { ReleaseError, GATE_FAILED } from './errors.mjs';
import { readTrustedPackageResource } from './trusted-resource.mjs';

const RELEASE_RUN_SCHEMA = JSON.parse((await readTrustedPackageResource(
  'schemas/release-run.schema.json',
)).toString('utf8'));

// ---------------------------------------------------------------------------
// Default runDir resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the default run directory for a command.
 *
 * Handles both `release-plan.json` (legacy) and `plans/<digest>.json`
 * (immutable authority) plan paths:
 * - `release-plan.json` → `<planDir>/runs/<command>-<ts>`
 * - `plans/<digest>.json` → `<releaseDir>/runs/<command>-<ts>` (sibling of plans/)
 *
 * @param {string} planPath - Absolute path to the plan file.
 * @param {string} command - The command name (publish, reconcile, verify).
 * @returns {string} The resolved default run directory.
 */
export function resolveDefaultRunDir(planPath, command, runId = `${command}-${Date.now()}`) {
  const absolute = resolve(planPath);
  const fileName = basename(absolute);
  const parentDir = dirname(absolute);

  if (fileName === 'release-plan.json') {
    // Legacy path: runs inside the same directory
    return `${parentDir}/runs/${runId}`;
  }

  // plans/<digest>.json: resolve to sibling runs/ directory
  if (basename(parentDir) === 'plans') {
    const releaseDir = dirname(parentDir);
    return join(releaseDir, 'runs', runId);
  }

  // Fallback: runs in parent directory
  return `${parentDir}/runs/${runId}`;
}

// ---------------------------------------------------------------------------
// Schema validator (compiled once)
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
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
export function validateRun(run, options = {}) {
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

  const actionIds = new Set();
  for (const checkpoint of run.checkpoints ?? []) {
    if (actionIds.has(checkpoint.actionId)) {
      throw new ReleaseError(
        GATE_FAILED,
        `release run has duplicate checkpoint for action "${checkpoint.actionId}"`,
        { actionId: checkpoint.actionId },
      );
    }
    actionIds.add(checkpoint.actionId);
  }

  if (options.requireDigest === true && !run.runDigest) {
    throw new ReleaseError(GATE_FAILED, 'release run is missing required runDigest');
  }
  if (run.runDigest && run.runDigest !== computeRunDigest(run)) {
    throw new ReleaseError(
      GATE_FAILED,
      'release run digest does not match its content',
      { expected: computeRunDigest(run), actual: run.runDigest },
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
export async function loadRun(runPath, options = {}) {
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

  validateRun(run, options);
  if (options.authorityPlanPath) {
    assertImmutableRunAuthority(runPath, options.authorityPlanPath, run);
  }
  return run;
}

/**
 * Require a production run authority to live below the sibling runs/
 * directory of plans/<digest>.json. Only exclusive final run files and
 * append-only state sequence slots are accepted.
 */
export function assertImmutableRunAuthority(runPath, planPath, run) {
  const absolutePlan = realpathSync(resolve(planPath));
  const planDir = dirname(absolutePlan);
  if (basename(planDir) !== 'plans') {
    throw new ReleaseError(GATE_FAILED, 'run authority requires an immutable plans/<digest>.json plan path');
  }
  let authorityRoot = dirname(planDir);
  let cursor = planDir;
  while (dirname(cursor) !== cursor) {
    if (basename(cursor) === '.release-skill') {
      authorityRoot = cursor;
      break;
    }
    cursor = dirname(cursor);
  }
  const runsDir = join(authorityRoot, 'runs');
  const absoluteRun = realpathSync(resolve(runPath));
  const rel = relative(runsDir, absoluteRun);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new ReleaseError(GATE_FAILED, 'production run authority must be inside the plan sibling runs/ directory');
  }
  const fileName = basename(absoluteRun);
  const isFinal = fileName === 'release-run.json';
  const isState = /^\d{6}\.json$/.test(fileName)
    && basename(dirname(absoluteRun)) === 'states'
    && run.stateSequence === Number(fileName.slice(0, 6));
  if (!isFinal && !isState) {
    throw new ReleaseError(
      GATE_FAILED,
      'production run authority must be release-run.json or a bound states/<sequence>.json snapshot',
      { runPath },
    );
  }
}

/**
 * Create a fresh direct child below the production plan's physical runs/
 * authority. Production commands must call this before writing evidence or
 * authorizing any adapter execute.
 */
export async function createProductionRunDir(runDir, planPath) {
  const absolutePlan = realpathSync(resolve(planPath));
  const planDir = dirname(absolutePlan);
  if (basename(planDir) !== 'plans') {
    throw new ReleaseError(GATE_FAILED, 'production run directory requires an immutable plans/<digest>.json authority');
  }
  const authorityRoot = dirname(planDir);
  return createProductionRunDirWithinAuthority(runDir, authorityRoot);
}

/**
 * Create a fresh production prepare run below a physical .release-skill/
 * authority. Prepare has no immutable plan yet, so it binds directly to the
 * project-owned release directory established by the project lock.
 */
export async function createProductionPrepareRunDir(runDir, releaseDir) {
  const authorityRoot = resolve(releaseDir);
  let authorityStat;
  try {
    authorityStat = await lstat(authorityRoot);
  } catch (error) {
    throw new ReleaseError(GATE_FAILED, 'cannot inspect production .release-skill authority root', {
      releaseDir: authorityRoot,
      cause: error.code,
    });
  }
  if (authorityStat.isSymbolicLink() || !authorityStat.isDirectory()) {
    throw new ReleaseError(
      GATE_FAILED,
      'production .release-skill authority root must be a real directory, not a symlink or special file',
      { releaseDir: authorityRoot },
    );
  }
  const physicalAuthorityRoot = realpathSync(authorityRoot);
  if (physicalAuthorityRoot !== authorityRoot) {
    throw new ReleaseError(
      GATE_FAILED,
      'production .release-skill authority root physical identity does not match the project authority',
      { releaseDir: authorityRoot, physicalReleaseDir: physicalAuthorityRoot },
    );
  }
  return createProductionRunDirWithinAuthority(runDir, physicalAuthorityRoot);
}

async function createProductionRunDirWithinAuthority(runDir, authorityRoot) {
  const runsDir = join(authorityRoot, 'runs');
  let runsStat;
  try {
    runsStat = await lstat(runsDir);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new ReleaseError(GATE_FAILED, 'cannot inspect production runs authority root', {
        runsDir,
        cause: error.code,
      });
    }
    try {
      await mkdir(runsDir, { mode: 0o700 });
    } catch (mkdirError) {
      if (mkdirError.code !== 'EEXIST') {
        throw new ReleaseError(GATE_FAILED, 'cannot create production runs authority root', {
          runsDir,
          cause: mkdirError.code,
        });
      }
    }
    runsStat = await lstat(runsDir);
  }
  if (runsStat.isSymbolicLink() || !runsStat.isDirectory()) {
    throw new ReleaseError(
      GATE_FAILED,
      'production .release-skill/runs authority root must be a real directory, not a symlink or special file',
      { runsDir },
    );
  }
  const physicalRunsDir = realpathSync(runsDir);
  if (physicalRunsDir !== runsDir) {
    throw new ReleaseError(
      GATE_FAILED,
      'production .release-skill/runs authority root physical identity does not match the plan authority',
      { runsDir, physicalRunsDir },
    );
  }
  const requested = resolve(runDir);
  let physicalParent;
  try {
    physicalParent = realpathSync(dirname(requested));
  } catch (error) {
    throw new ReleaseError(GATE_FAILED, 'production run directory parent is unavailable', {
      runDir,
      cause: error.code,
    });
  }
  if (physicalParent !== physicalRunsDir || basename(requested) === '' || basename(requested) === '.' || basename(requested) === '..') {
    throw new ReleaseError(
      GATE_FAILED,
      'production run directory must be a fresh direct child of the immutable .release-skill/runs authority',
      { runDir, runsDir: physicalRunsDir },
    );
  }
  try {
    await lstat(requested);
    throw new ReleaseError(GATE_FAILED, 'production run directory already exists; authority directories cannot be reused', { runDir });
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    if (error.code !== 'ENOENT') {
      throw new ReleaseError(GATE_FAILED, 'cannot establish fresh production run directory', {
        runDir,
        cause: error.code,
      });
    }
  }
  try {
    await mkdir(requested, { mode: 0o700 });
  } catch (error) {
    throw new ReleaseError(GATE_FAILED, 'cannot exclusively create production run directory', {
      runDir,
      cause: error.code,
    });
  }
  const physicalRunDir = realpathSync(requested);
  if (dirname(physicalRunDir) !== physicalRunsDir) {
    throw new ReleaseError(GATE_FAILED, 'production run directory escaped its immutable authority after creation', { runDir });
  }
  return physicalRunDir;
}

async function validateStatePredecessorChain(run, runPath, options = {}) {
  if (run.stateSequence === undefined) {
    if (run.previousStateDigest !== undefined) {
      throw new ReleaseError(GATE_FAILED, 'non-state run cannot claim previousStateDigest');
    }
    return;
  }
  let current = run;
  let currentPath = realpathSync(resolve(runPath));
  let traversed = 0;
  while (true) {
    const sequence = current.stateSequence;
    const expectedName = `${String(sequence).padStart(6, '0')}.json`;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || basename(currentPath) !== expectedName || basename(dirname(currentPath)) !== 'states') {
      throw new ReleaseError(GATE_FAILED, 'run state sequence is not bound to its immutable states/<sequence>.json slot');
    }
    if (sequence === 0) {
      if (current.previousStateDigest !== undefined) {
        throw new ReleaseError(GATE_FAILED, 'initial run state must not claim a predecessor digest');
      }
      return;
    }
    if (!current.previousStateDigest) {
      throw new ReleaseError(GATE_FAILED, 'run state is missing previousStateDigest');
    }
    traversed += 1;
    if (traversed > 100_000) {
      throw new ReleaseError(GATE_FAILED, 'run state predecessor chain exceeds maximum depth');
    }
    const previousPath = join(dirname(currentPath), `${String(sequence - 1).padStart(6, '0')}.json`);
    const previous = await loadRun(previousPath, {
      requireDigest: true,
      ...(options.production ? { authorityPlanPath: options.planPath } : {}),
    });
    if (
      previous.stateSequence !== sequence - 1
      || previous.runId !== current.runId
      || previous.command !== current.command
      || previous.planDigest !== current.planDigest
    ) {
      throw new ReleaseError(GATE_FAILED, 'run state predecessor does not belong to the same monotonic authority chain');
    }
    if (current.previousStateDigest !== previous.runDigest) {
      throw new ReleaseError(GATE_FAILED, 'run state previousStateDigest does not match the immutable predecessor bytes');
    }
    current = previous;
    currentPath = realpathSync(previousPath);
  }
}

function validateSourceRunEdge(child, parent) {
  if (child.command === 'reconcile') {
    if (!['publish', 'reconcile'].includes(parent.command) || parent.status !== 'PARTIAL') {
      throw new ReleaseError(
        GATE_FAILED,
        'reconcile lineage must reference a PARTIAL publish or reconcile run',
        { childCommand: child.command, parentCommand: parent.command, parentStatus: parent.status },
      );
    }
    return;
  }
  if (child.command === 'verify') {
    if (!['publish', 'reconcile'].includes(parent.command) || parent.status !== 'PUBLISHED') {
      throw new ReleaseError(
        GATE_FAILED,
        'verify lineage must reference a PUBLISHED publish or reconcile run',
        { childCommand: child.command, parentCommand: parent.command, parentStatus: parent.status },
      );
    }
  }
}

/**
 * Recursively validate sourceRunId/sourceRunDigest/sourceRunPath references
 * until a publish authority is reached. This prevents a reconcile run from
 * truncating its parent lineage before verify consumes it.
 */
export async function validateRunLineage(run, options = {}) {
  const { plan, planPath, runPath, production = false, maxDepth = 16 } = options;
  if (maxDepth < 0) {
    throw new ReleaseError(GATE_FAILED, 'release run lineage exceeds maximum depth');
  }
  validateRun(run, { requireDigest: production });
  if (production) assertImmutableRunAuthority(runPath, planPath, run);
  await validateStatePredecessorChain(run, runPath, { production, planPath });
  validateRunPlanDigest(run, plan, { planPath });
  if (run.command === 'publish') return;
  if (!['reconcile', 'verify'].includes(run.command)) {
    throw new ReleaseError(GATE_FAILED, `unsupported run command in lineage: ${run.command}`);
  }
  if (!run.sourceRunPath || !run.sourceRunId || !run.sourceRunDigest) {
    throw new ReleaseError(GATE_FAILED, `${run.command} run is missing complete source run lineage`);
  }
  const parent = await loadRun(run.sourceRunPath, {
    requireDigest: true,
    ...(production ? { authorityPlanPath: planPath } : {}),
  });
  if (parent.runId !== run.sourceRunId || parent.runDigest !== run.sourceRunDigest) {
    throw new ReleaseError(
      GATE_FAILED,
      'source run lineage id/digest does not match referenced immutable run bytes',
      { sourceRunPath: run.sourceRunPath },
    );
  }
  validateSourceRunEdge(run, parent);
  await validateRunLineage(parent, {
    plan,
    planPath,
    runPath: run.sourceRunPath,
    production,
    maxDepth: maxDepth - 1,
  });
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
  if (options.planPath) assertImmutablePlanAuthority(options.planPath, plan);

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

  if (plan.production && run.planPath && options.planPath && resolve(run.planPath) !== resolve(options.planPath)) {
    throw new ReleaseError(
      GATE_FAILED,
      'source run immutable plan path does not match the supplied plan authority',
      { runPlanPath: run.planPath, suppliedPlanPath: options.planPath },
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
  const seenPlanActionIds = new Set();
  for (const action of planActions) {
    if (seenPlanActionIds.has(action.id)) {
      throw new ReleaseError(
        GATE_FAILED,
        `release plan has duplicate action id "${action.id}"`,
        { actionId: action.id },
      );
    }
    seenPlanActionIds.add(action.id);
  }
  const planActionIds = new Set(planActions.map((a) => a.id));
  const planActionsById = new Map(planActions.map((action) => [action.id, action]));

  // Reject duplicate actionIds in the run's checkpoints
  const seenCheckpointIds = new Set();
  for (const cp of run.checkpoints) {
    if (seenCheckpointIds.has(cp.actionId)) {
      throw new ReleaseError(
        GATE_FAILED,
        `source run has duplicate checkpoint for action "${cp.actionId}"`,
        { actionId: cp.actionId },
      );
    }
    seenCheckpointIds.add(cp.actionId);
  }

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

    const action = planActionsById.get(cp.actionId);
    if (cp.actionType !== action.type) {
      throw new ReleaseError(
        GATE_FAILED,
        `source run checkpoint actionType mismatch for action "${cp.actionId}": run says "${cp.actionType}", plan says "${action.type}"`,
        { actionId: cp.actionId, runActionType: cp.actionType, planActionType: action.type },
      );
    }
  }
}

/**
 * Compute the SHA-256 digest of a run object.
 *
 * The digest is computed over the JSON serialisation with the `runDigest`
 * field excluded (same convention as computePlanDigest).
 *
 * @param {Object} run - The run object.
 * @returns {string} The hex-encoded SHA-256 digest.
 */
export function computeRunDigest(run) {
  const { runDigest: _, ...rest } = run;
  return sha256Hex(JSON.stringify(rest, null, 2));
}

function sealRun(run) {
  const sealed = { ...run };
  sealed.runDigest = computeRunDigest(sealed);
  validateRun(sealed, { requireDigest: true });
  return sealed;
}

async function syncDirectory(dir) {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Write a run file atomically to disk.
 *
 * Validates the run against the schema before writing.
 * Uses temp-file + rename for atomicity.
 *
 * **Exclusive-create semantics**: if a file already exists at `runPath`
 * with different bytes, the write fails.  This prevents a stale run from
 * silently overwriting a newer run record.  Writes are idempotent when
 * the content is byte-identical.
 *
 * @param {string} runPath - Absolute path to write the run to.
 * @param {Object} run - The run object to write.
 * @returns {Promise<void>}
 * @throws {ReleaseError} GATE_FAILED on schema validation failure.
 * @throws {ReleaseError} GATE_FAILED if the file already exists with different bytes.
 */
export async function writeRunAtomic(runPath, run) {
  const sealed = sealRun(run);
  const json = JSON.stringify(sealed, null, 2);
  const dir = dirname(runPath);
  const tmpPath = `${dir}/.release-run-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await mkdir(dir, { recursive: true });

  const handle = await open(tmpPath, 'wx', 0o600);
  try {
    await handle.writeFile(json, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    try {
      await link(tmpPath, runPath);
      await syncDirectory(dir);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readFile(runPath, 'utf8');
      if (existing !== json) {
        throw new ReleaseError(
          GATE_FAILED,
          'run file already exists with different bytes; exclusive-create rejected overwrite',
          { runPath },
        );
      }
    }
  } finally {
    await unlink(tmpPath).catch(() => {});
  }

  return Object.freeze(sealed);
}

/**
 * Append one immutable, digest-addressed state snapshot for an in-flight run.
 */
export async function appendRunState(runDir, sequence, run) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new ReleaseError(GATE_FAILED, 'run state sequence must be a non-negative integer');
  }
  const statesDir = join(runDir, 'states');
  let previousStateDigest;
  if (sequence > 0) {
    const previousPath = join(statesDir, `${String(sequence - 1).padStart(6, '0')}.json`);
    const previous = await loadRun(previousPath, { requireDigest: true });
    if (
      previous.stateSequence !== sequence - 1
      || previous.runId !== run.runId
      || previous.command !== run.command
      || previous.planDigest !== run.planDigest
    ) {
      throw new ReleaseError(
        GATE_FAILED,
        'run state predecessor does not belong to the same monotonic authority chain',
        { sequence, previousPath },
      );
    }
    previousStateDigest = previous.runDigest;
  }
  const { previousStateDigest: _discarded, ...nextRun } = run;
  const state = sealRun({
    ...nextRun,
    stateSequence: sequence,
    ...(previousStateDigest ? { previousStateDigest } : {}),
  });
  // The sequence slot itself is exclusive. A second digest at the same
  // sequence is therefore rejected instead of creating a fork.
  const statePath = join(statesDir, `${String(sequence).padStart(6, '0')}.json`);
  await writeRunAtomic(statePath, state);
  return Object.freeze({ state, statePath });
}
