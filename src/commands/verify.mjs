/**
 * Verify command: post-publish verification and smoke tests.
 *
 * Reads a source run (publish or reconcile) and validates:
 * 1. Source run status is PUBLISHED (VERIFIED is terminal)
 * 2. All checkpoints in the source run are succeeded or skipped
 * 3. Each action's remote state is verified via adapter.verify()
 * 4. Installation smoke test passes
 *
 * The source run is mandatory; verify never silently falls back to plan.status.
 *
 * @module commands/verify
 */

import { readFile, writeFile, mkdtemp, rm, mkdir, lstat, realpath } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

import { validatePlan, computePlanDigest, validatePlanActionCompleteness } from '../core/plan.mjs';
import { createEvidenceWriter } from '../core/evidence.mjs';
import {
  loadRun,
  validateRunPlanDigest,
  validateRunCheckpointMapping,
  validateRunLineage,
  writeRunAtomic,
  computeRunDigest,
  resolveDefaultRunDir,
  createProductionRunDir,
} from '../core/run.mjs';
import {
  assertImmutableApprovalAuthority,
  validateApproval,
  validateApprovalRecordSchema,
} from '../core/approval.mjs';
import {
  ReleaseError,
  GATE_FAILED,
  POST_PUBLISH_VERIFY_FAILED,
} from '../core/errors.mjs';
import { assertTransition, PUBLISHED, VERIFIED } from '../core/state-machine.mjs';
import { resolveUnitScopedPath } from '../snapshot/public-path.mjs';
import {
  normalizeRegistry,
  registryTokenKey,
  resolveNpmRegistryAuthToken,
} from '../adapters/npm.mjs';
import { runConsumerVerificationGates } from '../core/verification-gates.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Map plan action type to adapter ActionType.
 * Must match publish.mjs and reconcile.mjs.
 */
