/**
 * Release plan schema validation, digest calculation, and atomic write.
 *
 * Provides:
 * - `validatePlan(plan)` -- validates a plan object against the release-plan schema
 * - `computePlanDigest(plan)` -- deterministic SHA-256 digest of the plan
 * - `writePlanAtomic(planPath, plan)` -- compute digest, embed it, validate, and
 *   write the plan atomically (temp-file + rename)
 *
 * Schema authority: the release-plan schema is loaded from the package's
 * `schemas/release-plan.schema.json` file at module init time. The root
 * workspace `schemas/release-plan.schema.json` is the generation source;
 * both copies are kept byte-identical.
 *
 * @module core/plan
 */

import { readFile, writeFile, rename, mkdir, open, link, unlink, lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve, parse, sep } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { canonicalJson, sha256Hex } from './digest.mjs';
import { ReleaseError, GATE_FAILED } from './errors.mjs';
import { readTrustedPackageResource } from './trusted-resource.mjs';

// ---------------------------------------------------------------------------
// Schema loaded from the authoritative JSON file (single source of truth)
// ---------------------------------------------------------------------------

const RELEASE_PLAN_SCHEMA = JSON.parse((await readTrustedPackageResource(
  'schemas/release-plan.schema.json',
)).toString('utf8'));

// ---------------------------------------------------------------------------
// Schema validator (compiled once at module init)
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validatePlanSchema = ajv.compile(RELEASE_PLAN_SCHEMA);

async function assertNoSymlinkAncestors(directory) {
  const absolute = resolve(directory);
  const parsed = parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  const releaseIndex = segments.lastIndexOf('.release-skill');
  // Production authority is rooted below `.release-skill`, so inspect every
  // project-owned component from that anchor. Non-production custom outputs
  // inspect their target directory only; platform prefixes such as macOS
  // `/tmp -> /private/tmp` are outside project authority and are allowed.
  const firstChecked = releaseIndex >= 0 ? releaseIndex : Math.max(0, segments.length - 1);
  let current = join(parsed.root, ...segments.slice(0, firstChecked));
  for (const segment of segments.slice(firstChecked)) {
    current = join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ReleaseError(
        GATE_FAILED,
        'release authority path contains a symlink or non-directory ancestor',
        { directory: absolute, unsafeAncestor: current },
      );
    }
  }
}

export async function prepareAuthorityDirectory(directory) {
  const absolute = resolve(directory);
  await assertNoSymlinkAncestors(absolute);
  await mkdir(absolute, { recursive: true });
  await assertNoSymlinkAncestors(absolute);
  return absolute;
}

