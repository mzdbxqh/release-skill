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

import { resolve, relative, isAbsolute, normalize } from 'node:path';
import { readFile, mkdir, realpath } from 'node:fs/promises';

import { loadProjectConfig } from '../core/config.mjs';
import { captureBaseline } from '../core/baseline.mjs';
import { runHook } from '../core/hooks.mjs';
import { createEvidenceWriter } from '../core/evidence.mjs';
import { writePlanAtomic } from '../core/plan.mjs';
import { sha256Hex } from '../core/digest.mjs';
import { buildPublicStaging } from '../snapshot/public-map.mjs';
import { resolveUnitScopedPath } from '../snapshot/public-path.mjs';
import { scanSnapshot } from '../snapshot/scan.mjs';
import { evaluateReadme } from '../readme/contract.mjs';
import {
  buildFrozenGitRepository,
  buildFrozenNpmTarball,
  computeFrozenSnapshot,
  sealFrozenSnapshot,
} from '../snapshot/frozen.mjs';
import { ReleaseError, GATE_FAILED, CONFIG_INVALID, FORBIDDEN_CONTENT_DETECTED } from '../core/errors.mjs';
import { acquireProjectLock } from '../artifacts/project-lock.mjs';

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
  // If explicit version provided, use it directly
  if (explicitVersion) {
    return explicitVersion;
  }

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

  return version.trim();
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
        stderr: result.stderr.slice(0, 2000),
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
async function processSnapshots(config, root, evidence, runDir) {
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

    // Check required README markers
    if (readmeReport.missing.length > 0) {
      await evidence.append({
        phase: 'readme',
        status: 'warning',
        unitId: unit.id,
        missingMarkers: readmeReport.missing,
      });
      // Non-fatal: missing markers are warnings during prepare
    } else {
      await evidence.append({
        phase: 'readme',
        status: 'completed',
        unitId: unit.id,
        presentMarkers: readmeReport.present,
      });
    }

    unitResults.push({
      unit,
      manifest,
      readmeReport,
      nonFatalFindings,
    });
  }

  return { unitResults, snapshotDigests };
}

async function buildProductionAssets(unitResults, resolvedVersions, root, runDir) {
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
    const tagTemplate = unit.version?.tagTemplate ?? `${unit.id}-v{version}`;
    const tag = tagTemplate.replace('{version}', version);
    const branchTemplate = unit.production?.branchTemplate ?? 'release/{tag}';
    const branch = branchTemplate
      .replaceAll('{tag}', tag)
      .replaceAll('{version}', version)
      .replaceAll('{unit}', unit.id);
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
    const git = await buildFrozenGitRepository({
      snapshotDir: manifest.outputDir,
      repositoryDir,
      version,
      expectedSnapshotDigest: sealed.digest,
    });

    let npm = null;
    const npmDistribution = (unit.distributions ?? []).find((distribution) => distribution.type === 'npm');
    if (npmDistribution) {
      npm = await buildFrozenNpmTarball({
        snapshotDir: manifest.outputDir,
        tarballDir: resolveUnitScopedPath(resolve(runDir, 'tarballs'), unit.id),
        expectedSnapshotDigest: sealed.digest,
      });
    }

    assets.push({
      snapshotPath,
      manifestDigest: sealed.digest,
      gitObjectDir: relative(root, repositoryDir),
      commit: git.commit,
      tree: git.tree,
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
          parameters: { package: npmDistribution.package, version, cwd: unit.source },
          expected: { package: npmDistribution.package, version },
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
      },
      expected: {
        branch: asset.branch,
        commit: asset.commit,
        tree: asset.tree,
        manifestDigest: asset.manifestDigest,
      },
      status: 'PENDING',
    });

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
        },
        expected: {
          package: npmDist.package,
          version: unitVersion,
          integrity: asset.npm.integrity,
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
    production = false,
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

  // --- Acquire project lock (shared domain with all mutating artifact commands) ---
  const lock = await acquireProjectLock({ root: realRoot, command: 'prepare', mode: 'exclusive' });

  // --- Set up directories ---
  // Use realRoot for directory construction to avoid system symlink issues
  // (e.g., macOS /var → /private/var) in outputDir ancestor checks.
  const releaseDir = resolve(realRoot, '.release-skill');
  const runId = `prepare-${Date.now()}`;
  const rawRunDir = runDirOpt ?? resolve(releaseDir, 'runs', runId);
  await mkdir(rawRunDir, { recursive: true });
  // Resolve runDir after mkdir to get canonical path (resolves /var → /private/var)
  const runDir = await realpath(rawRunDir);
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

    // --- Step 5: Build snapshots, scan, and evaluate README ---
    const { unitResults, snapshotDigests } = await processSnapshots(
      config, realRoot, evidence, runDir,
    );

    // --- Step 6: Remote uniqueness (skipped in offline mode) ---
    if (!offline) {
      await evidence.append({ phase: 'remote-check', status: 'started' });
      // Remote uniqueness checks (tag, GitHub Release, npm version) are not
      // yet implemented. Fail closed: throw before any plan is written.
      await evidence.append({ phase: 'remote-check', status: 'failed', reason: 'not yet implemented' });
      throw new ReleaseError(
        GATE_FAILED,
        'Remote uniqueness checks not yet implemented; use --offline',
        { phase: 'remote-check' },
      );
    } else {
      await evidence.append({ phase: 'remote-check', status: 'skipped', reason: 'offline mode' });
    }

    // --- Step 7: Build plan object ---
    await evidence.append({ phase: 'plan-assembly', status: 'started' });

    // Resolve versions for all units
    const resolvedVersions = await resolveAllUnitVersions(
      config.releaseUnits ?? [],
      realRoot,
      version,
      evidence,
    );

    const productionAssets = production
      ? await buildProductionAssets(unitResults, resolvedVersions, realRoot, runDir)
      : null;

    const units = unitResults.map(({ unit, manifest }, idx) => {
      const unitVersion = resolvedVersions[idx];
      return {
        id: unit.id,
        targetVersion: unitVersion,
        source: unit.source,
        publicRepo: unit.publicRepo,
        tagTemplate: unit.version?.tagTemplate,
        snapshotDigest: snapshotDigests[idx],
        ...(productionAssets ? {
          productionConfig: unit.production ?? {},
          frozenSnapshot: {
            path: productionAssets[idx].snapshotPath,
            manifestDigest: productionAssets[idx].manifestDigest,
            gitObjectDir: productionAssets[idx].gitObjectDir,
            branch: productionAssets[idx].branch,
            commit: productionAssets[idx].commit,
            tree: productionAssets[idx].tree,
            npm: productionAssets[idx].npm,
          },
        } : {}),
        distributions: unit.distributions,
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
        workspaceDigest: baseline.workspaceDigest,
        dirtyFiles: baseline.statusEntries,
        capturedAt: baseline.capturedAt,
      },
      configDigest,
      snapshotDigest: overallSnapshotDigest,
      ...(production ? {
        production: {
          mode: 'github-npm-v1',
          assetRoot: relative(realRoot, runDir),
        },
      } : {}),
      units,
      externalActions,
      createdAt: (clock ? clock() : new Date().toISOString()),
    };

    await evidence.append({
      phase: 'plan-assembly',
      status: 'completed',
      unitCount: units.length,
      actionCount: externalActions.length,
    });

    // --- Step 8: Validate and write plan atomically ---
    await evidence.append({ phase: 'plan-write', status: 'started' });

    const planPath = output ?? resolve(releaseDir, 'release-plan.json');
    const { planPath: writtenPath, planDigest } = await writePlanAtomic(planPath, plan);

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
