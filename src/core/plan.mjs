/**
 * Release plan schema validation, digest calculation, and atomic write.
 *
 * Provides:
 * - Embedded release-plan JSON Schema (superset of schemas/release-plan.schema.json)
 * - `validatePlan(plan)` -- validates a plan object against the schema
 * - `computePlanDigest(plan)` -- deterministic SHA-256 digest of the plan
 * - `writePlanAtomic(planPath, plan)` -- compute digest, embed it, validate, and
 *   write the plan atomically (temp-file + rename)
 *
 * @module core/plan
 */

import { writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import Ajv from 'ajv';
import { canonicalJson, sha256Hex } from './digest.mjs';
import { ReleaseError, GATE_FAILED } from './errors.mjs';

// ---------------------------------------------------------------------------
// Embedded release-plan JSON Schema (superset)
// ---------------------------------------------------------------------------

/**
 * Schema extends the formal `schemas/release-plan.schema.json` with fields
 * required by the prepare/approve workflow:
 * - `externalActions[].status` -- action lifecycle state
 * - `units[].snapshotDigest` -- snapshot content hash
 * - `configDigest` -- digest of the project configuration
 * - `snapshotDigest` -- overall snapshot digest
 */
const RELEASE_PLAN_SCHEMA = {
  $id: 'https://release-skill.dev/schemas/release-plan/v1',
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Release Plan',
  description: 'Schema for frozen release plan produced by the prepare phase',
  type: 'object',
  required: ['planVersion', 'status', 'baseline', 'units', 'externalActions'],
  additionalProperties: false,
  properties: {
    planVersion: {
      type: 'integer',
      const: 1,
    },
    status: {
      type: 'string',
      enum: [
        'DISCOVERED', 'ASSESSED', 'PREPARED', 'APPROVED',
        'PUBLISHING', 'PUBLISHED', 'VERIFIED',
        'NEEDS_INPUT', 'BLOCKED', 'PARTIAL',
      ],
    },
    baseline: {
      type: 'object',
      required: ['gitTreeHash'],
      additionalProperties: false,
      properties: {
        gitTreeHash: { type: 'string', minLength: 1 },
        headCommit: { type: 'string' },
        workspaceDigest: { type: 'string' },
        dirtyFiles: { type: 'array', items: { type: 'string' } },
        capturedAt: { type: 'string', format: 'date-time' },
      },
    },
    configDigest: {
      type: 'string',
      minLength: 1,
    },
    snapshotDigest: {
      type: 'string',
      minLength: 1,
    },
    production: {
      type: 'object',
      required: ['mode', 'assetRoot'],
      additionalProperties: false,
      properties: {
        mode: { type: 'string', const: 'github-npm-v1' },
        assetRoot: { type: 'string', minLength: 1 },
      },
    },
    units: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'targetVersion'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, pattern: '^(?!\\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$' },
          targetVersion: { type: 'string', minLength: 1 },
          source: { type: 'string' },
          publicRepo: { type: 'string' },
          tagTemplate: { type: 'string' },
          snapshotDigest: { type: 'string' },
          productionConfig: {
            type: 'object',
            additionalProperties: false,
            properties: {
              githubHost: { type: 'string' },
              branchTemplate: { type: 'string' },
              releaseTitleTemplate: { type: 'string' },
              releaseNotes: { type: 'string' },
            },
          },
          frozenSnapshot: {
            type: 'object',
            required: ['path', 'manifestDigest', 'gitObjectDir', 'branch', 'commit', 'tree'],
            additionalProperties: false,
            properties: {
              path: { type: 'string', minLength: 1 },
              manifestDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              gitObjectDir: { type: 'string', minLength: 1 },
              branch: { type: 'string', minLength: 1 },
              commit: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
              tree: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
              npm: {
                anyOf: [
                  { type: 'null' },
                  {
                    type: 'object',
                    required: ['tarballPath', 'tarballSha256', 'integrity', 'size'],
                    additionalProperties: false,
                    properties: {
                      tarballPath: { type: 'string', minLength: 1 },
                      tarballSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                      integrity: { type: 'string', minLength: 1 },
                      size: { type: 'integer', minimum: 1 },
                    },
                  },
                ],
              },
            },
          },
          distributions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['type'],
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: ['npm', 'claude-plugin', 'codex-plugin'] },
                package: {
                  type: 'string',
                  maxLength: 214,
                  pattern: '^(?:@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$',
                },
                access: { type: 'string', enum: ['public', 'restricted'] },
                provenance: { type: 'boolean' },
                tag: { type: 'string', minLength: 1 },
                plugin: { type: 'string', minLength: 1, pattern: '^[a-z0-9][a-z0-9._-]*$' },
                marketplace: { type: 'string', minLength: 1, pattern: '^[a-z0-9][a-z0-9._-]*$' },
                entrySkill: { type: 'string', minLength: 1, pattern: '^[a-z0-9][a-z0-9-]*$' },
                smokeBin: { type: 'string', minLength: 1 },
                smokeArgs: { type: 'array', items: { type: 'string' } },
                smokeExpectedJson: { type: 'object' },
              },
              allOf: [
                {
                  if: { properties: { type: { const: 'npm' } } },
                  then: { required: ['package'] },
                },
                {
                  if: { properties: { type: { enum: ['claude-plugin', 'codex-plugin'] } } },
                  then: { required: ['plugin', 'marketplace', 'entrySkill'] },
                },
                {
                  if: {
                    required: ['smokeExpectedJson'],
                    properties: { smokeBin: { minLength: 1 } },
                  },
                  then: { required: ['smokeBin'] },
                },
                {
                  if: {
                    required: ['smokeArgs'],
                    properties: { smokeBin: { minLength: 1 } },
                  },
                  then: { required: ['smokeBin'] },
                },
              ],
            },
          },
        },
      },
    },
    externalActions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'type', 'adapter'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          type: {
            type: 'string',
            enum: ['push-commit', 'push-snapshot', 'create-tag', 'npm-publish', 'github-release', 'claude-marketplace-install', 'codex-marketplace-install'],
          },
          adapter: { type: 'string', minLength: 1 },
          unitId: { type: 'string' },
          parameters: { type: 'object' },
          status: {
            type: 'string',
            enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'SKIPPED'],
          },
          expected: {
            type: 'object',
          },
        },
      },
    },
    createdAt: {
      type: 'string',
      format: 'date-time',
    },
    digest: {
      type: 'string',
      minLength: 1,
    },
    publishedAt: {
      type: 'string',
      format: 'date-time',
    },
    reconciledAt: {
      type: 'string',
      format: 'date-time',
    },
    waivers: {
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
// Schema validator (compiled once)
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });
const validatePlanSchema = ajv.compile(RELEASE_PLAN_SCHEMA);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
  const tmpPath = `${dir}/.release-plan-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmpPath, json, 'utf8');

  // 6. Atomic rename
  await rename(tmpPath, planPath);

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
      const expectedBranch = (productionConfig.branchTemplate ?? 'release/{tag}')
        .replaceAll('{tag}', expectedTag ?? '')
        .replaceAll('{version}', targetVersion ?? '')
        .replaceAll('{unit}', unitId);
      if (frozen.branch !== expectedBranch) {
        failures.push(`unit "${unitId}" frozen branch does not match productionConfig.branchTemplate`);
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
            _checkRequired(action, 'parameters.githubHost', action.parameters?.githubHost, productionConfig.githubHost ?? 'github.com', unitId, failures);
            _checkRequired(action, 'expected.commit', action.expected?.commit, frozen?.commit, unitId, failures);
            _checkRequired(action, 'expected.tree', action.expected?.tree, frozen?.tree, unitId, failures);
            _checkRequired(action, 'expected.manifestDigest', action.expected?.manifestDigest, frozen?.manifestDigest, unitId, failures);
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