export async function assertAuthorityFileTarget(filePath) {
  const absolute = resolve(filePath);
  await prepareAuthorityDirectory(dirname(absolute));
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ReleaseError(
        GATE_FAILED,
        'release authority target must be a regular file, never a symlink or special file',
        { filePath: absolute },
      );
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return absolute;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Require production consumers to use the digest-addressed plan authority. */
export function assertImmutablePlanAuthority(planPath, plan) {
  if (!plan?.production) return;
  const digest = computePlanDigest(plan);
  const absolute = resolve(planPath);
  if (basename(dirname(absolute)) !== 'plans' || basename(absolute) !== `${digest}.json`) {
    throw new ReleaseError(
      GATE_FAILED,
      'production commands require plans/<planDigest>.json immutable authority; mutable release-plan.json aliases are not accepted',
      { planPath, expectedFile: `plans/${digest}.json` },
    );
  }
}

/**
 * Validate a plan object against the embedded release-plan schema.
 *
 * @param {object} plan - The plan object to validate.
 * @throws {ReleaseError} GATE_FAILED if the plan does not match the schema.
 */
export function validatePlan(plan) {
  const valid = validatePlanSchema(plan);
  if (!valid) {
    const errors = validatePlanSchema.errors ?? [];
    const summary = errors
      .map((e) => `${e.instancePath || '/'}: ${e.message}`)
      .join('; ');
    throw new ReleaseError(
      GATE_FAILED,
      `release plan schema validation failed: ${summary}`,
      { validationErrors: errors },
    );
  }

  const unitsById = new Map((plan.units ?? []).map((unit) => [unit.id, unit]));
  const gateIds = new Set();
  for (const gate of plan.verificationGates ?? []) {
    if (gateIds.has(gate.id)) {
      throw new ReleaseError(GATE_FAILED, `duplicate verification gate id: "${gate.id}"`);
    }
    gateIds.add(gate.id);
    const unit = unitsById.get(gate.scope.unit);
    if (!unit) {
      throw new ReleaseError(
        GATE_FAILED,
        `verification gate "${gate.id}" references unknown unit "${gate.scope.unit}"`,
      );
    }
    if (
      gate.phase === 'consumer-verify' &&
      !(unit.distributions ?? []).some((distribution) => distribution.type === gate.scope.distribution)
    ) {
      throw new ReleaseError(
        GATE_FAILED,
        `verification gate "${gate.id}" references undeclared distribution "${gate.scope.distribution}"`,
      );
    }
  }
}

/**
 * Compute a deterministic SHA-256 digest of a plan object.
 *
 * The digest is computed from the canonical JSON of the plan. The `digest`
 * field itself is excluded from the computation so that the digest is
 * self-consistent: `computePlanDigest(plan) === plan.digest` when the plan
 * was written by `writePlanAtomic`.
 *
 * @param {object} plan - A plan object (must not include a `digest` field,
 *   or the field will be stripped before hashing).
 * @returns {string} Lowercase 64-char hex SHA-256 digest.
 */
export function computePlanDigest(plan) {
  // Strip the digest field if present so the hash is self-consistent.
  const { digest: _digest, ...rest } = plan;
  return sha256Hex(canonicalJson(rest));
}

/**
 * Write a release plan atomically to disk.
 *
 * Steps:
 * 1. Compute the plan's deterministic digest.
 * 2. Embed the digest into the plan object.
 * 3. Validate the augmented plan against the release-plan schema.
 * 4. Serialise to pretty-printed JSON.
 * 5. Write to a temporary file in the same directory.
 * 6. Rename (atomic on POSIX) to the final path.
 *
 * @param {string} planPath - Absolute path to write the plan to.
 * @param {object} plan - The plan object (must not already include `digest`).
 * @returns {Promise<{ planPath: string, planDigest: string }>}
 *
 * @throws {ReleaseError} GATE_FAILED on schema validation failure.
 */
export async function writePlanAtomic(planPath, plan) {
  // 1. Compute digest
  const planDigest = computePlanDigest(plan);

  // 2. Embed digest
  const augmented = { ...plan, digest: planDigest };

  // 3. Validate
  validatePlan(augmented);

  // 4. Serialise
  const json = JSON.stringify(augmented, null, 2);

  // 5. Write to temp file in the same directory
  const dir = dirname(planPath);
  await prepareAuthorityDirectory(dir);
  await assertAuthorityFileTarget(planPath);
  const tmpPath = `${dir}/.release-plan-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmpPath, json, 'utf8');

  // 6. Atomic rename
  await rename(tmpPath, planPath);

  return { planPath, planDigest };
}

/**
 * Create a digest-addressed plan authority exactly once.
 *
 * The target must be named by the computed digest. An existing byte-identical
 * authority is reused; an existing divergent file fails closed. A temporary
 * file is fsynced and atomically linked into place so concurrent prepares can
 * never replace an authority that another process already created.
 */
export async function writePlanImmutable(planPath, plan) {
  const planDigest = computePlanDigest(plan);
  const augmented = { ...plan, digest: planDigest };
  validatePlan(augmented);
  const json = JSON.stringify(augmented, null, 2);

  if (!planPath.endsWith(`${planDigest}.json`)) {
    throw new ReleaseError(
      GATE_FAILED,
      'immutable plan path must be named with the plan digest',
      { planPath, planDigest },
    );
  }

  const dir = dirname(planPath);
  await prepareAuthorityDirectory(dir);
  await assertAuthorityFileTarget(planPath);
  const tmpPath = join(dir, `.release-plan-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  const handle = await open(tmpPath, 'wx', 0o600);
  try {
    await handle.writeFile(json, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await link(tmpPath, planPath);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(planPath, 'utf8');
    if (existing !== json) {
      throw new ReleaseError(
        GATE_FAILED,
        'immutable plan authority already exists with different bytes',
        { planPath, planDigest },
      );
    }
  } finally {
    await unlink(tmpPath).catch(() => {});
  }

  return { planPath, planDigest };
}

// ---------------------------------------------------------------------------
// Plan action completeness gate
// ---------------------------------------------------------------------------

/** Expected adapter for each action type. */
const EXPECTED_ADAPTER = {
  'push-snapshot': 'git-github',
  'create-tag': 'git-github',
  'github-release': 'github',
  'npm-publish': 'npm',
  'claude-marketplace-install': 'plugin-marketplace',
  'codex-marketplace-install': 'plugin-marketplace',
  'set-default-branch': 'git-github',
};

/** Required action types for every unit. */
const REQUIRED_ACTION_TYPES = ['push-snapshot', 'create-tag', 'github-release'];

/**
 * Derive the expected actions from plan units and validate completeness.
 *
 * For each unit the plan must contain exactly:
 * - 1 push-snapshot (adapter: git-github)
 * - 1 create-tag     (adapter: git-github)
 * - 1 github-release (adapter: github)
 * - 1 npm-publish    (adapter: npm) — only if the unit has an npm distribution
 * - 1 claude-marketplace-install (adapter: plugin-marketplace) — only if the unit has a claude-plugin distribution
 * - 1 codex-marketplace-install  (adapter: plugin-marketplace) — only if the unit has a codex-plugin distribution
 *
 * Every action must bind to the correct unitId, correct adapter, correct
 * version, correct publicRepo (where applicable), and correct tag derived
 * from tagTemplate. No missing, extra, duplicate, or mismatched actions
 * are allowed.
 *
 * The tag check requires exact equality between expected.tag and the
 * tagTemplate-expanded tag. This eliminates the substring vulnerability
 * (e.g. v0.0.10 must not match expected version 0.0.1).
 *
 * @param {object} plan - A validated release plan object.
 * @returns {{ passed: boolean, details: { failures: string[], expectedCount: number, actualCount: number } }}
 */
export function validatePlanActionCompleteness(plan) {
  const failures = [];

  if (!plan || typeof plan !== 'object') {
    return { passed: false, details: { failures: ['plan is null or not an object'], expectedCount: 0, actualCount: 0 } };
  }

  const units = Array.isArray(plan.units) ? plan.units : [];
  const actions = Array.isArray(plan.externalActions) ? plan.externalActions : [];

  // --- Must have at least one action ---
  if (actions.length === 0) {
    failures.push('plan has no external actions; at least one is required');
    return { passed: false, details: { failures, expectedCount: 0, actualCount: 0 } };
  }

  // --- Validate each unit's required actions ---
  let expectedCount = 0;
  const seenUnitIds = new Set();

  for (const unit of units) {
    const unitId = unit.id;
    const targetVersion = unit.targetVersion;
    const publicRepo = unit.publicRepo;
    const tagTemplate = unit.tagTemplate;
    const distributions = unit.distributions ?? [];
    const production = plan.production?.mode === 'github-npm-v1';
    const frozen = unit.frozenSnapshot;
    const productionConfig = unit.productionConfig ?? {};
    const branchStrategy = productionConfig.branchStrategy;
    const expectedTag = tagTemplate
      ? tagTemplate.replace('{version}', targetVersion ?? '')
      : null;

    // Check unit has required fields
    if (!unitId) {
      failures.push(`unit is missing id`);
      continue;
    }

    // Check for duplicate unit.id
    if (seenUnitIds.has(unitId)) {
      failures.push(`duplicate unit id "${unitId}"`);
      continue;
    }
    seenUnitIds.add(unitId);
    if (!targetVersion) {
      failures.push(`unit "${unitId}" is missing targetVersion`);
    }
    if (!publicRepo) {
      failures.push(`unit "${unitId}" is missing publicRepo`);
    }
    if (!tagTemplate) {
      failures.push(`unit "${unitId}" is missing tagTemplate`);
    }
    if (production && !frozen) {
      failures.push(`unit "${unitId}" is missing frozenSnapshot for production publish`);
    }
    if (production && frozen) {
      if (!['create-release-branch', 'advance-existing-branch', 'initialize-default-branch'].includes(branchStrategy)) {
        failures.push(`unit "${unitId}" productionConfig.branchStrategy is missing or invalid`);
      }
      const expectedBranch = (productionConfig.branchTemplate ?? 'release/{tag}')
        .replaceAll('{tag}', expectedTag ?? '')
        .replaceAll('{version}', targetVersion ?? '')
        .replaceAll('{unit}', unitId);
      if (frozen.branch !== expectedBranch) {
        failures.push(`unit "${unitId}" frozen branch does not match productionConfig.branchTemplate`);
      }
      if (frozen.branchStrategy !== branchStrategy) {
        failures.push(`unit "${unitId}" frozenSnapshot.branchStrategy does not match productionConfig.branchStrategy`);
      }
      if (!frozen.commitTimestamp || typeof frozen.commitTimestamp !== 'string') {
        failures.push(`unit "${unitId}" frozenSnapshot.commitTimestamp is missing; legacy production plans without a freeze timestamp are rejected, never silently backfilled`);
      } else if (plan.createdAt !== frozen.commitTimestamp) {
        failures.push(`unit "${unitId}" frozenSnapshot.commitTimestamp must equal plan.createdAt`);
      }
      if (['advance-existing-branch', 'initialize-default-branch'].includes(branchStrategy)) {
        if (unit.previousPublicBaseline?.mode !== 'bound') {
          failures.push(`unit "${unitId}" branch strategy "${branchStrategy}" requires a bound previous public baseline`);
        }
        if (!frozen.parentCommit || frozen.parentCommit !== unit.previousPublicBaseline?.commit) {
          failures.push(`unit "${unitId}" frozenSnapshot.parentCommit does not match previous public baseline commit`);
        }
      } else if (frozen.parentCommit) {
        failures.push(`unit "${unitId}" create-release-branch must not freeze a parentCommit`);
      }
      if (
        branchStrategy === 'advance-existing-branch' &&
        unit.previousPublicBaseline?.ref !== `refs/heads/${expectedBranch}`
      ) {
        failures.push(`unit "${unitId}" advance-existing-branch baseline ref does not match the target branch`);
      }
      if (branchStrategy === 'initialize-default-branch') {
        if (productionConfig.setAsDefaultBranch !== true || !productionConfig.expectedCurrentDefaultBranch) {
          failures.push(`unit "${unitId}" initialize-default-branch requires explicit default branch settings`);
        }
      } else if (productionConfig.setAsDefaultBranch === true) {
        failures.push(`unit "${unitId}" setAsDefaultBranch is only valid for initialize-default-branch`);
      }
    }

    // Required actions for this unit (always required)
    for (const actionType of REQUIRED_ACTION_TYPES) {
      expectedCount++;
      const expectedAdapter = EXPECTED_ADAPTER[actionType];
      const expectedActionId = `${actionType}-${unitId}`;
      const matchingActions = actions.filter(
        (a) => a.unitId === unitId && a.type === actionType,
      );

      if (matchingActions.length === 0) {
        failures.push(
          `unit "${unitId}": required action type "${actionType}" is missing (expected adapter "${expectedAdapter}")`,
        );
      } else if (matchingActions.length > 1) {
        failures.push(
          `unit "${unitId}": duplicate action type "${actionType}" (${matchingActions.length} found, expected 1)`,
        );
      } else {
        // Validate the single matching action
        const action = matchingActions[0];

        // --- Strict common field checks ---
        if (action.id !== expectedActionId) {
          failures.push(
            `unit "${unitId}", action "${action.id}": id is "${action.id}", expected "${expectedActionId}"`,
          );
        }
        if (action.unitId !== unitId) {
          failures.push(
            `unit "${unitId}", action "${action.id}": unitId is "${action.unitId}", expected "${unitId}"`,
          );
        }
        if (action.adapter !== expectedAdapter) {
          failures.push(
            `unit "${unitId}", action "${action.id}": adapter is "${action.adapter}", expected "${expectedAdapter}"`,
          );
        }
        if (action.status !== 'PENDING') {
          failures.push(
            `unit "${unitId}", action "${action.id}": status is "${action.status ?? '(missing)'}", expected "PENDING"`,
          );
        }

        // --- Type-specific strict parameter checks ---
        if (actionType === 'push-snapshot') {
          _checkRequired(action, 'parameters.version', action.parameters?.version, targetVersion, unitId, failures);
          _checkRequired(action, 'parameters.source', action.parameters?.source, unit.source, unitId, failures);
          _checkRequired(action, 'parameters.cwd', action.parameters?.cwd, unit.source, unitId, failures);
          _checkRequired(action, 'parameters.publicRepo', action.parameters?.publicRepo, publicRepo, unitId, failures);
          if (production) {
            _checkRequired(action, 'parameters.snapshotPath', action.parameters?.snapshotPath, frozen?.path, unitId, failures);
            _checkRequired(action, 'parameters.manifestDigest', action.parameters?.manifestDigest, frozen?.manifestDigest, unitId, failures);
            _checkRequired(action, 'parameters.gitObjectDir', action.parameters?.gitObjectDir, frozen?.gitObjectDir, unitId, failures);
            _checkRequired(action, 'parameters.branch', action.parameters?.branch, frozen?.branch, unitId, failures);
            _checkRequired(action, 'parameters.commit', action.parameters?.commit, frozen?.commit, unitId, failures);
            _checkRequired(action, 'parameters.tree', action.parameters?.tree, frozen?.tree, unitId, failures);
            _checkRequired(action, 'parameters.branchStrategy', action.parameters?.branchStrategy, branchStrategy, unitId, failures);
            _checkRequired(action, 'parameters.githubHost', action.parameters?.githubHost, productionConfig.githubHost ?? 'github.com', unitId, failures);
            _checkRequired(action, 'expected.commit', action.expected?.commit, frozen?.commit, unitId, failures);
            _checkRequired(action, 'expected.tree', action.expected?.tree, frozen?.tree, unitId, failures);
            _checkRequired(action, 'expected.manifestDigest', action.expected?.manifestDigest, frozen?.manifestDigest, unitId, failures);
            if (['advance-existing-branch', 'initialize-default-branch'].includes(branchStrategy)) {
              _checkRequired(action, 'parameters.parentCommit', action.parameters?.parentCommit, frozen?.parentCommit, unitId, failures);
            }
            if (branchStrategy === 'advance-existing-branch') {
              _checkRequired(action, 'parameters.expectedBaselineCommit', action.parameters?.expectedBaselineCommit, frozen?.parentCommit, unitId, failures);
            } else if (action.parameters?.expectedBaselineCommit !== undefined) {
              failures.push(`unit "${unitId}", action "${action.id}": unexpected parameters.expectedBaselineCommit`);
            }
          } else {
            _checkRequired(action, 'expected.tag', action.expected?.tag, expectedTag, unitId, failures);
          }
        }

        if (actionType === 'create-tag') {
          _checkRequired(action, 'parameters.tagTemplate', action.parameters?.tagTemplate, tagTemplate, unitId, failures);
          _checkRequired(action, 'parameters.publicRepo', action.parameters?.publicRepo, publicRepo, unitId, failures);
          _checkRequired(action, 'parameters.version', action.parameters?.version, targetVersion, unitId, failures);
          if (production) {
            _checkRequired(action, 'parameters.tag', action.parameters?.tag, expectedTag, unitId, failures);
            _checkRequired(action, 'parameters.repo', action.parameters?.repo, publicRepo, unitId, failures);
            _checkRequired(action, 'parameters.gitObjectDir', action.parameters?.gitObjectDir, frozen?.gitObjectDir, unitId, failures);
            _checkRequired(action, 'parameters.commit', action.parameters?.commit, frozen?.commit, unitId, failures);
            _checkRequired(action, 'parameters.githubHost', action.parameters?.githubHost, productionConfig.githubHost ?? 'github.com', unitId, failures);
            _checkRequired(action, 'expected.commit', action.expected?.commit, frozen?.commit, unitId, failures);
          }
        }

        if (actionType === 'github-release') {
          _checkRequired(action, 'parameters.publicRepo', action.parameters?.publicRepo, publicRepo, unitId, failures);
          _checkRequired(action, 'parameters.version', action.parameters?.version, targetVersion, unitId, failures);
          if (production) {
            _checkRequired(action, 'parameters.tag', action.parameters?.tag, expectedTag, unitId, failures);
            _checkRequired(action, 'parameters.repo', action.parameters?.repo, publicRepo, unitId, failures);
            _checkRequired(action, 'parameters.commit', action.parameters?.commit, frozen?.commit, unitId, failures);
            _checkRequired(action, 'parameters.githubHost', action.parameters?.githubHost, productionConfig.githubHost ?? 'github.com', unitId, failures);
            const expectedName = (productionConfig.releaseTitleTemplate ?? 'Release {tag}')
              .replaceAll('{tag}', expectedTag ?? '')
              .replaceAll('{version}', targetVersion ?? '')
              .replaceAll('{unit}', unitId);
            _checkRequired(action, 'parameters.name', action.parameters?.name, expectedName, unitId, failures);
            _checkRequired(action, 'parameters.notes', action.parameters?.notes, productionConfig.releaseNotes ?? `Release ${expectedTag}`, unitId, failures);
            _checkRequired(action, 'expected.tag', action.expected?.tag, expectedTag, unitId, failures);
            _checkRequired(action, 'expected.commit', action.expected?.commit, frozen?.commit, unitId, failures);
          }
        }
      }
    }

    // npm-publish: only required if unit has npm distribution
    const npmDist = distributions.find((d) => d.type === 'npm');
    if (npmDist) {
      // Validate npm distribution has a package name
      if (!npmDist.package || typeof npmDist.package !== 'string') {
        failures.push(
          `unit "${unitId}": npm distribution is missing "package" name`,
        );
      }
      expectedCount++;
      const expectedPkg = npmDist.package;
      const npmActions = actions.filter(
        (a) => a.unitId === unitId && a.type === 'npm-publish',
      );

      if (npmActions.length === 0) {
        failures.push(
          `unit "${unitId}": npm distribution declared but "npm-publish" action is missing`,
        );
      } else if (npmActions.length > 1) {
        failures.push(
          `unit "${unitId}": duplicate npm-publish actions (${npmActions.length} found, expected 1)`,
        );
      } else {
        const action = npmActions[0];
        const expectedActionId = `npm-publish-${unitId}`;

        // --- Strict common field checks ---
        if (action.id !== expectedActionId) {
          failures.push(
            `unit "${unitId}", action "${action.id}": id is "${action.id}", expected "${expectedActionId}"`,
          );
        }
        if (action.unitId !== unitId) {
          failures.push(
            `unit "${unitId}", action "${action.id}": unitId is "${action.unitId}", expected "${unitId}"`,
          );
        }
        if (action.adapter !== 'npm') {
          failures.push(
            `unit "${unitId}", action "${action.id}": adapter is "${action.adapter}", expected "npm"`,
          );
        }
        if (action.status !== 'PENDING') {
          failures.push(
            `unit "${unitId}", action "${action.id}": status is "${action.status ?? '(missing)'}", expected "PENDING"`,
          );
        }

        // --- Strict parameter checks ---
        _checkRequired(action, 'parameters.package', action.parameters?.package, expectedPkg, unitId, failures);
        _checkRequired(action, 'parameters.version', action.parameters?.version, targetVersion, unitId, failures);
        _checkRequired(action, 'parameters.cwd', action.parameters?.cwd, unit.source, unitId, failures);
        _checkRequired(action, 'expected.package', action.expected?.package, expectedPkg, unitId, failures);
        _checkRequired(action, 'expected.version', action.expected?.version, targetVersion, unitId, failures);

        // Registry and publisher identity checks (always required for npm)
        const expectedRegistry = npmDist.registry;
        const expectedPublisher = npmDist.publisher;
        if (!expectedRegistry || typeof expectedRegistry !== 'string') {
          failures.push(`unit "${unitId}": npm distribution is missing "registry"`);
        } else {
          _checkRequired(action, 'parameters.registry', action.parameters?.registry, expectedRegistry, unitId, failures);
          _checkRequired(action, 'expected.registry', action.expected?.registry, expectedRegistry, unitId, failures);
        }
        if (!expectedPublisher || typeof expectedPublisher !== 'string') {
          failures.push(`unit "${unitId}": npm distribution is missing "publisher"`);
        } else {
          _checkRequired(action, 'parameters.publisher', action.parameters?.publisher, expectedPublisher, unitId, failures);
          _checkRequired(action, 'expected.publisher', action.expected?.publisher, expectedPublisher, unitId, failures);
        }

        if (production) {
          _checkRequired(action, 'parameters.tarballPath', action.parameters?.tarballPath, frozen?.npm?.tarballPath, unitId, failures);
          _checkRequired(action, 'parameters.tarballSha256', action.parameters?.tarballSha256, frozen?.npm?.tarballSha256, unitId, failures);
          _checkRequired(action, 'parameters.integrity', action.parameters?.integrity, frozen?.npm?.integrity, unitId, failures);
          _checkRequired(action, 'parameters.access', action.parameters?.access, npmDist.access, unitId, failures);
          _checkRequired(action, 'parameters.provenance', action.parameters?.provenance, npmDist.provenance === true, unitId, failures);
          if ((action.parameters?.tag ?? null) !== (npmDist.tag ?? null)) {
            failures.push(`unit "${unitId}", action "${action.id}": parameters.tag does not match npm distribution tag`);
          }
          _checkRequired(action, 'expected.integrity', action.expected?.integrity, frozen?.npm?.integrity, unitId, failures);
        }
      }
    }

    // claude-marketplace-install: only required if unit has claude-plugin distribution
    const claudeDist = distributions.find((d) => d.type === 'claude-plugin');
    if (claudeDist) {
      const plugin = claudeDist.plugin;
      const marketplace = claudeDist.marketplace;
      const entrySkill = claudeDist.entrySkill;
      if (!plugin || !marketplace || !entrySkill) {
        failures.push(`unit "${unitId}": claude-plugin distribution requires plugin, marketplace, and entrySkill`);
      }
      expectedCount++;
      const expectedActionId = `claude-marketplace-install-${unitId}`;
      const claudeActions = actions.filter(
        (a) => a.unitId === unitId && a.type === 'claude-marketplace-install',
      );

      if (claudeActions.length === 0) {
        failures.push(
          `unit "${unitId}": claude-plugin distribution declared but "claude-marketplace-install" action is missing`,
        );
      } else if (claudeActions.length > 1) {
        failures.push(
          `unit "${unitId}": duplicate claude-marketplace-install actions (${claudeActions.length} found, expected 1)`,
        );
      } else {
        const action = claudeActions[0];

        if (action.id !== expectedActionId) {
          failures.push(
            `unit "${unitId}", action "${action.id}": id is "${action.id}", expected "${expectedActionId}"`,
          );
        }
        if (action.unitId !== unitId) {
          failures.push(
            `unit "${unitId}", action "${action.id}": unitId is "${action.unitId}", expected "${unitId}"`,
          );
        }
        if (action.adapter !== 'plugin-marketplace') {
          failures.push(
            `unit "${unitId}", action "${action.id}": adapter is "${action.adapter}", expected "plugin-marketplace"`,
          );
        }
        if (action.status !== 'PENDING') {
          failures.push(
            `unit "${unitId}", action "${action.id}": status is "${action.status ?? '(missing)'}", expected "PENDING"`,
          );
        }

        // Parameter checks
        _checkRequired(action, 'parameters.consumer', action.parameters?.consumer, 'claude', unitId, failures);
        _checkRequired(action, 'parameters.plugin', action.parameters?.plugin, plugin, unitId, failures);
        _checkRequired(action, 'parameters.marketplace', action.parameters?.marketplace, marketplace, unitId, failures);
        _checkRequired(action, 'parameters.repo', action.parameters?.repo, publicRepo, unitId, failures);
        _checkRequired(action, 'parameters.version', action.parameters?.version, targetVersion, unitId, failures);
        _checkRequired(action, 'parameters.entrySkill', action.parameters?.entrySkill, entrySkill, unitId, failures);
        if (production) {
          _checkRequired(action, 'parameters.snapshotPath', action.parameters?.snapshotPath, frozen?.path, unitId, failures);
          _checkRequired(action, 'parameters.ref', action.parameters?.ref, expectedTag, unitId, failures);
          _checkRequired(action, 'parameters.manifestDigest', action.parameters?.manifestDigest, frozen?.manifestDigest, unitId, failures);
        }

        // Expected checks
        _checkRequired(action, 'expected.installed', action.expected?.installed, true, unitId, failures);
        _checkRequired(action, 'expected.plugin', action.expected?.plugin, plugin, unitId, failures);
        _checkRequired(action, 'expected.marketplace', action.expected?.marketplace, marketplace, unitId, failures);
        _checkRequired(action, 'expected.version', action.expected?.version, targetVersion, unitId, failures);
        _checkRequired(action, 'expected.entrySkill', action.expected?.entrySkill, entrySkill, unitId, failures);
        if (production) {
          _checkRequired(action, 'expected.consumer', action.expected?.consumer, 'claude', unitId, failures);
          _checkRequired(action, 'expected.repo', action.expected?.repo, publicRepo, unitId, failures);
          _checkRequired(action, 'expected.ref', action.expected?.ref, expectedTag, unitId, failures);
          _checkRequired(action, 'expected.entrySkillFound', action.expected?.entrySkillFound, true, unitId, failures);
          _checkRequired(action, 'expected.manifestDigest', action.expected?.manifestDigest, frozen?.manifestDigest, unitId, failures);
        }
      }
    }

    // codex-marketplace-install: only required if unit has codex-plugin distribution
    const codexDist = distributions.find((d) => d.type === 'codex-plugin');
    if (codexDist) {
      const plugin = codexDist.plugin;
      const marketplace = codexDist.marketplace;
      const entrySkill = codexDist.entrySkill;
      if (!plugin || !marketplace || !entrySkill) {
        failures.push(`unit "${unitId}": codex-plugin distribution requires plugin, marketplace, and entrySkill`);
      }
      expectedCount++;
      const expectedActionId = `codex-marketplace-install-${unitId}`;
      const codexActions = actions.filter(
        (a) => a.unitId === unitId && a.type === 'codex-marketplace-install',
      );

      if (codexActions.length === 0) {
        failures.push(
          `unit "${unitId}": codex-plugin distribution declared but "codex-marketplace-install" action is missing`,
        );
      } else if (codexActions.length > 1) {
        failures.push(
          `unit "${unitId}": duplicate codex-marketplace-install actions (${codexActions.length} found, expected 1)`,
        );
      } else {
        const action = codexActions[0];

        if (action.id !== expectedActionId) {
          failures.push(
            `unit "${unitId}", action "${action.id}": id is "${action.id}", expected "${expectedActionId}"`,
          );
        }
        if (action.unitId !== unitId) {
          failures.push(
            `unit "${unitId}", action "${action.id}": unitId is "${action.unitId}", expected "${unitId}"`,
          );
        }
        if (action.adapter !== 'plugin-marketplace') {
          failures.push(
            `unit "${unitId}", action "${action.id}": adapter is "${action.adapter}", expected "plugin-marketplace"`,
          );
        }
        if (action.status !== 'PENDING') {
          failures.push(
            `unit "${unitId}", action "${action.id}": status is "${action.status ?? '(missing)'}", expected "PENDING"`,
          );
        }

        // Parameter checks
        _checkRequired(action, 'parameters.consumer', action.parameters?.consumer, 'codex', unitId, failures);
        _checkRequired(action, 'parameters.plugin', action.parameters?.plugin, plugin, unitId, failures);
        _checkRequired(action, 'parameters.marketplace', action.parameters?.marketplace, marketplace, unitId, failures);
        _checkRequired(action, 'parameters.repo', action.parameters?.repo, publicRepo, unitId, failures);
        _checkRequired(action, 'parameters.version', action.parameters?.version, targetVersion, unitId, failures);
        _checkRequired(action, 'parameters.entrySkill', action.parameters?.entrySkill, entrySkill, unitId, failures);
        if (production) {
          _checkRequired(action, 'parameters.snapshotPath', action.parameters?.snapshotPath, frozen?.path, unitId, failures);
          _checkRequired(action, 'parameters.ref', action.parameters?.ref, expectedTag, unitId, failures);
          _checkRequired(action, 'parameters.manifestDigest', action.parameters?.manifestDigest, frozen?.manifestDigest, unitId, failures);
        }

        // Expected checks
        _checkRequired(action, 'expected.installed', action.expected?.installed, true, unitId, failures);
        _checkRequired(action, 'expected.plugin', action.expected?.plugin, plugin, unitId, failures);
        _checkRequired(action, 'expected.marketplace', action.expected?.marketplace, marketplace, unitId, failures);
        _checkRequired(action, 'expected.version', action.expected?.version, targetVersion, unitId, failures);
        _checkRequired(action, 'expected.entrySkill', action.expected?.entrySkill, entrySkill, unitId, failures);
        if (production) {
          _checkRequired(action, 'expected.consumer', action.expected?.consumer, 'codex', unitId, failures);
          _checkRequired(action, 'expected.repo', action.expected?.repo, publicRepo, unitId, failures);
          _checkRequired(action, 'expected.ref', action.expected?.ref, expectedTag, unitId, failures);
          _checkRequired(action, 'expected.entrySkillFound', action.expected?.entrySkillFound, true, unitId, failures);
          _checkRequired(action, 'expected.manifestDigest', action.expected?.manifestDigest, frozen?.manifestDigest, unitId, failures);
        }
      }
    }

    // set-default-branch: only required when productionConfig.setAsDefaultBranch is true
    if (branchStrategy === 'initialize-default-branch') {
      const oldBranch = productionConfig.expectedCurrentDefaultBranch;
      const newBranch = frozen?.branch;
      expectedCount++;
      const expectedActionId = `set-default-branch-${unitId}`;
      const branchActions = actions.filter(
        (a) => a.unitId === unitId && a.type === 'set-default-branch',
      );

      if (branchActions.length === 0) {
        failures.push(
          `unit "${unitId}": productionConfig.setAsDefaultBranch is true but "set-default-branch" action is missing`,
        );
      } else if (branchActions.length > 1) {
        failures.push(
          `unit "${unitId}": duplicate set-default-branch actions (${branchActions.length} found, expected 1)`,
        );
      } else {
        const action = branchActions[0];

        if (action.id !== expectedActionId) {
          failures.push(
            `unit "${unitId}", action "${action.id}": id is "${action.id}", expected "${expectedActionId}"`,
          );
        }
        if (action.unitId !== unitId) {
          failures.push(
            `unit "${unitId}", action "${action.id}": unitId is "${action.unitId}", expected "${unitId}"`,
          );
        }
        if (action.adapter !== 'git-github') {
          failures.push(
            `unit "${unitId}", action "${action.id}": adapter is "${action.adapter}", expected "git-github"`,
          );
        }
        if (action.status !== 'PENDING') {
          failures.push(
            `unit "${unitId}", action "${action.id}": status is "${action.status ?? '(missing)'}", expected "PENDING"`,
          );
        }

        // Required parameters
        _checkRequired(action, 'parameters.repo', action.parameters?.repo, publicRepo, unitId, failures);
        _checkRequired(action, 'parameters.oldBranch', action.parameters?.oldBranch, oldBranch, unitId, failures);
        _checkRequired(action, 'parameters.newBranch', action.parameters?.newBranch, newBranch, unitId, failures);
        _checkRequired(action, 'parameters.expectedNewBranchCommit', action.parameters?.expectedNewBranchCommit, frozen?.commit, unitId, failures);
        _checkRequired(action, 'parameters.githubHost', action.parameters?.githubHost, productionConfig.githubHost ?? 'github.com', unitId, failures);

        // Required expected
        _checkRequired(action, 'expected.defaultBranch', action.expected?.defaultBranch, newBranch, unitId, failures);
        _checkRequired(action, 'expected.newBranchCommit', action.expected?.newBranchCommit, frozen?.commit, unitId, failures);
        if (Object.keys(action.expected ?? {}).some((key) => !['defaultBranch', 'newBranchCommit'].includes(key))) {
          failures.push(`unit "${unitId}", action "${action.id}": expected may only contain defaultBranch and newBranchCommit`);
        }
      }
    }
  }

  // --- Strict count equality: actual must exactly match expected ---
  const actualCount = actions.length;
  if (actualCount !== expectedCount) {
    const diff = actualCount > expectedCount
      ? `${actualCount - expectedCount} extra action(s) detected`
      : `${expectedCount - actualCount} action(s) missing from plan`;
    failures.push(
      `plan has ${actualCount} action(s) but exactly ${expectedCount} expected from unit definitions; ${diff}`,
    );
  }

  return {
    passed: failures.length === 0,
    details: { failures, expectedCount, actualCount },
  };
}

/**
 * Check that a required field exists and equals the expected value.
 * Missing or mismatched values both produce failures.
 *
 * @param {object} action - The action being checked (for error messages).
 * @param {string} fieldPath - Human-readable field path (e.g. 'parameters.version').
 * @param {*} actual - The actual value (may be undefined if missing).
 * @param {*} expected - The expected value.
 * @param {string} unitId - The unit ID (for error messages).
 * @param {string[]} failures - Accumulator for failure messages.
 */
function _checkRequired(action, fieldPath, actual, expected, unitId, failures) {
  if (actual === undefined || actual === null) {
    failures.push(
      `unit "${unitId}", action "${action.id}": ${fieldPath} is missing, expected "${expected}"`,
    );
  } else if (actual !== expected) {
    failures.push(
      `unit "${unitId}", action "${action.id}": ${fieldPath} is "${actual}", expected "${expected}"`,
    );
  }
}
