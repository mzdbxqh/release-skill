/**
 * Prepare command: freeze a release plan with snapshots and gates.
 *
 * Runs the full prepare pipeline in order:
 * 1. Load and validate project configuration
 * 2. Capture Git baseline (HEAD, tree hash, dirty files)
 * 3. Run project-declared hooks (build, test)
 * 4. For each release unit: build snapshot, scan for leakage, evaluate README
 * 5. Check remote tag / version uniqueness (skipped in --offline mode)
 * 6. Assemble and validate the release plan against the plan schema
 * 7. Write the plan atomically
 *
 * If any gate fails, no PREPARED plan is written.
 *
 * @module commands/prepare
 */

import { resolve, relative, isAbsolute, normalize, dirname } from 'node:path';
import { readFile, mkdir, realpath } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

import { loadProjectConfig } from '../core/config.mjs';
import { captureBaseline } from '../core/baseline.mjs';
import { runHook } from '../core/hooks.mjs';
import { runSnapshotVerificationGates } from '../core/verification-gates.mjs';
import { createEvidenceWriter } from '../core/evidence.mjs';
import { computePlanDigest, writePlanAtomic, writePlanImmutable } from '../core/plan.mjs';
import { sha256Hex } from '../core/digest.mjs';
import { buildPublicStaging } from '../snapshot/public-map.mjs';
import { resolveUnitScopedPath } from '../snapshot/public-path.mjs';
import { scanSnapshot } from '../snapshot/scan.mjs';
import { evaluateReadme } from '../readme/contract.mjs';
import {
  buildFrozenGitRepository,
  buildFrozenNpmTarball,
  computeFrozenSnapshot,
  normalizeGitTimestamp,
  sealFrozenSnapshot,
} from '../snapshot/frozen.mjs';
import { ReleaseError, GATE_FAILED, CONFIG_INVALID, FORBIDDEN_CONTENT_DETECTED } from '../core/errors.mjs';
import { acquireProjectLock } from '../artifacts/project-lock.mjs';
import { assertPreviousPublicBaselineTarget, observePreviousPublicBaseline } from '../core/previous-public-baseline.mjs';
import { verifyFrozenNpmTarballIdentity } from '../adapters/npm.mjs';
import { createProductionPrepareRunDir } from '../core/run.mjs';

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the target version for a release unit.
 *
 * Resolution rules:
 * 1. If explicitVersion is provided, use it (overrides everything).
 * 2. Otherwise, read from `<root>/<unit.source>/<unit.version.source>`.
 * 3. Reject: absolute path, path escape, missing file, invalid JSON,
 *    missing/empty version field.
 * 4. For v0.1: if multiple units resolve to different versions, fail closed.
 *
 * @param {object} unit - The release unit configuration.
 * @param {string} root - Absolute project root.
 * @param {string} [explicitVersion] - Explicit version override.
 * @returns {Promise<string>} The resolved version string.
 * @throws {ReleaseError} CONFIG_INVALID or GATE_FAILED on any validation failure.
 */
async function resolveUnitVersion(unit, root, explicitVersion) {
  // Validate unit.version.source exists
  const versionSource = unit.version?.source;
  if (!versionSource || typeof versionSource !== 'string') {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unit "${unit.id}" missing version.source configuration`,
      { unitId: unit.id },
    );
  }

  // Reject absolute paths
  if (isAbsolute(versionSource)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unit "${unit.id}" version.source must be a relative path, got absolute: "${versionSource}"`,
      { unitId: unit.id, versionSource },
    );
  }

  // Resolve and normalize the path
  const unitRoot = resolve(root, unit.source);
  const resolvedPath = resolve(unitRoot, versionSource);
  const normalizedPath = normalize(resolvedPath);

  // Reject path escapes (must stay within unit root)
  const rel = relative(unitRoot, normalizedPath);
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unit "${unit.id}" version.source escapes unit root: "${versionSource}"`,
      { unitId: unit.id, versionSource, resolved: normalizedPath },
    );
  }

  // Read the file
  let content;
  try {
    content = await readFile(normalizedPath, 'utf8');
  } catch (err) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unit "${unit.id}" cannot read version file "${versionSource}": ${err.message}`,
      { unitId: unit.id, versionSource, cause: err.code },
    );
  }

  // Parse JSON
  let pkg;
  try {
    pkg = JSON.parse(content);
  } catch (err) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unit "${unit.id}" invalid JSON in "${versionSource}": ${err.message}`,
      { unitId: unit.id, versionSource },
    );
  }

  // Extract version field
  const version = pkg?.version;
  if (!version || typeof version !== 'string' || version.trim().length === 0) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unit "${unit.id}" missing or empty version field in "${versionSource}"`,
      { unitId: unit.id, versionSource, found: version },
    );
  }

  const authoritativeVersion = version.trim();
  if (explicitVersion && explicitVersion !== authoritativeVersion) {
    throw new ReleaseError(
      GATE_FAILED,
      `unit "${unit.id}" explicit version "${explicitVersion}" does not match authoritative version "${authoritativeVersion}" from "${versionSource}"`,
      { unitId: unit.id, explicitVersion, authoritativeVersion, versionSource },
    );
  }

  return authoritativeVersion;
}

/**
 * Resolve versions for all release units independently.
 *
 * @param {object[]} units - Array of release unit configurations.
 * @param {string} root - Absolute project root.
 * @param {string} [explicitVersion] - Explicit version override.
 * @param {object} evidence - The evidence writer.
 * @returns {Promise<string[]>} Array of resolved versions (one per unit).
 * @throws {ReleaseError} CONFIG_INVALID or GATE_FAILED on any validation failure.
 */
async function resolveAllUnitVersions(units, root, explicitVersion, evidence) {
  await evidence.append({ phase: 'version-resolution', status: 'started' });

  const resolvedVersions = [];
  for (const unit of units) {
    try {
      const version = await resolveUnitVersion(unit, root, explicitVersion);
      resolvedVersions.push(version);

    } catch (err) {
      await evidence.append({
        phase: 'version-resolution',
        status: 'failed',
        unitId: unit.id,
        error: { code: err.code, message: err.message },
      });
      throw err;
    }
  }

  await evidence.append({
    phase: 'version-resolution',
    status: 'completed',
    unitCount: units.length,
    resolvedVersions: Object.fromEntries(units.map((unit, index) => [unit.id, resolvedVersions[index]])),
    explicitVersion: !!explicitVersion,
  });

  return resolvedVersions;
}

// ---------------------------------------------------------------------------
// Hooks execution
// ---------------------------------------------------------------------------