const ADAPTER_ACTION_TYPE_MAP = {
  'push-commit': 'git-push',
  'push-snapshot': 'push-snapshot',
  'set-default-branch': 'set-default-branch',
  'create-tag': 'git-tag',
  'npm-publish': 'npm-publish',
  'github-release': 'github-release',
  'claude-marketplace-install': 'claude-marketplace-install',
  'codex-marketplace-install': 'codex-marketplace-install',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultClock() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

/**
 * Recursive subset matching: every leaf in `expected` must exist in `actual`
 * with the same value. Nested objects are compared recursively; primitives
 * are compared with strict equality.
 *
 * @param {any} actual
 * @param {any} expected
 * @returns {boolean}
 */
function matchesSubset(actual, expected) {
  if (expected === null || expected === undefined) {
    return actual === expected;
  }
  if (typeof expected !== 'object' || Array.isArray(expected)) {
    return actual === expected;
  }
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
    return false;
  }
  for (const key of Object.keys(expected)) {
    if (!(key in actual) || !matchesSubset(actual[key], expected[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Run installation smoke test in a temporary directory.
 *
 * For every npm distribution declared in the plan, installs the exact
 * `<package>@<targetVersion>` into an isolated temporary project with
 * safe default npm flags. Validates:
 * - Installed package.json name and version match exactly.
 * - When smokeBin is configured: the specified bin is resolved, validated
 *   against path-escape/symlink/non-regular-file guards, and executed with
 *   smokeArgs; output is validated against smokeExpectedJson (recursive
 *   subset match) when present.
 * - When smokeBin is not configured: install + name/version check passes
 *   immediately; runBin is never called; result records
 *   cliSmoke: "not-configured".
 * - No best-effort catch: any failure is fail-closed.
 *
 * When no npm distribution exists, returns `{ passed: true, skipped: true }`
 * so pure plugin projects can verify cleanly.
 *
 * @param {Object} plan - The frozen release plan.
 * @param {string} root - Project root for source access.
 * @param {Object} [options]
 * @param {Object} [options.npmExecutor] - Injectable npm executor for testing.
 * @returns {Promise<{ passed: boolean, skipped?: boolean, details: Object }>}
 */
export async function runSmokeTest(plan, root, options = {}) {
  const baseDir = options.baseDir ?? tmpdir();
  await mkdir(baseDir, { recursive: true });
  const tmpDir = await mkdtemp(join(baseDir, 'verify-smoke-'));
  const npmExec = options.npmExecutor ?? defaultNpmExecutor;
  const installFlags = [
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--save=false',
  ];

  try {
    // Collect all npm distributions across all units
    const units = plan.units ?? [];
    const npmDistributions = [];
    for (const unit of units) {
      for (const dist of unit.distributions ?? []) {
        if (dist.type === 'npm' && dist.package) {
          npmDistributions.push({
            package: dist.package,
            registry: normalizeRegistry(dist.registry),
            targetVersion: unit.targetVersion,
            unitId: unit.id,
            smokeBin: dist.smokeBin,
            smokeArgs: dist.smokeArgs ?? [],
            smokeExpectedJson: dist.smokeExpectedJson,
          });
        }
      }
    }

    // No npm distribution: smoke passes with skipped flag
    if (npmDistributions.length === 0) {
      return {
        passed: true,
        skipped: true,
        details: { message: 'No npm distributions in plan; smoke test skipped' },
        gateResults: [],
      };
    }

    const results = [];
    const gateResults = [];

    for (const { package: pkgName, registry, targetVersion, unitId, smokeBin, smokeArgs, smokeExpectedJson } of npmDistributions) {
      const packageAtVersion = `${pkgName}@${targetVersion}`;
      const installDir = resolveUnitScopedPath(tmpDir, unitId);
      await mkdir(join(installDir, 'node_modules'), { recursive: true });

      // Install exact package@version with safe flags
      const registryFlags = [...installFlags, '--registry', registry];
      const installResult = await npmExec.install(
        packageAtVersion,
        installDir,
        registryFlags,
        { registry },
      );
      if (!installResult.success) {
        return {
          passed: false,
          details: {
            error: `npm install ${packageAtVersion} failed: ${installResult.error}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      // Verify installed package.json name and version
      const installedPkgPath = join(installDir, 'node_modules', pkgName, 'package.json');
      let installedPkg;
      try {
        installedPkg = JSON.parse(await readFile(installedPkgPath, 'utf8'));
      } catch {
        return {
          passed: false,
          details: {
            error: `Installed package.json not found at ${installedPkgPath}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      if (installedPkg.name !== pkgName) {
        return {
          passed: false,
          details: {
            error: `Installed package name mismatch: expected ${pkgName}, got ${installedPkg.name}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      if (installedPkg.version !== targetVersion) {
        return {
          passed: false,
          details: {
            error: `Installed version mismatch: expected ${targetVersion}, got ${installedPkg.version}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      const pkgRoot = join(installDir, 'node_modules', pkgName);
      gateResults.push(...await runConsumerVerificationGates({
        plan,
        unitId,
        distribution: 'npm',
        executionRoot: pkgRoot,
        evidence: options.evidence,
        env: options.gateEnv ?? process.env,
        fixedEnv: { HOME: installDir },
      }));

      // If smokeBin is not configured, install + name/version check is sufficient
      if (!smokeBin) {
        results.push({
          packageName: pkgName,
          version: targetVersion,
          packageAtVersion,
          unitId,
          cliSmoke: 'not-configured',
        });
        continue;
      }

      // Resolve and validate the specified bin by name
      const binMapping = installedPkg.bin;
      if (!binMapping) {
        return {
          passed: false,
          details: {
            error: `Installed package ${packageAtVersion} has no bin field; smokeBin "${smokeBin}" requested`,
            packageAtVersion,
            unitId,
          },
        };
      }

      const binRelative = typeof binMapping === 'string'
        ? binMapping
        : binMapping[smokeBin];
      if (typeof binRelative !== 'string' || binRelative.length === 0) {
        return {
          passed: false,
          details: {
            error: `Installed package ${packageAtVersion} does not expose bin "${smokeBin}"`,
            packageAtVersion,
            unitId,
          },
        };
      }

      // Verify bin path does not escape the installed package root
      const binPath = resolve(pkgRoot, binRelative);
      const relBin = relative(pkgRoot, binPath);
      const sep = process.platform === 'win32' ? '\\' : '/';
      if (isAbsolute(relBin) || relBin === '..' || relBin.startsWith(`..${sep}`)) {
        return {
          passed: false,
          details: {
            error: `Bin path escapes package root: ${binPath}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      let binStat;
      try {
        binStat = await lstat(binPath);
        const [pkgRootReal, binPathReal] = await Promise.all([realpath(pkgRoot), realpath(binPath)]);
        const relReal = relative(pkgRootReal, binPathReal);
        if (
          !binStat.isFile() ||
          binStat.isSymbolicLink() ||
          isAbsolute(relReal) ||
          relReal === '..' ||
          relReal.startsWith(`..${sep}`)
        ) {
          throw new Error('bin is not a regular file inside the installed package');
        }
      } catch (err) {
        return {
          passed: false,
          details: {
            error: `Invalid installed bin for ${packageAtVersion}: ${err.message}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      // Run CLI smoke — fail-closed, no best-effort catch
      const cliArgs = smokeArgs.length > 0 ? smokeArgs : [];
      let binResult;
      try {
        binResult = await npmExec.runBin(binPath, cliArgs, {
          cwd: pkgRoot,
          env: {
            HOME: installDir,
            TMPDIR: installDir,
            TEMP: installDir,
            TMP: installDir,
            PATH: dirname(process.execPath),
            CI: '1',
          },
        });
      } catch (binErr) {
        return {
          passed: false,
          details: {
            error: `CLI smoke execution failed for ${packageAtVersion}: ${binErr.message}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      if (binResult.exitCode !== 0 && binResult.exitCode !== undefined) {
        return {
          passed: false,
          details: {
            error: `CLI smoke exited with code ${binResult.exitCode} for ${packageAtVersion}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      // Validate CLI output
      if (smokeExpectedJson) {
        // Recursive subset matching: all expected fields must be present and equal
        let parsedOutput;
        try {
          parsedOutput = JSON.parse(binResult.stdout);
        } catch {
          return {
            passed: false,
            details: {
              error: `CLI smoke returned non-JSON output for ${packageAtVersion}`,
              packageAtVersion,
              unitId,
            },
          };
        }
        if (!matchesSubset(parsedOutput, smokeExpectedJson)) {
          return {
            passed: false,
            details: {
              error: `CLI smoke JSON output does not match expected fields for ${packageAtVersion}`,
              packageAtVersion,
              unitId,
              expected: smokeExpectedJson,
              actual: parsedOutput,
            },
          };
        }
      } else {
        // No expected JSON specified: only require valid JSON output
        try {
          JSON.parse(binResult.stdout);
        } catch {
          return {
            passed: false,
            details: {
              error: `CLI smoke returned non-JSON output for ${packageAtVersion}`,
              packageAtVersion,
              unitId,
            },
          };
        }
      }

      results.push({
        packageName: pkgName,
        version: targetVersion,
        packageAtVersion,
        unitId,
        cliSmoke: 'passed',
      });
    }

    return {
      passed: true,
      details: {
        distributions: results,
        count: results.length,
      },
      gateResults,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Default npm executor that runs real npm commands.
 *
 * Install flags include --ignore-scripts, --no-audit, --no-fund,
 * --package-lock=false, --save=false for safe isolated installs.
 */
const defaultNpmExecutor = {
  async install(packageAtVersion, cwd, flags, { registry }) {
    const normalizedRegistry = normalizeRegistry(registry);
    const token = await resolveNpmRegistryAuthToken({
      registry: normalizedRegistry,
      cwd,
      exec: execFile,
      env: process.env,
    });
    const userConfig = join(cwd, '.release-skill-npmrc');
    await writeFile(
      userConfig,
      `registry=${normalizedRegistry}/\n${registryTokenKey(normalizedRegistry)}=${token}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const env = { ...process.env };
    for (const name of [
      'NPM_TOKEN', 'NODE_AUTH_TOKEN',
      'NPM_CONFIG_REGISTRY', 'npm_config_registry',
      'NPM_CONFIG_USERCONFIG', 'npm_config_userconfig',
    ]) delete env[name];
    try {
      await execFile('npm', [
        'install', packageAtVersion,
        ...flags,
        '--userconfig', userConfig,
      ], {
        cwd,
        env,
        shell: false,
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      await rm(userConfig, { force: true }).catch(() => {});
    }
  },
  async runBin(binPath, args = [], options = {}) {
    return execFile(process.execPath, [binPath, ...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      encoding: 'utf8',
      timeout: 30_000,
    });
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Post-publish verification of a release.
 *
 * @param {Object} options
 * @param {string} options.planPath - Absolute path to the frozen release plan.
 * @param {string} options.sourceRunPath - Absolute path to the source run.
 * @param {Object} options.adapterRegistry - Adapter registry for verification.
 * @param {string} [options.root] - Project root for source access.
 * @param {string} [options.runDir] - Evidence directory.
 * @param {() => string} [options.clock] - Clock function returning ISO-8601 strings.
 *
 * @returns {Promise<{ planPath: string, status: string, adapterChecks: Object[], smokeTest: Object }>}
 *
 * @throws {ReleaseError} GATE_FAILED on safety gate failures.
 * @throws {ReleaseError} POST_PUBLISH_VERIFY_FAILED if any verification fails.
 */
export async function verifyRelease(options) {
  const {
    planPath,
    sourceRunPath,
    adapterRegistry,
    root = process.cwd(),
    runDir: runDirOpt,
    clock: clockOpt,
    npmExecutor,
    verificationGatesAuthorized,
    gateEnv,
  } = options ?? {};

  const clockFn = typeof clockOpt === 'function' ? clockOpt : defaultClock;

  // --- Gate: sourceRunPath is required ---
  if (!sourceRunPath) {
    throw new ReleaseError(
      GATE_FAILED,
      'verify requires a source run path (--run)',
      { parameter: 'sourceRunPath' },
    );
  }

  // Load and validate the plan before creating any evidence directory. A
  // production plan grants authority only to a fresh direct child of its
  // sibling .release-skill/runs directory.
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

  // --- Set up directories ---
  const runId = `verify-${Date.now()}`;
  const requestedRunDir = runDirOpt ?? resolveDefaultRunDir(planPath, 'verify', runId);
  const runDir = plan.production
    ? await createProductionRunDir(requestedRunDir, planPath)
    : requestedRunDir;
  if (!plan.production) await mkdir(runDir, { recursive: true });

  const evidence = createEvidenceWriter({ runDir, command: 'verify', clock: clockFn });

  try {
    // =======================================================================
    // Step 1: Load and validate release plan
    // =======================================================================
    await evidence.append({ phase: 'verify', step: 'plan-load', status: 'started' });

    const consumerGates = (plan.verificationGates ?? []).filter((gate) => gate.phase === 'consumer-verify');
    const configuredSmokeBins = (plan.units ?? []).flatMap((unit) => (
      (unit.distributions ?? [])
        .filter((distribution) => distribution.type === 'npm' && distribution.smokeBin)
        .map((distribution) => ({ unitId: unit.id, smokeBin: distribution.smokeBin }))
    ));
    if ((consumerGates.length > 0 || configuredSmokeBins.length > 0) && verificationGatesAuthorized !== true) {
      throw new ReleaseError(
        GATE_FAILED,
        `plan declares ${consumerGates.length} consumer verification gate(s) and ` +
        `${configuredSmokeBins.length} npm CLI smoke process(es). ` +
        'They execute installed project code without an OS or network sandbox. ' +
        'To proceed, pass --acknowledge-gate-side-effects (CLI) or verificationGatesAuthorized=true (API).',
        { gateIds: consumerGates.map((gate) => gate.id), configuredSmokeBins },
      );
    }

    await evidence.append({ phase: 'verify', step: 'plan-load', status: 'passed' });

    // =======================================================================
    // Step 2: Load and validate source run
    // =======================================================================
    await evidence.append({ phase: 'verify', step: 'source-run-load', status: 'started' });

    const sourceRun = await loadRun(sourceRunPath, {
      requireDigest: Boolean(plan.production),
      ...(plan.production ? { authorityPlanPath: planPath } : {}),
    });
    await validateRunLineage(sourceRun, {
      plan,
      planPath,
      runPath: sourceRunPath,
      production: Boolean(plan.production),
    });

    // Only accept source runs from publish or reconcile commands
    if (sourceRun.command !== 'publish' && sourceRun.command !== 'reconcile') {
      throw new ReleaseError(
        GATE_FAILED,
        `verify only accepts source runs from publish or reconcile; source run command is "${sourceRun.command}"`,
        { sourceRunCommand: sourceRun.command, sourceRunId: sourceRun.runId },
      );
    }

    // VERIFIED is terminal: verification may only promote PUBLISHED once.
    if (sourceRun.status !== 'PUBLISHED') {
      throw new ReleaseError(
        GATE_FAILED,
        `cannot verify: source run status is "${sourceRun.status}"; expected PUBLISHED (VERIFIED is terminal)`,
        { sourceRunStatus: sourceRun.status },
      );
    }

    if (plan.production) {
      if (!sourceRun.approvalPath || !sourceRun.approvalDigest) {
        throw new ReleaseError(
          GATE_FAILED,
          'production verify requires immutable approvalPath and approvalDigest on the source run',
        );
      }
      let approvalRaw;
      try {
        approvalRaw = await readFile(sourceRun.approvalPath, 'utf8');
      } catch (error) {
        throw new ReleaseError(
          GATE_FAILED,
          `cannot read source run approval authority: ${error.message}`,
        );
      }
      let approval;
      try {
        approval = JSON.parse(approvalRaw);
      } catch (error) {
        throw new ReleaseError(GATE_FAILED, `source run approval is not valid JSON: ${error.message}`);
      }
      validateApprovalRecordSchema(approval);
      const approvalDigest = assertImmutableApprovalAuthority(
        sourceRun.approvalPath,
        plan,
        approvalRaw,
      );
      if (approvalDigest !== sourceRun.approvalDigest) {
        throw new ReleaseError(
          GATE_FAILED,
          'source run approvalDigest does not match immutable approval bytes',
        );
      }
      validateApproval(plan, approval, { clock: clockFn, requireUnexpired: false });
    }

    // Validate plan action completeness before checkpoint mapping
    // Use legacyCompatibility: old plans (pre-v0.1.5) lack
    // parameters.timeoutMs. Verify must still pass these plans,
    // while strict mode (prepare/approve/publish) rejects them.
    const completenessResult = validatePlanActionCompleteness(plan, { legacyCompatibility: true });
    if (!completenessResult.passed) {
      throw new ReleaseError(
        GATE_FAILED,
        `plan action completeness gate failed: ${completenessResult.details.failures.join('; ')}`,
        { failures: completenessResult.details.failures },
      );
    }

    // Validate checkpoint mapping
    validateRunCheckpointMapping(sourceRun, plan.externalActions ?? []);

    // All checkpoints must be succeeded or skipped (no failed/pending)
    const incompleteCheckpoints = sourceRun.checkpoints.filter(
      (cp) => cp.status !== 'succeeded' && cp.status !== 'skipped',
    );
    if (incompleteCheckpoints.length > 0) {
      throw new ReleaseError(
        GATE_FAILED,
        `cannot verify: source run has ${incompleteCheckpoints.length} incomplete checkpoint(s): ${incompleteCheckpoints.map((cp) => `${cp.actionId}=${cp.status}`).join(', ')}`,
        { incompleteCheckpoints: incompleteCheckpoints.map((cp) => ({ actionId: cp.actionId, status: cp.status })) },
      );
    }

    await evidence.append({
      phase: 'verify',
      step: 'source-run-load',
      status: 'passed',
      sourceRunId: sourceRun.runId,
    });

    // =======================================================================
    // Step 3: Verify all actions via adapters
    //
    // Marketplace actions (claude-marketplace-install, codex-marketplace-install)
    // are verified as fresh, isolated consumer installs in verify's own runDir.
    // This ensures verify does not read the publish run's consumer install
    // directories or evidence.
    //
    // Non-marketplace actions use read-only adapter.verify().
    // =======================================================================
    await evidence.append({ phase: 'verify', step: 'adapter-verify', status: 'started' });

    const adapterChecks = [];
    const consumerGateResults = [];
    const actions = plan.externalActions ?? [];
    const MARKETPLACE_TYPES = new Set([
      'claude-marketplace-install',
      'codex-marketplace-install',
    ]);

    for (const action of actions) {
      const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];

      // Skip meta-checkpoints
      if (!adapterActionType) {
        adapterChecks.push({
          actionId: action.id,
          actionType: action.type,
          status: 'SKIPPED',
          reason: 'meta-checkpoint',
        });
        continue;
      }

      let adapter;
      try {
        adapter = adapterRegistry.getAdapter(adapterActionType);
      } catch {
        // Missing adapter for a verified action => structured failure (not silent SKIPPED)
        throw new ReleaseError(
          POST_PUBLISH_VERIFY_FAILED,
          `no adapter registered for action type "${adapterActionType}" (plan action "${action.id}")`,
          { actionId: action.id, adapterActionType },
        );
      }

      if (MARKETPLACE_TYPES.has(action.type)) {
        // --- Marketplace: fresh consumer verification in verify's own runDir ---
        // Context: isolatedConsumerWritesAuthorized allows writing to verify's
        // runDir/consumers/ directory; externalWritesAuthorized stays false.
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

        // Step 3a: Preflight (validate frozen snapshot, parameters)
        const preflightResult = await adapter.preflight(actionInput, marketplaceContext);
        if (preflightResult.status === 'PREFLIGHT_FAILED') {
          adapterChecks.push({
            actionId: action.id,
            actionType: action.type,
            status: 'FAILED',
            error: `preflight failed: ${preflightResult.error}`,
          });
          throw new ReleaseError(
            POST_PUBLISH_VERIFY_FAILED,
            `marketplace preflight failed for action "${action.id}": ${preflightResult.error}`,
            { actionId: action.id },
          );
        }

        // Step 3b: Execute (install to isolated consumer directory)
        const executeResult = await adapter.execute(actionInput, marketplaceContext);
        if (executeResult.status !== 'EXECUTED') {
          adapterChecks.push({
            actionId: action.id,
            actionType: action.type,
            status: 'FAILED',
            error: `execute failed: ${executeResult.error}`,
          });
          throw new ReleaseError(
            POST_PUBLISH_VERIFY_FAILED,
            `marketplace execute failed for action "${action.id}": ${executeResult.error}`,
            { actionId: action.id },
          );
        }

        // Step 3c: Verify (observe + match against plan expected state)
        const verifyResult = await adapter.verify(
          { ...actionInput, expected: action.expected },
          marketplaceContext,
        );

        const check = {
          actionId: action.id,
          actionType: action.type,
          status: verifyResult.status === 'VERIFIED' ? 'PASSED' : 'FAILED',
          observation: verifyResult.observation,
          error: verifyResult.error,
        };
        adapterChecks.push(check);

        await evidence.append({
          phase: 'verify-marketplace',
          actionId: action.id,
          actionType: action.type,
          status: check.status,
        });

        if (check.status === 'FAILED') {
          throw new ReleaseError(
            POST_PUBLISH_VERIFY_FAILED,
            `marketplace verification failed for action "${action.id}": ${verifyResult.error}`,
            { actionId: action.id, observation: verifyResult.observation },
          );
        }

        const distribution = action.type === 'claude-marketplace-install'
          ? 'claude-plugin'
          : 'codex-plugin';
        const installPath = verifyResult.observation?.installPath;
        consumerGateResults.push(...await runConsumerVerificationGates({
          plan,
          unitId: action.unitId,
          distribution,
          executionRoot: installPath,
          evidence,
          env: gateEnv ?? process.env,
          fixedEnv: action.type === 'claude-marketplace-install'
            ? {
                HOME: resolve(runDir, 'consumers', `claude-${action.parameters.plugin}`),
                CLAUDE_CONFIG_DIR: resolve(runDir, 'consumers', `claude-${action.parameters.plugin}`, '.claude'),
              }
            : {
                HOME: resolve(runDir, 'consumers', `codex-${action.parameters.plugin}`),
                CODEX_HOME: resolve(runDir, 'consumers', `codex-${action.parameters.plugin}`),
              },
        }));
      } else {
        // --- Non-marketplace: read-only adapter.verify() ---
        const context = {
          externalWritesAuthorized: false,
          plan,
          baseline: plan.baseline,
          root,
          runDir,
        };

        const verifyResult = await adapter.verify(
          {
            actionType: adapterActionType,
            ...action.parameters,
            expected: action.expected,
          },
          context,
        );

        const check = {
          actionId: action.id,
          actionType: action.type,
          status: verifyResult.status === 'VERIFIED' ? 'PASSED' : 'FAILED',
          observation: verifyResult.observation,
          error: verifyResult.error,
        };

        adapterChecks.push(check);

        await evidence.append({
          phase: 'verify-adapter',
          actionId: action.id,
          actionType: action.type,
          status: check.status,
        });

        if (check.status === 'FAILED') {
          throw new ReleaseError(
            POST_PUBLISH_VERIFY_FAILED,
            `adapter verification failed for action "${action.id}": ${verifyResult.error}`,
            { actionId: action.id, observation: verifyResult.observation },
          );
        }
      }
    }

    await evidence.append({ phase: 'verify', step: 'adapter-verify', status: 'completed' });

    // =======================================================================
    // Step 4: Installation smoke test
    // =======================================================================
    await evidence.append({ phase: 'verify', step: 'smoke-test', status: 'started' });

    let smokeTest;
    try {
      smokeTest = await runSmokeTest(plan, root, {
        npmExecutor,
        baseDir: runDir,
        evidence,
        gateEnv: gateEnv ?? process.env,
      });
    } catch (err) {
      smokeTest = { passed: false, details: { error: err.message } };
    }

    await evidence.append({
      phase: 'verify',
      step: 'smoke-test',
      status: smokeTest.passed ? 'passed' : 'failed',
      details: smokeTest.details,
    });

    if (!smokeTest.passed) {
      throw new ReleaseError(
        POST_PUBLISH_VERIFY_FAILED,
        `installation smoke test failed: ${smokeTest.details.error}`,
        { smokeTest: smokeTest.details },
      );
    }

    consumerGateResults.push(...(smokeTest.gateResults ?? []));
    const expectedGateIds = consumerGates.map((gate) => gate.id).sort();
    const observedGateIds = consumerGateResults.map((result) => result.id).sort();
    if (JSON.stringify(expectedGateIds) !== JSON.stringify(observedGateIds)) {
      throw new ReleaseError(
        POST_PUBLISH_VERIFY_FAILED,
        'consumer verification gate execution set does not match the frozen plan',
        { expectedGateIds, observedGateIds },
      );
    }

    // =======================================================================
    // All verifications passed — write verify run
    // =======================================================================
    assertTransition(PUBLISHED, VERIFIED);
    await evidence.append({ phase: 'verify', status: 'completed', overallStatus: VERIFIED });

    const sourceRunDigest = sourceRun.runDigest ?? computeRunDigest(sourceRun);

    const verifyRunPath = join(runDir, 'release-run.json');
    const verifyRunState = {
      runId,
      command: 'verify',
      planDigest: plan.digest,
      planPath,
      ...(sourceRun.approvalPath ? {
        approvalPath: sourceRun.approvalPath,
        approvalDigest: sourceRun.approvalDigest,
      } : {}),
      sourceRunId: sourceRun.runId,
      sourceRunDigest,
      sourceRunPath,
      status: VERIFIED,
      checkpoints: actions.map((a) => {
        const check = adapterChecks.find((c) => c.actionId === a.id);
        return {
          actionId: a.id,
          actionType: a.type,
          status: check?.status === 'SKIPPED' ? 'skipped' : 'succeeded',
        };
      }),
      gateResults: consumerGateResults,
      startedAt: clockFn(),
      finishedAt: clockFn(),
    };
    const persistedVerifyRun = await writeRunAtomic(verifyRunPath, verifyRunState);

    await evidence.finish({
      status: VERIFIED,
      planPath,
      sourceRunId: sourceRun.runId,
      sourceRunDigest,
      runDigest: persistedVerifyRun.runDigest,
      adapterCheckCount: adapterChecks.length,
      smokeTestPassed: true,
      consumerGateCount: consumerGateResults.length,
      completedAt: clockFn(),
    });

    return {
      planPath,
      status: VERIFIED,
      adapterChecks,
      smokeTest,
      gateResults: consumerGateResults,
    };
  } catch (err) {
    await evidence.append({
      phase: 'verify',
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