/**
 * Run all declared project hooks in order: docs, build, test, typecheck.
 *
 * @param {object} config - The loaded project config.
 * @param {string} root - Absolute project root.
 * @param {object} evidence - The evidence writer.
 * @returns {Promise<void>}
 * @throws {ReleaseError} GATE_FAILED if any hook returns a non-zero exit code.
 */
async function runDeclaredHooks(config, root, evidence) {
  const hookOrder = ['docs', 'build', 'test', 'typecheck'];
  const hooks = config.hooks ?? {};

  for (const name of hookOrder) {
    const hook = hooks[name];
    if (!hook) continue;

    await evidence.append({
      phase: 'hooks',
      status: 'started',
      hookName: name,
    });

    let result;
    try {
      result = await runHook(hook, { root });
    } catch (err) {
      await evidence.append({
        phase: 'hooks',
        status: 'failed',
        hookName: name,
        error: { code: err.code, message: err.message },
      });
      throw new ReleaseError(
        GATE_FAILED,
        `hook "${name}" failed: ${err.message}`,
        { hookName: name, cause: err.code },
      );
    }

    if (result.exitCode !== 0) {
      await evidence.append({
        phase: 'hooks',
        status: 'failed',
        hookName: name,
        exitCode: result.exitCode,
        // Test runners usually emit the actionable failure summary at the
        // end. Preserve bounded tails of both streams instead of the noisy
        // compiler prelude at the beginning.
        stdoutTail: result.stdout.slice(-4000),
        stderrTail: result.stderr.slice(-4000),
      });
      throw new ReleaseError(
        GATE_FAILED,
        `hook "${name}" exited with code ${result.exitCode}`,
        { hookName: name, exitCode: result.exitCode },
      );
    }

    await evidence.append({
      phase: 'hooks',
      status: 'completed',
      hookName: name,
      exitCode: 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Snapshot pipeline
// ---------------------------------------------------------------------------

/**
 * Build snapshots for all release units, scan for leakage, and evaluate README.
 *
 * @param {object} config - The loaded project config.
 * @param {string} root - Absolute project root.
 * @param {object} evidence - The evidence writer.
 * @param {string} runDir - The run directory for temp snapshot storage.
 * @returns {Promise<{ unitResults: object[], snapshotDigests: string[] }>}
 * @throws {ReleaseError} GATE_FAILED on any snapshot/scan/readme gate failure.
 */
async function processSnapshots(config, root, evidence, runDir, production = false) {
  const units = config.releaseUnits ?? [];
  const unitResults = [];
  const snapshotDigests = [];

  for (const unit of units) {
    const outputDir = resolveUnitScopedPath(resolve(runDir, 'snapshots'), unit.id);

    // --- Build snapshot ---
    await evidence.append({
      phase: 'snapshot',
      status: 'started',
      unitId: unit.id,
      source: unit.source,
    });

    let manifest;
    try {
      // All units use explicit public file mappings — no implicit
      // git/package.json collection.
      const publicManifest = await buildPublicStaging({
        sourceRoot: root,
        unit,
        outputDir,
      });
      // Adapt the public manifest to the shape expected by downstream code.
      manifest = {
        entries: publicManifest.entries,
        files: publicManifest.entries.map((e) => e.path).sort(),
        totalSize: publicManifest.totalSize,
        fileCount: publicManifest.fileCount,
        contentHash: publicManifest.contentHash,
        snapshotDigest: publicManifest.contentHash,
        source: unit.source,
        outputDir: publicManifest.outputDir,
      };
    } catch (err) {
      await evidence.append({
        phase: 'snapshot',
        status: 'failed',
        unitId: unit.id,
        error: { code: err.code, message: err.message },
      });
      // Preserve original stable error codes (PUBLIC_FILE_MISSING,
      // SNAPSHOT_FIDELITY_FAILED, etc.) — do not wrap into GATE_FAILED.
      throw err;
    }

    snapshotDigests.push(manifest.snapshotDigest);

    await evidence.append({
      phase: 'snapshot',
      status: 'completed',
      unitId: unit.id,
      snapshotDigest: manifest.snapshotDigest,
      fileCount: manifest.fileCount,
      totalSize: manifest.totalSize,
    });

    // --- Scan for leakage ---
    await evidence.append({
      phase: 'scan',
      status: 'started',
      unitId: unit.id,
    });

    const findings = await scanSnapshot({
      snapshotDir: outputDir,
      policy: {
        forbiddenPaths: config.policy?.forbiddenPaths ?? [],
        forbiddenContentPatterns: config.policy?.forbiddenContentPatterns ?? [],
      },
    });

    // Check for fatal findings (secrets, forbidden paths, forbidden content)
    const FATAL_KINDS = new Set(['SECRET_DETECTED', 'PUBLIC_PATH_FORBIDDEN', 'FORBIDDEN_CONTENT_DETECTED']);
    const fatalFindings = findings.filter((f) => FATAL_KINDS.has(f.kind));

    if (fatalFindings.length > 0) {
      await evidence.append({
        phase: 'scan',
        status: 'failed',
        unitId: unit.id,
        findings: fatalFindings.map((f) => ({
          kind: f.kind,
          file: f.file,
          line: f.line,
          message: f.message,
        })),
      });

      // Use the specific error code for the first finding kind
      const primaryKind = fatalFindings[0].kind;
      const errorCode = primaryKind === 'FORBIDDEN_CONTENT_DETECTED'
        ? FORBIDDEN_CONTENT_DETECTED
        : GATE_FAILED;
      throw new ReleaseError(
        errorCode,
        `leakage scan failed for unit "${unit.id}": ${fatalFindings.length} finding(s)`,
        { unitId: unit.id, findings: fatalFindings },
      );
    }

    // Non-fatal findings (stale build artifacts) are logged but allowed
    const nonFatalFindings = findings.filter((f) => !FATAL_KINDS.has(f.kind));

    await evidence.append({
      phase: 'scan',
      status: 'completed',
      unitId: unit.id,
      fatalCount: 0,
      nonFatalCount: nonFatalFindings.length,
    });

    // --- Evaluate README ---
    await evidence.append({
      phase: 'readme',
      status: 'started',
      unitId: unit.id,
    });

    let readmeReport;
    try {
      readmeReport = await evaluateReadme({
        snapshotDir: outputDir,
      });
    } catch (err) {
      await evidence.append({
        phase: 'readme',
        status: 'failed',
        unitId: unit.id,
        error: { code: err.code, message: err.message },
      });
      throw new ReleaseError(
        GATE_FAILED,
        `README evaluation failed for unit "${unit.id}": ${err.message}`,
        { unitId: unit.id, cause: err.code },
      );
    }

    // Check required README markers — blocking finding for production prepare (Item 23)
    if (readmeReport.missing.length > 0) {
      if (production) {
        await evidence.append({
          phase: 'readme',
          status: 'blocking',
          unitId: unit.id,
          missingMarkers: readmeReport.missing,
        });
        throw new ReleaseError(
          GATE_FAILED,
          `README missing required markers for unit "${unit.id}": ${readmeReport.missing.join(', ')}`,
          { unitId: unit.id, missingMarkers: readmeReport.missing },
        );
      }
      // Non-production: warn but don't block
      await evidence.append({
        phase: 'readme',
        status: 'warning',
        unitId: unit.id,
        missingMarkers: readmeReport.missing,
      });
    }

    // Check readability (Item 23): installation, example, diagnosis — blocking for production
    const rc = readmeReport.readabilityChecks;
    const missingReadability = [];
    if (rc && !rc.hasInstall) missingReadability.push('install command');
    if (rc && !rc.hasMinimalExample) missingReadability.push('minimal example');
    if (rc && !rc.hasFailureDiagnosis) missingReadability.push('failure diagnosis');
    if (missingReadability.length > 0) {
      if (production) {
        await evidence.append({
          phase: 'readme',
          status: 'blocking',
          unitId: unit.id,
          missingReadability,
        });
        throw new ReleaseError(
          GATE_FAILED,
          `README missing readability requirements for unit "${unit.id}": ${missingReadability.join(', ')}`,
          { unitId: unit.id, missingReadability },
        );
      }
      // Non-production: warn but don't block
      await evidence.append({
        phase: 'readme',
        status: 'warning',
        unitId: unit.id,
        missingReadability,
      });
    }

    await evidence.append({
      phase: 'readme',
      status: 'completed',
      unitId: unit.id,
      presentMarkers: readmeReport.present,
    });

    unitResults.push({
      unit,
      manifest,
      readmeReport,
      nonFatalFindings,
    });
  }

  return { unitResults, snapshotDigests };
}

function resolveProductionBranch(unit, version) {
  const tagTemplate = unit.version?.tagTemplate ?? `${unit.id}-v{version}`;
  const tag = tagTemplate.replace('{version}', version);
  const branchTemplate = unit.production?.branchTemplate ?? 'release/{tag}';
  return {
    tag,
    branch: branchTemplate
      .replaceAll('{tag}', tag)
      .replaceAll('{version}', version)
      .replaceAll('{unit}', unit.id),
    branchStrategy: unit.production?.branchStrategy ?? 'create-release-branch',
  };
}

function normalizedProductionConfig(unit) {
  return {
    ...(unit.production ?? {}),
    githubHost: unit.production?.githubHost ?? 'github.com',
    branchTemplate: unit.production?.branchTemplate ?? 'release/{tag}',
    branchStrategy: unit.production?.branchStrategy ?? 'create-release-branch',
  };
}

async function buildProductionAssets(
  unitResults,
  resolvedVersions,
  root,
  runDir,
  unitBaselineResults,
  buildGitRepository = buildFrozenGitRepository,
  freezeTimestamp,
) {
  // The plan freeze timestamp is sampled exactly once by prepareRelease.
  // Every unit reuses this single value; the wall clock is never re-read.
  const canonicalFreezeTimestamp = normalizeGitTimestamp(freezeTimestamp, 'plan freeze timestamp');
  for (const { unit } of unitResults) {
    const npmDistribution = (unit.distributions ?? []).find((distribution) => distribution.type === 'npm');
    if (npmDistribution && !['public', 'restricted'].includes(npmDistribution.access)) {
      throw new ReleaseError(
        GATE_FAILED,
        `production npm distribution for unit "${unit.id}" requires explicit access: public or restricted`,
      );
    }
  }
  const assets = [];
  for (let index = 0; index < unitResults.length; index += 1) {
    const { unit, manifest } = unitResults[index];
    const version = resolvedVersions[index];
    const { tag, branch, branchStrategy } = resolveProductionBranch(unit, version);
    const snapshotPath = relative(root, manifest.outputDir);
    const observed = await computeFrozenSnapshot(manifest.outputDir);
    if (observed.digest !== manifest.snapshotDigest) {
      throw new ReleaseError(
        GATE_FAILED,
        `snapshot digest changed before production asset freeze for unit "${unit.id}"`,
        { expected: manifest.snapshotDigest, observed: observed.digest },
      );
    }

    // Freeze the byte/mode authority before deriving either distribution.
    // Git and npm must consume the same immutable snapshot, never two reads of
    // a writable staging directory separated by an attacker-controlled gap.
    await sealFrozenSnapshot(manifest.outputDir);
    const sealed = await computeFrozenSnapshot(manifest.outputDir);

    const repositoryDir = resolveUnitScopedPath(resolve(runDir, 'git'), unit.id, { suffix: '.git' });
    const unitBaseline = unitBaselineResults.get(unit.id);
    const parent = branchStrategy === 'create-release-branch'
      ? undefined
      : {
          githubHost: unitBaseline.githubHost,
          repo: unitBaseline.repo,
          ref: unitBaseline.ref,
          commit: unitBaseline.commit,
        };
    const git = await buildGitRepository({
      snapshotDir: manifest.outputDir,
      repositoryDir,
      version,
      expectedSnapshotDigest: sealed.digest,
      parent,
      commitTimestamp: canonicalFreezeTimestamp,
    });

    let npm = null;
    const npmDistribution = (unit.distributions ?? []).find((distribution) => distribution.type === 'npm');
    if (npmDistribution) {
      npm = await buildFrozenNpmTarball({
        snapshotDir: manifest.outputDir,
        tarballDir: resolveUnitScopedPath(resolve(runDir, 'tarballs'), unit.id),
        expectedSnapshotDigest: sealed.digest,
      });
      await verifyFrozenNpmTarballIdentity({
        package: npmDistribution.package,
        version,
        tarballPath: relative(root, npm.tarballPath),
        tarballSha256: npm.sha256,
        integrity: npm.integrity,
      }, root);
    }

    assets.push({
      snapshotPath,
      manifestDigest: sealed.digest,
      gitObjectDir: relative(root, repositoryDir),
      commit: git.commit,
      tree: git.tree,
      commitTimestamp: canonicalFreezeTimestamp,
      branchStrategy,
      ...(git.parentCommit ? { parentCommit: git.parentCommit } : {}),
      branch,
      tag,
      npm: npm ? {
        tarballPath: relative(root, npm.tarballPath),
        tarballSha256: npm.sha256,
        integrity: npm.integrity,
        size: npm.size,
      } : null,
    });
  }
  return assets;
}

// ---------------------------------------------------------------------------
// External actions generation
// ---------------------------------------------------------------------------

/**
 * Build the list of external actions that would be taken during publish.
 *
 * Each action is in PENDING status. Actions are generated per unit and
 * include: push-snapshot, create-tag, npm-publish, github-release.
 *
 * @param {object[]} unitResults - Results from processSnapshots.
 * @param {string} planVersion - The target version.
 * @param {string} realRoot - The project root for relative path calculation.
 * @returns {object[]} Array of external action descriptors.
 */
function buildExternalActions(unitResults, resolvedVersions, productionAssets) {
  const actions = [];

  const marketplaceIdentity = (distribution) => ({
    plugin: distribution.plugin,
    marketplace: distribution.marketplace,
    entrySkill: distribution.entrySkill,
  });

  if (!productionAssets) {
    for (let index = 0; index < unitResults.length; index += 1) {
      const { unit } = unitResults[index];
      const version = resolvedVersions[index];
      const tagTemplate = unit.version?.tagTemplate ?? `${unit.id}-v{version}`;
      const tag = tagTemplate.replace('{version}', version);
      actions.push({
        id: `push-snapshot-${unit.id}`,
        type: 'push-snapshot',
        adapter: 'git-github',
        unitId: unit.id,
        parameters: { source: unit.source, publicRepo: unit.publicRepo, version, cwd: unit.source },
        expected: { tag },
        status: 'PENDING',
      });
      actions.push({
        id: `create-tag-${unit.id}`,
        type: 'create-tag',
        adapter: 'git-github',
        unitId: unit.id,
        parameters: { tagTemplate, publicRepo: unit.publicRepo, version },
        status: 'PENDING',
      });
      const npmDistribution = (unit.distributions ?? []).find((item) => item.type === 'npm');
      if (npmDistribution) {
        actions.push({
          id: `npm-publish-${unit.id}`,
          type: 'npm-publish',
          adapter: 'npm',
          unitId: unit.id,
          parameters: {
            package: npmDistribution.package,
            version,
            cwd: unit.source,
            registry: npmDistribution.registry,
            publisher: npmDistribution.publisher,
          },
          expected: {
            package: npmDistribution.package,
            version,
            registry: npmDistribution.registry,
            publisher: npmDistribution.publisher,
          },
          status: 'PENDING',
        });
      }
      actions.push({
        id: `github-release-${unit.id}`,
        type: 'github-release',
        adapter: 'github',
        unitId: unit.id,
        parameters: { publicRepo: unit.publicRepo, version },
        status: 'PENDING',
      });
      // Consumer marketplace install actions (only when distribution declared)
      const claudeDist = (unit.distributions ?? []).find((d) => d.type === 'claude-plugin');
      if (claudeDist) {
        const identity = marketplaceIdentity(claudeDist);
        actions.push({
          id: `claude-marketplace-install-${unit.id}`,
          type: 'claude-marketplace-install',
          adapter: 'plugin-marketplace',
          unitId: unit.id,
          parameters: {
            consumer: 'claude',
            plugin: identity.plugin,
            marketplace: identity.marketplace,
            repo: unit.publicRepo,
            version,
            entrySkill: identity.entrySkill,
          },
          expected: {
            installed: true,
            plugin: identity.plugin,
            marketplace: identity.marketplace,
            version,
            entrySkill: identity.entrySkill,
          },
          status: 'PENDING',
        });
      }
      const codexDist = (unit.distributions ?? []).find((d) => d.type === 'codex-plugin');
      if (codexDist) {
        const identity = marketplaceIdentity(codexDist);
        actions.push({
          id: `codex-marketplace-install-${unit.id}`,
          type: 'codex-marketplace-install',
          adapter: 'plugin-marketplace',
          unitId: unit.id,
          parameters: {
            consumer: 'codex',
            plugin: identity.plugin,
            marketplace: identity.marketplace,
            repo: unit.publicRepo,
            version,
            entrySkill: identity.entrySkill,
          },
          expected: {
            installed: true,
            plugin: identity.plugin,
            marketplace: identity.marketplace,
            version,
            entrySkill: identity.entrySkill,
          },
          status: 'PENDING',
        });
      }
    }
    return actions;
  }

  for (let index = 0; index < unitResults.length; index += 1) {
    const { unit } = unitResults[index];
    const unitVersion = resolvedVersions[index];
    const asset = productionAssets[index];
    const tagTemplate = unit.version?.tagTemplate ?? `${unit.id}-v{version}`;
    const resolvedTag = asset.tag;

    // Push snapshot
    actions.push({
      id: `push-snapshot-${unit.id}`,
      type: 'push-snapshot',
      adapter: 'git-github',
      unitId: unit.id,
      parameters: {
        source: unit.source,
        publicRepo: unit.publicRepo,
        version: unitVersion,
        cwd: unit.source,
        snapshotPath: asset.snapshotPath,
        manifestDigest: asset.manifestDigest,
        gitObjectDir: asset.gitObjectDir,
        branch: asset.branch,
        repo: unit.publicRepo,
        githubHost: unit.production?.githubHost ?? 'github.com',
        commit: asset.commit,
        tree: asset.tree,
        branchStrategy: asset.branchStrategy,
        ...(asset.parentCommit ? { parentCommit: asset.parentCommit } : {}),
        ...(asset.branchStrategy === 'advance-existing-branch'
          ? { expectedBaselineCommit: asset.parentCommit }
          : {}),
      },
      expected: {
        branch: asset.branch,
        commit: asset.commit,
        tree: asset.tree,
        manifestDigest: asset.manifestDigest,
      },
      status: 'PENDING',
    });

    if (asset.branchStrategy === 'initialize-default-branch') {
      actions.push({
        id: `set-default-branch-${unit.id}`,
        type: 'set-default-branch',
        adapter: 'git-github',
        unitId: unit.id,
        parameters: {
          repo: unit.publicRepo,
          githubHost: unit.production?.githubHost ?? 'github.com',
          oldBranch: unit.production.expectedCurrentDefaultBranch,
          newBranch: asset.branch,
          expectedNewBranchCommit: asset.commit,
        },
        expected: { defaultBranch: asset.branch, newBranchCommit: asset.commit },
        status: 'PENDING',
      });
    }

    // Create tag
    actions.push({
      id: `create-tag-${unit.id}`,
      type: 'create-tag',
      adapter: 'git-github',
      unitId: unit.id,
      parameters: {
        tagTemplate,
        publicRepo: unit.publicRepo,
        version: unitVersion,
        tag: resolvedTag,
        repo: unit.publicRepo,
        githubHost: unit.production?.githubHost ?? 'github.com',
        gitObjectDir: asset.gitObjectDir,
        commit: asset.commit,
      },
      expected: { tag: resolvedTag, commit: asset.commit },
      status: 'PENDING',
    });

    // npm publish (only for npm distributions)
    const npmDist = (unit.distributions ?? []).find((d) => d.type === 'npm');
    if (npmDist) {
      actions.push({
        id: `npm-publish-${unit.id}`,
        type: 'npm-publish',
        adapter: 'npm',
        unitId: unit.id,
        parameters: {
          package: npmDist.package,
          version: unitVersion,
          cwd: unit.source,
          tarballPath: asset.npm.tarballPath,
          tarballSha256: asset.npm.tarballSha256,
          integrity: asset.npm.integrity,
          access: npmDist.access,
          provenance: npmDist.provenance === true,
          ...(npmDist.tag ? { tag: npmDist.tag } : {}),
          registry: npmDist.registry,
          publisher: npmDist.publisher,
        },
        expected: {
          package: npmDist.package,
          version: unitVersion,
          integrity: asset.npm.integrity,
          registry: npmDist.registry,
          publisher: npmDist.publisher,
        },
        status: 'PENDING',
      });
    }

    // GitHub release
    actions.push({
      id: `github-release-${unit.id}`,
      type: 'github-release',
      adapter: 'github',
      unitId: unit.id,
      parameters: {
        publicRepo: unit.publicRepo,
        version: unitVersion,
        tag: resolvedTag,
        repo: unit.publicRepo,
        githubHost: unit.production?.githubHost ?? 'github.com',
        commit: asset.commit,
        name: (unit.production?.releaseTitleTemplate ?? 'Release {tag}')
          .replaceAll('{tag}', resolvedTag)
          .replaceAll('{version}', unitVersion)
          .replaceAll('{unit}', unit.id),
        notes: unit.production?.releaseNotes ?? `Release ${resolvedTag}`,
      },
      expected: {
        tag: resolvedTag,
        commit: asset.commit,
      },
      status: 'PENDING',
    });

    // Consumer marketplace install actions (only when distribution declared)
    const claudeDist = (unit.distributions ?? []).find((d) => d.type === 'claude-plugin');
    if (claudeDist) {
      const identity = marketplaceIdentity(claudeDist);
      actions.push({
        id: `claude-marketplace-install-${unit.id}`,
        type: 'claude-marketplace-install',
        adapter: 'plugin-marketplace',
        unitId: unit.id,
        parameters: {
          consumer: 'claude',
          plugin: identity.plugin,
          marketplace: identity.marketplace,
          repo: unit.publicRepo,
          ref: resolvedTag,
          version: unitVersion,
          entrySkill: identity.entrySkill,
          snapshotPath: asset.snapshotPath,
          manifestDigest: asset.manifestDigest,
        },
        expected: {
          installed: true,
          consumer: 'claude',
          plugin: identity.plugin,
          marketplace: identity.marketplace,
          repo: unit.publicRepo,
          version: unitVersion,
          ref: resolvedTag,
          entrySkill: identity.entrySkill,
          entrySkillFound: true,
          manifestDigest: asset.manifestDigest,
        },
        status: 'PENDING',
      });
    }
    const codexDist = (unit.distributions ?? []).find((d) => d.type === 'codex-plugin');
    if (codexDist) {
      const identity = marketplaceIdentity(codexDist);
      actions.push({
        id: `codex-marketplace-install-${unit.id}`,
        type: 'codex-marketplace-install',
        adapter: 'plugin-marketplace',
        unitId: unit.id,
        parameters: {
          consumer: 'codex',
          plugin: identity.plugin,
          marketplace: identity.marketplace,
          repo: unit.publicRepo,
          ref: resolvedTag,
          version: unitVersion,
          entrySkill: identity.entrySkill,
          snapshotPath: asset.snapshotPath,
          manifestDigest: asset.manifestDigest,
        },
        expected: {
          installed: true,
          consumer: 'codex',
          plugin: identity.plugin,
          marketplace: identity.marketplace,
          repo: unit.publicRepo,
          version: unitVersion,
          ref: resolvedTag,
          entrySkill: identity.entrySkill,
          entrySkillFound: true,
          manifestDigest: asset.manifestDigest,
        },
        status: 'PENDING',
      });
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full prepare pipeline and freeze a release plan.
 *
 * @param {Object} options
 * @param {string} options.root - Absolute path to the project root.
 * @param {string} [options.version] - Target version override. If not provided,
 *   each unit's version is read from its configured source.
 * @param {boolean} [options.offline=true] - Skip remote checks when true.
 * @param {string} [options.output] - Path to write the plan. Defaults to
 *   `<root>/.release-skill/release-plan.json`.
 * @param {string} [options.runDir] - Directory for evidence. Defaults to
 *   `<root>/.release-skill/runs/prepare-<timestamp>`.
 * @param {() => string} [options.clock] - Clock function for timestamps.
 * @param {boolean} [options.hooksAuthorized] - Must be explicitly `true` when
 *   the project config declares hooks. Hooks are user-configured arbitrary
 *   local processes without filesystem/network isolation. Authorization
 *   means the user accepts hook side-effect risks, not that hooks are safe.
 * @param {boolean} [options.verificationGatesAuthorized] - Must be explicitly
 *   true when project verification gates are declared.
 *
 * @returns {Promise<{ planPath: string, planDigest: string, evidenceDir: string }>}
 *
 * @throws {ReleaseError} on any gate failure. No PREPARED plan is written.
 */
export async function prepareRelease(options) {
  const {
    root,
    version,
    offline = true,
    output,
    runDir: runDirOpt,
    clock,
    hooksAuthorized,
    verificationGatesAuthorized,
    production = false,
    observePreviousPublicBaselineFn,
  } = options ?? {};

  // --- Validate root ---
  if (!root || typeof root !== 'string') {
    throw new ReleaseError(CONFIG_INVALID, 'root must be a non-empty string');
  }

  // Resolve root to real path (follows system symlinks like macOS /var → /private/var).
  // This ensures outputDir paths use the real filesystem path, avoiding false
  // positives in ancestor symlink checks.
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch (err) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `cannot resolve root path: ${err.message}`,
      { root, cause: err.code },
    );
  }

  if (production) {
    const canonicalOutput = resolve(realRoot, '.release-skill', 'release-plan.json');
    if (output && resolve(output) !== canonicalOutput) {
      throw new ReleaseError(
        GATE_FAILED,
        'production prepare requires the canonical .release-skill/release-plan.json output; custom --output is supported only outside production',
        { output: resolve(output), expected: canonicalOutput },
      );
    }
  }

  // --- Acquire project lock (shared domain with all mutating artifact commands) ---
  const lock = await acquireProjectLock({ root: realRoot, command: 'prepare', mode: 'exclusive' });

  // --- Set up directories ---
  // Use realRoot for directory construction to avoid system symlink issues
  // (e.g., macOS /var → /private/var) in outputDir ancestor checks.
  const releaseDir = resolve(realRoot, '.release-skill');
  const runId = `prepare-${Date.now()}`;
  const rawRunDir = runDirOpt ?? resolve(releaseDir, 'runs', runId);
  let runDir;
  try {
    if (production) {
      runDir = await createProductionPrepareRunDir(rawRunDir, releaseDir);
    } else {
      await mkdir(rawRunDir, { recursive: true });
      // Resolve after mkdir to canonicalize system aliases such as /var → /private/var.
      runDir = await realpath(rawRunDir);
    }
  } catch (error) {
    await lock.release();
    throw error;
  }
  const evidenceDir = runDir;

  // --- Evidence writer ---
  const evidence = createEvidenceWriter({ runDir, command: 'prepare', clock });

  try {
    // --- Step 1: Load and validate config ---
    await evidence.append({ phase: 'config', status: 'started' });

    const { config, configPath, configDigest } = await loadProjectConfig({ root: realRoot });

    await evidence.append({
      phase: 'config',
      status: 'completed',
      configPath: relative(realRoot, configPath),
      configDigest,
    });

    // --- Step 2: Hook authorization gate ---
    // Hooks are user-configured arbitrary local processes without filesystem
    // or network isolation. They may write outside the project, access local
    // credentials, or make network calls. The user must explicitly accept
    // these risks before any hook is executed.
    const declaredHooks = Object.entries(config.hooks ?? {})
      .filter(([, hook]) => hook && hook.command)
      .map(([name, hook]) => ({
        name,
        executable: hook.command[0],
        args: hook.command.slice(1),
        cwd: hook.cwd ?? '.',
      }));

    if (declaredHooks.length > 0) {
      await evidence.append({
        phase: 'hook-authorization',
        status: 'started',
        hookCount: declaredHooks.length,
        hooks: declaredHooks.map((h) => `${h.name}: ${h.executable} ${h.args.join(' ')}`),
      });

      if (hooksAuthorized !== true) {
        const hookList = declaredHooks
          .map((h) => `  - ${h.name}: executable="${h.executable}", args=[${h.args.join(', ')}], cwd="${h.cwd}"`)
          .join('\n');

        await evidence.append({
          phase: 'hook-authorization',
          status: 'denied',
          reason: 'hooks not explicitly authorized',
        });

        throw new ReleaseError(
          GATE_FAILED,
          `project declares ${declaredHooks.length} hook(s) that will be executed as arbitrary local processes.\n` +
          `These hooks are NOT sandboxed — they may write to the filesystem outside the project, ` +
          `access local credentials, or make network calls.\n` +
          `The following hooks will run:\n${hookList}\n\n` +
          `To proceed, pass --acknowledge-hook-side-effects (CLI) or hooksAuthorized=true (API). ` +
          `Authorization means you accept hook side-effect risks; it does NOT make hooks safe.`,
          { hookNames: declaredHooks.map((h) => h.name), hookCount: declaredHooks.length },
        );
      }

      await evidence.append({
        phase: 'hook-authorization',
        status: 'authorized',
        hookCount: declaredHooks.length,
      });
    }

    const declaredVerificationGates = config.verificationGates ?? [];
    if (declaredVerificationGates.length > 0) {
      await evidence.append({
        phase: 'verification-gate-authorization',
        status: 'started',
        gateCount: declaredVerificationGates.length,
        gates: declaredVerificationGates.map((gate) => ({
          id: gate.id,
          phase: gate.phase,
          unitId: gate.scope.unit,
          distribution: gate.scope.distribution ?? null,
          executable: gate.command[0],
          args: gate.command.slice(1),
          cwd: gate.cwd,
        })),
      });
      if (verificationGatesAuthorized !== true) {
        await evidence.append({
          phase: 'verification-gate-authorization',
          status: 'denied',
          gateCount: declaredVerificationGates.length,
        });
        throw new ReleaseError(
          GATE_FAILED,
          `project declares ${declaredVerificationGates.length} verification gate(s). ` +
          'They run local project commands without a network sandbox. ' +
          'To proceed, pass --acknowledge-gate-side-effects (CLI) or verificationGatesAuthorized=true (API).',
          { gateIds: declaredVerificationGates.map((gate) => gate.id) },
        );
      }
      await evidence.append({
        phase: 'verification-gate-authorization',
        status: 'authorized',
        gateCount: declaredVerificationGates.length,
      });
    }

    // --- Step 3: Run declared hooks ---
    await evidence.append({ phase: 'hooks', status: 'started' });
    await runDeclaredHooks(config, realRoot, evidence);
    await evidence.append({ phase: 'hooks', status: 'completed' });

    // --- Step 4: Capture Git baseline (AFTER hooks, so workspaceDigest
    //     reflects any file changes introduced by hooks) ---
    await evidence.append({ phase: 'baseline', status: 'started' });

    const baseline = await captureBaseline(realRoot);

    await evidence.append({
      phase: 'baseline',
      status: 'completed',
      gitTreeHash: baseline.gitTreeHash,
      headCommit: baseline.gitHead,
      dirtyFileCount: baseline.statusEntries.length,
    });

    // --- Step 4b: Per-unit previous public baseline observe ---
    const configUnits = config.releaseUnits ?? [];
    const resolvedVersions = await resolveAllUnitVersions(
      configUnits,
      realRoot,
      version,
      evidence,
    );
    const defaultObserveFn = async (repo, ref, expectedCommit, { githubHost = 'github.com' } = {}) => {
      try {
        const { stdout } = await execFile("git", ["ls-remote", `https://${githubHost}/${repo}.git`, ref], {
          shell: false, encoding: "utf8", timeout: 30000,
        });
        const lines = stdout.trim().split("\n").filter(l => l.length > 0);
        if (lines.length === 0) return { status: "drifted", actual: null, diff: "ref not found on remote" };
        const [remoteCommit] = lines[0].split("\t");
        if (remoteCommit === expectedCommit) return { status: "consistent", actual: remoteCommit };
        return { status: "drifted", actual: remoteCommit, diff: "expected " + expectedCommit + ", got " + remoteCommit };
      } catch (err) {
        return { status: "unknown", error: err.message };
      }
    };
    const observeFn = options.observePreviousPublicBaselineFn ?? defaultObserveFn;
    const defaultObserveDefaultBranchFn = async (repo, { githubHost = 'github.com' } = {}) => {
      try {
        const { stdout } = await execFile(
          'gh',
          ['api', `repos/${repo}`, '--jq', '.default_branch'],
          {
            shell: false,
            encoding: 'utf8',
            timeout: 30000,
            env: { ...process.env, GH_HOST: githubHost },
          },
        );
        return { status: 'observed', defaultBranch: stdout.trim() };
      } catch (error) {
        return { status: 'unknown', error: error.message };
      }
    };
    const observeDefaultBranch = options.observeDefaultBranchFn ?? defaultObserveDefaultBranchFn;
    const unitBaselineResults = new Map();
    for (let unitIndex = 0; unitIndex < configUnits.length; unitIndex += 1) {
      const unit = configUnits[unitIndex];
      const ppbConfig = unit.previousPublicBaseline;
      if (!ppbConfig) continue;
      const productionGithubHost = unit.production?.githubHost ?? 'github.com';
      const { branch, branchStrategy } = resolveProductionBranch(unit, resolvedVersions[unitIndex]);
      if (production && ['advance-existing-branch', 'initialize-default-branch'].includes(branchStrategy)) {
        if (offline) {
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}" branch strategy "${branchStrategy}" requires online production prepare`,
            { unitId: unit.id, branchStrategy },
          );
        }
        if (ppbConfig.mode !== 'bound') {
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}" branch strategy "${branchStrategy}" requires previousPublicBaseline.mode=bound`,
            { unitId: unit.id, branchStrategy },
          );
        }
        if (
          branchStrategy === 'advance-existing-branch' &&
          ppbConfig.ref !== `refs/heads/${branch}`
        ) {
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}" advance-existing-branch baseline ref must equal refs/heads/${branch}`,
            { unitId: unit.id, expectedRef: `refs/heads/${branch}`, actualRef: ppbConfig.ref },
          );
        }
      }
      const effectivePpbConfig = ppbConfig.mode === 'bound'
        ? { ...ppbConfig, githubHost: productionGithubHost }
        : ppbConfig;
      assertPreviousPublicBaselineTarget({
        baseline: effectivePpbConfig,
        githubHost: productionGithubHost,
        publicRepo: unit.publicRepo,
      });

      if (ppbConfig.mode === "none") {
        unitBaselineResults.set(unit.id, {
          mode: "none",
          status: "consistent",
        });
        await evidence.append({
          phase: "previous-public-baseline",
          unitId: unit.id,
          status: "skipped",
          reason: "fresh repository",
        });
        continue;
      }

      if (offline) {
        // Production + bound + offline: fail closed before plan write
        if (production) {
          await evidence.append({
            phase: "previous-public-baseline",
            unitId: unit.id,
            status: "blocking",
            repo: ppbConfig.repo,
            ref: ppbConfig.ref,
            commit: ppbConfig.commit,
            reason: "production bound baseline requires --online observation",
          });
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}" has bound previousPublicBaseline but production prepare uses --offline. ` +
            `Must use --online to observe the previous public baseline before freezing a production plan.`,
            { unitId: unit.id, repo: ppbConfig.repo, ref: ppbConfig.ref },
          );
        }
        // Non-production offline: record unobserved-offline for local assessment
        unitBaselineResults.set(unit.id, {
          mode: "bound",
          githubHost: productionGithubHost,
          repo: ppbConfig.repo,
          ref: ppbConfig.ref,
          commit: ppbConfig.commit,
          status: "unobserved-offline",
        });
        await evidence.append({
          phase: "previous-public-baseline",
          unitId: unit.id,
          status: "unobserved-offline",
          reason: "offline mode",
        });
        continue;
      }

      // Online bound: observe the remote ref
      await evidence.append({
        phase: "previous-public-baseline",
        unitId: unit.id,
        status: "started",
        repo: ppbConfig.repo,
        ref: ppbConfig.ref,
      });

      let result;
      try {
        result = await observePreviousPublicBaseline({
          baseline: effectivePpbConfig,
          observeFn,
          evidence,
        });
      } catch (err) {
        // Observe failed (drifted or unknown): write blocking evidence with resolution options
        const observation = err?.details ?? {};
        const mappingDiff = observation.diff
          ? { status: "available", summary: observation.diff }
          : {
              status: "unavailable",
              reason: observation.error
                ? `remote mapping observation failed: ${observation.error}`
                : "remote ref-to-commit mapping could not be determined",
            };
        await evidence.append({
          phase: "previous-public-baseline",
          unitId: unit.id,
          status: "blocking",
          repo: ppbConfig.repo,
          ref: ppbConfig.ref,
          expected: ppbConfig.commit,
          expectedCommit: ppbConfig.commit,
          actual: observation.actual ?? null,
          diff: observation.diff ?? null,
          mappingDiff,
          contentDiff: {
            status: "unavailable",
            reason: "the default previous-baseline observer resolves only ref-to-commit mapping and does not fetch remote content",
          },
          error: { code: err.code, message: err.message },
          resolutionOptions: ["merge", "adopt", "reject"],
          guidance: "把已采用改动合并回 human-owned 权威源后重新 prepare",
        });
        throw err;
      }

      unitBaselineResults.set(unit.id, {
        mode: "bound",
        githubHost: productionGithubHost,
        repo: ppbConfig.repo,
        ref: ppbConfig.ref,
        commit: ppbConfig.commit,
        observedCommit: result?.observed?.actual ?? ppbConfig.commit,
        observedAt: (clock ? clock() : new Date().toISOString()),
        status: "consistent",
      });
      await evidence.append({
        phase: "previous-public-baseline",
        unitId: unit.id,
        status: "completed",
        consistent: true,
      });

      if (production && branchStrategy === 'initialize-default-branch') {
        const expectedCurrent = unit.production?.expectedCurrentDefaultBranch;
        const observedDefault = await observeDefaultBranch(unit.publicRepo, {
          githubHost: productionGithubHost,
        });
        await evidence.append({
          phase: 'default-branch-observe',
          unitId: unit.id,
          status: observedDefault.status,
          expectedCurrentDefaultBranch: expectedCurrent,
          observedCurrentDefaultBranch: observedDefault.defaultBranch ?? null,
          ...(observedDefault.error ? { error: observedDefault.error } : {}),
        });
        if (
          observedDefault.status !== 'observed' ||
          !observedDefault.defaultBranch ||
          observedDefault.defaultBranch !== expectedCurrent
        ) {
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}" GitHub default branch does not match expectedCurrentDefaultBranch`,
            {
              unitId: unit.id,
              expectedCurrentDefaultBranch: expectedCurrent,
              observedCurrentDefaultBranch: observedDefault.defaultBranch ?? null,
              observationStatus: observedDefault.status,
            },
          );
        }
      }
    }

    // --- Step 5: Build snapshots, scan, and evaluate README ---
    const { unitResults, snapshotDigests } = await processSnapshots(
      config, realRoot, evidence, runDir, production,
    );

    // Snapshot gates always run on disposable writable copies. The public
    // snapshot authority is re-digested after every gate and is never exposed
    // as the gate working directory.
    const snapshotGateResults = await runSnapshotVerificationGates({
      gates: declaredVerificationGates,
      unitResults,
      runDir,
      evidence,
      env: options.gateEnv ?? process.env,
    });
    await evidence.append({
      phase: 'snapshot-verify',
      status: 'completed',
      gateCount: snapshotGateResults.length,
    });

    // --- Step 6: Remote uniqueness (deferred to publish preflight) ---
    // Prepare only observes the previous public baseline (already done above).
    // Remote uniqueness checks (tag, GitHub Release, npm version) are deferred
    // to the publish phase's global preflight, which runs before any execute.
    if (!offline) {
      await evidence.append({
        phase: 'remote-check',
        status: 'deferred',
        reason: 'remote uniqueness checks (tag, GitHub Release, npm version) deferred to publish global preflight',
      });
    } else if (production) {
      await evidence.append({
        phase: 'remote-check',
        status: 'deferred',
        reason: 'offline production prepare is allowed only for an explicit fresh baseline; target branch, tag, GitHub Release, and npm uniqueness are deferred to publish global preflight before any execute',
      });
    } else {
      await evidence.append({ phase: 'remote-check', status: 'skipped', reason: 'offline mode' });
    }

    // --- Step 7: Build plan object ---
    await evidence.append({ phase: 'plan-assembly', status: 'started' });

    // Production plans sample their freeze timestamp exactly once, before the
    // first frozen Git object exists. This single canonical value becomes
    // GIT_AUTHOR_DATE/GIT_COMMITTER_DATE for every unit's frozen commit,
    // every unit's frozenSnapshot.commitTimestamp, and plan.createdAt. It is
    // thereby bound by the plan digest and the approval record; publish,
    // retry, and reconcile consume it from the frozen plan and never re-read
    // the wall clock. A missing or invalid injected value fails closed here,
    // before any Git write.
    const freezeTimestamp = production
      ? normalizeGitTimestamp(clock ? clock() : new Date().toISOString(), 'plan freeze timestamp')
      : null;

    const productionAssets = production
      ? await buildProductionAssets(
          unitResults,
          resolvedVersions,
          realRoot,
          runDir,
          unitBaselineResults,
          options.buildFrozenGitRepositoryFn ?? buildFrozenGitRepository,
          freezeTimestamp,
        )
      : null;

    const units = unitResults.map(({ unit, manifest }, idx) => {
      const unitVersion = resolvedVersions[idx];
      const unitBaseline = unitBaselineResults.get(unit.id);
      return {
        id: unit.id,
        targetVersion: unitVersion,
        source: unit.source,
        publicRepo: unit.publicRepo,
        tagTemplate: unit.version?.tagTemplate,
        snapshotDigest: snapshotDigests[idx],
        ...(productionAssets ? {
          productionConfig: normalizedProductionConfig(unit),
          frozenSnapshot: {
            path: productionAssets[idx].snapshotPath,
            manifestDigest: productionAssets[idx].manifestDigest,
            gitObjectDir: productionAssets[idx].gitObjectDir,
            branch: productionAssets[idx].branch,
            branchStrategy: productionAssets[idx].branchStrategy,
            commit: productionAssets[idx].commit,
            tree: productionAssets[idx].tree,
            commitTimestamp: productionAssets[idx].commitTimestamp,
            ...(productionAssets[idx].parentCommit
              ? { parentCommit: productionAssets[idx].parentCommit }
              : {}),
            npm: productionAssets[idx].npm,
          },
        } : {}),
        distributions: unit.distributions,
        ...(unitBaseline ? { previousPublicBaseline: unitBaseline } : {}),
      };
    });

    const externalActions = buildExternalActions(unitResults, resolvedVersions, productionAssets);

    // Compute overall snapshot digest
    const overallSnapshotDigest = sha256Hex(snapshotDigests.join(':'));

    const plan = {
      planVersion: 1,
      status: 'PREPARED',
      baseline: {
        gitTreeHash: baseline.gitTreeHash,
        headCommit: baseline.gitHead,
        workspaceDigestAlgorithm: baseline.workspaceDigestAlgorithm,
        workspaceDigest: baseline.workspaceDigest,
        dirtyFiles: baseline.statusEntries,
        capturedAt: baseline.capturedAt,
      },
      configDigest,
      verificationGates: config.verificationGates ?? [],
      snapshotDigest: overallSnapshotDigest,
      ...(production ? {
        production: {
          mode: 'github-npm-v1',
          assetRoot: relative(realRoot, runDir),
        },
      } : {}),
      units,
      externalActions,
      createdAt: production ? freezeTimestamp : (clock ? clock() : new Date().toISOString()),
    };

    await evidence.append({
      phase: 'plan-assembly',
      status: 'completed',
      unitCount: units.length,
      actionCount: externalActions.length,
    });

    // --- Step 8: Validate and write plan atomically ---
    await evidence.append({ phase: 'plan-write', status: 'started' });

    const latestPlanPath = output ?? resolve(releaseDir, 'release-plan.json');
    const plannedDigest = computePlanDigest(plan);
    const immutablePlanPath = resolve(dirname(latestPlanPath), 'plans', `${plannedDigest}.json`);
    const { planPath: writtenPath, planDigest } = await writePlanImmutable(immutablePlanPath, plan);
    // This is a convenience copy only. All downstream authority uses the
    // digest-addressed immutable path returned above.
    await writePlanAtomic(latestPlanPath, plan);

    await evidence.append({
      phase: 'plan-write',
      status: 'completed',
      planPath: writtenPath,
      planDigest,
    });

    // --- Write summary ---
    await evidence.finish({
      status: 'PREPARED',
      planPath: writtenPath,
      planDigest,
      configDigest,
      snapshotDigest: overallSnapshotDigest,
      unitCount: units.length,
      actionCount: externalActions.length,
      offline,
      completedAt: (clock ? clock() : new Date().toISOString()),
    });

    return {
      planPath: writtenPath,
      planDigest,
      evidenceDir,
    };
  } catch (err) {
    // Record failure evidence
    await evidence.append({
      phase: 'prepare',
      status: 'failed',
      error: { code: err.code, message: err.message },
    });

    await evidence.finish({
      status: 'FAILED',
      error: { code: err.code, message: err.message },
      failedAt: (clock ? clock() : new Date().toISOString()),
    });

    throw err;
  } finally {
    // Release project lock — always, even on failure
    await lock.release();
  }
}
