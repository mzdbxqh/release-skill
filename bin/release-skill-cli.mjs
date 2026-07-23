#!/usr/bin/env node

import { basename, dirname, join, resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { parseNodeMajor, meetsMinimum, computeReadinessStatus } from '../src/core/node-version.mjs';
import { registerPathRedactor } from '../src/core/errors.mjs';
import { redactSensitivePaths } from '../src/core/redact.mjs';

// Install the path-redaction choke point eagerly and synchronously (static
// imports, no top-level await) so every ReleaseError constructed on any
// command path is redacted from the very first statement — in source mode and
// in the self-contained bundle alike. The bundle evaluates these static
// imports during its top level, before any lazy command initialization or
// handler runs; keeping this module graph free of top-level await is also
// what lets the bundled artifacts tree settle (AC-7: the launcher must never
// exit 13 "Detected unsettled top-level await" for a command it owns).
registerPathRedactor(redactSensitivePaths);

const execFile = promisify(execFileCb);

const COMMANDS = new Set(['help', 'setup', 'assess', 'prepare', 'approve', 'publish', 'reconcile', 'verify', 'artifacts', 'docs']);

/**
 * Check if a command is available and get its version.
 *
 * @param {string} command - The command to check.
 * @param {string[]} versionArgs - Arguments to get version (e.g., ['--version']).
 * @returns {Promise<{available: boolean, version: string|null, required: boolean, diagnostic: string}>}
 */
async function checkDependency(command, versionArgs = ['--version']) {
  try {
    const { stdout } = await execFile(command, versionArgs, {
      shell: false,
      encoding: 'utf8',
      timeout: 5000,
    });
    const version = stdout.trim().split('\n')[0];
    return {
      available: true,
      version,
      required: command === 'node',
      diagnostic: 'ok',
    };
  } catch (err) {
    return {
      available: false,
      version: null,
      required: command === 'node',
      diagnostic: err.code === 'ENOENT' ? 'not found' : err.message,
    };
  }
}

/**
 * Perform environment and dependency checks.
 *
 * @returns {Promise<object>} Environment check results.
 */
async function performEnvironmentChecks() {
  const checks = {};

  // Node.js
  const nodeCheck = await checkDependency('node', ['--version']);
  checks.node = {
    ...nodeCheck,
    required: true,
    minimumVersion: '22.0.0',
    meetsMinimum: nodeCheck.available ? meetsMinimum(parseNodeMajor(nodeCheck.version), 22) : false,
  };

  // Git
  const gitCheck = await checkDependency('git', ['--version']);
  checks.git = {
    ...gitCheck,
    required: true,
    usage: '版本控制和 baseline 捕获',
  };

  // pnpm
  const pnpmCheck = await checkDependency('pnpm', ['--version']);
  checks.pnpm = {
    ...pnpmCheck,
    required: false,
    usage: '包管理（推荐）',
  };

  // npm
  const npmCheck = await checkDependency('npm', ['--version']);
  checks.npm = {
    ...npmCheck,
    required: false,
    usage: '包发布',
  };

  // GitHub CLI
  const ghCheck = await checkDependency('gh', ['--version']);
  checks.gh = {
    ...ghCheck,
    required: false,
    usage: 'GitHub 操作',
  };

  const claudeCheck = await checkDependency('claude', ['--version']);
  checks.claude = {
    ...claudeCheck,
    required: false,
    usage: '仅当计划声明 claude-plugin distribution 时用于消费者安装验证',
  };

  const codexCheck = await checkDependency('codex', ['--version']);
  checks.codex = {
    ...codexCheck,
    required: false,
    usage: '仅当计划声明 codex-plugin distribution 时用于消费者安装验证',
  };

  const kimiCheck = await checkDependency('kimi', ['--version']);
  checks.kimi = {
    ...kimiCheck,
    required: false,
    usage: '仅当计划声明 kimi-plugin distribution 时用于消费者安装验证',
  };

  return checks;
}

/**
 * Get capability maturity information.
 *
 * @returns {object} Capability maturity information.
 */
function getCapabilityMaturity() {
  return {
    setup: {
      available: true,
      mode: 'read-only dry-run / confirmed create-once',
      description: 'Discover first-use facts and create an absent config only after exact setupDigest confirmation',
    },
    assess: {
      available: true,
      mode: 'read-only',
      description: 'Read-only assessment of project release readiness',
    },
    prepare: {
      available: true,
      mode: 'offline local writes',
      description: 'Freeze a release plan with snapshots and gates',
    },
    docs: {
      available: true,
      mode: 'read-only dry-run / explicit local document write',
      description: 'Refresh declared README managed regions and CHANGELOG current-version entries from one structured notes source; write requires --write, exact --confirm-refresh, and --ack-local-document-write; never commits, pushes, or publishes',
    },
    publish: {
      available: true,
      mode: 'controlled production (protocol-tested; no OS/network sandbox)',
      description: 'Publishes frozen GitHub/npm artifacts and runs configured Claude/Codex/Kimi consumer checkpoints with approval and exact digest confirmation',
    },
    reconcile: {
      available: true,
      mode: 'evidence-based recovery (protocol-tested; no OS/network sandbox)',
      description: 'Reconcile PARTIAL runs, retry safe missing checkpoints, and stop for human decisions on conflicts',
    },
    verify: {
      available: true,
      mode: 'fresh consumer verification (protocol-tested; no OS/network sandbox)',
      description: 'Recheck remote state, exact npm installation, CLI help, and configured Claude/Codex/Kimi installs before VERIFIED',
    },
  };
}

function printHelp() {
  console.log(`release-skill - Release governance Skill family

Usage:
  release-skill <command> [options]

Commands:
  help       Show this help message and exit
  setup      Discover first-use configuration and gate candidates (dry-run by default)
  assess     Read-only assessment of project release readiness
  prepare    Freeze a release plan (release-skill output to .release-skill/; hooks may do remote ops)
  approve    Record local approval for a frozen release plan
  publish    Publish frozen GitHub/npm artifacts after approval and digest confirmation
  reconcile  Resume PARTIAL state from evidence; conflicts require a human
  verify     Fresh remote and consumer verification; only this reaches VERIFIED
  artifacts  Artifact status, inspect, update/apply, resolution, and diagnostics
  docs       Refresh declared release documents (read-only dry-run by default)

Options:
  --root <path>    Project root directory (default: cwd)
  --plan <path>    Path to the release plan file
  --run <path>     Path to the release run file (required for reconcile/verify)
  --approval <path> Path to the approval record
  --production     Prepare immutable Git/npm production artifacts
  --confirm-production <digest> Confirm the exact production plan digest
  --output <path>  Override prepare/approve output path (non-production only)
  --run-dir <path> Override prepare run directory; production requires one direct child of .release-skill/runs
  --answers <path> Human-reviewed setup answers JSON
  --write          Create an absent project.yaml during setup; never overwrites
  --confirm-setup <digest> Confirm exact setup facts and answers before create
  --unit <id>      Release unit whose declared release documents are refreshed (docs refresh)
  --confirm-refresh <sha256:...> Confirm the exact dry-run refreshDigest before any document write
  --ack-local-document-write Acknowledge the explicit local release-document write (docs refresh --write)
  --acknowledge-hook-side-effects Acknowledge unsandboxed legacy hook execution
  --acknowledge-gate-side-effects Acknowledge unsandboxed local verification gate execution
  --json           Output results as JSON
  --version        Show version and exit
  -h, --help       Show this help message and exit

Safety:
  Safe default: help -> setup (when config is absent) -> assess -> prepare --offline -> human review.
  Production happy end: prepare --production -> approve -> publish -> verify.
  prepare copies current public files into a local snapshot; it does not rewrite source files.
  - Default mode is offline (release-skill pipeline does no remote writes)
  - prepare output goes to .release-skill/ directory only
  - User-configured hooks may write anywhere and perform remote operations
  - To ensure zero remote writes, disable hooks or audit them separately
  - docs refresh --write rewrites only declared README managed regions and the current CHANGELOG entry after exact refreshDigest confirmation; it never commits, pushes, tags, publishes, or installs.
  - publish requires explicit approval and an exact plan-digest confirmation
  - publish consumes frozen Git/npm artifacts, never the live workspace
  - existing remote objects and uncertain checks stop for human intervention
  - production-equivalent protocol sandbox is verified; a real remote canary is not

First safe command:
  release-skill help --json    # Environment check (read-only)
  release-skill setup --root <path> --json  # First-use discovery (read-only)
  release-skill assess --root <path> --offline --json  # Project assessment`);
}

const args = process.argv.slice(2);
const hasJson = args.includes('--json');
const positional = args.filter(a => !a.startsWith('--'));
const command = positional[0];

if (!command && (args.includes('--version') || args.includes('-v'))) {
  // The version probe must be install-closure independent: the npm closure
  // resolves ../package.json from bin/, but the Claude and Codex adapter
  // closures ship the bundle at a different depth with no package.json at
  // all. Bundled closures therefore carry the package identity as a
  // build-time constant (__bundlePkg) injected by the esbuild banner in
  // scripts/build-bundle.mjs; only source mode reads the file.
  let pkg;
  if (typeof __bundlePkg !== 'undefined') {
    pkg = __bundlePkg;
  } else {
    // Source mode only (the bundle always carries __bundlePkg). Deliberately
    // not a require('../package.json'): esbuild would inline it into the
    // bundle as the one remaining bundle-relative file dependency, which is
    // exactly what breaks the adapter closures.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  }
  if (hasJson) {
    console.log(JSON.stringify({
      command: 'version',
      status: 'READY',
      name: pkg.name,
      version: pkg.version,
    }, null, 2));
  } else {
    console.log(pkg.version);
  }
  process.exit(0);
}

if (!command || command === 'help') {
  if (hasJson) {
    // Perform environment checks for --json mode
    const checks = await performEnvironmentChecks();
    const capabilities = getCapabilityMaturity();

    // Compute readiness: Node >=22 and Git are required; pnpm/npm/gh are optional
    const readiness = computeReadinessStatus({
      nodeAvailable: checks.node.available,
      nodeMeetsMinimum: checks.node.meetsMinimum,
      gitAvailable: checks.git.available,
    });
    const missingRequired = [];
    if (!checks.node.available || !checks.node.meetsMinimum) missingRequired.push('node>=22');
    if (!checks.git.available) missingRequired.push('git');
    const productionMissing = [
      ...missingRequired,
      ...(!checks.npm.available ? ['npm'] : []),
      ...(!checks.gh.available ? ['gh'] : []),
    ];

    const output = {
      command: 'help',
      mode: 'environment-check',
      status: readiness.status,
      missingRequired,
      readiness: {
        localPreparation: {
          status: readiness.status,
          missingRequired,
        },
        productionPublish: {
          status: productionMissing.length > 0 ? 'NOT_READY' : 'AUTH_CHECK_REQUIRED',
          missingRequired: productionMissing,
          authentication: '运行生产发布前还需验证 gh auth、Git HTTPS credential 与 npm auth；help 不发起网络认证检查。',
          conditionalConsumers: {
            claude: '声明 claude-plugin distribution 时必须可用',
            codex: '声明 codex-plugin distribution 时必须可用',
            kimi: '声明 kimi-plugin distribution 时必须可用',
          },
        },
      },
      checks,
      capabilities,
      maturity: {
        setup: 'read-only by default; create-once requires answers plus exact setupDigest confirmation',
        assess: 'read-only (default); --output writes local report',
        prepare: 'offline local writes; configured hooks/gates require their explicit side-effect acknowledgements',
        docs: 'read-only dry-run by default; write requires --write, exact --confirm-refresh, and --ack-local-document-write; never commits, pushes, or publishes',
        onlinePrepare: 'previous-public-baseline observation available; production mode freezes publish artifacts and fails closed on drift or unknown state',
        publish: 'GitHub/npm plus configured Claude/Codex/Kimi consumer checkpoints are protocol-tested without an OS/network sandbox; approval and exact digest confirmation required',
        reconcile: 'PARTIAL recovery is protocol-tested without an OS/network sandbox; remote conflicts require human intervention',
        verify: 'fresh exact npm and Claude/Codex/Kimi consumer installation checks are protocol-tested without an OS/network sandbox; configured consumer processes require explicit acknowledgement; success reaches VERIFIED',
      },
      recommendations: [],
    };

    // Add recommendations based on checks
    if (!checks.node.available) {
      output.recommendations.push('Install Node.js >= 22.0.0');
    } else if (checks.node.available && !checks.node.meetsMinimum) {
      output.recommendations.push('Upgrade Node.js to version 22 or later');
    }

    if (!checks.git.available) {
      output.recommendations.push('Install Git for version control operations');
    }

    if (!checks.pnpm.available) {
      output.recommendations.push('Install pnpm for package management (optional)');
    }

    if (!checks.npm.available) {
      output.recommendations.push('Install npm for package publishing (optional)');
    }

    if (!checks.gh.available) {
      output.recommendations.push('Install GitHub CLI for GitHub operations (optional)');
    }

    if (!checks.claude.available) {
      output.recommendations.push('Install Claude CLI before releasing a configured claude-plugin distribution');
    }

    if (!checks.codex.available) {
      output.recommendations.push('Install Codex CLI before releasing a configured codex-plugin distribution');
    }

    if (!checks.kimi.available) {
      output.recommendations.push('Install Kimi Code CLI before releasing a configured kimi-plugin distribution');
    }

    console.log(JSON.stringify(output, null, 2));
    process.exit(readiness.status === 'READY' ? 0 : 1);
  } else {
    printHelp();
    process.exit(0);
  }
}

if (!COMMANDS.has(command)) {
  if (hasJson) {
    const output = {
      error: 'UNKNOWN_COMMAND',
      message: `Unknown command: ${command}`,
      exitCode: 2
    };
    console.log(JSON.stringify(output));
  } else {
    console.error(`Error: Unknown command '${command}'`);
    console.error('Run "release-skill help" for available commands.');
  }
  process.exit(2);
}

// --- Setup command routing ---
if (command === 'setup') {
  const rootIdx = args.indexOf('--root');
  const rawRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const root = resolve(rawRoot);
  const answersIdx = args.indexOf('--answers');
  const answersPath = answersIdx !== -1 && args[answersIdx + 1] ? args[answersIdx + 1] : undefined;
  const confirmationIdx = args.indexOf('--confirm-setup');
  const confirmSetup = confirmationIdx !== -1 && args[confirmationIdx + 1]
    ? args[confirmationIdx + 1]
    : undefined;
  const write = args.includes('--write');
  try {
    const { setupProject } = await import('../src/commands/setup.mjs');
    const report = await setupProject({ root, answersPath, write, confirmSetup });
    if (hasJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Setup status: ${report.status}`);
      if (report.setupDigest) console.log(`Setup digest: ${report.setupDigest}`);
      if (report.configPath) console.log(`Config: ${report.configPath}`);
      if (report.next) console.log(`Next: ${report.next}`);
    }
    process.exit(['READY_TO_WRITE', 'CONFIG_CREATED', 'ALREADY_CONFIGURED'].includes(report.status) ? 0 : 2);
  } catch (err) {
    if (hasJson) {
      console.log(JSON.stringify({
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        details: err.details ?? {},
        exitCode: err.exitCode ?? 1,
      }));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Assess command routing ---
if (command === 'assess') {
  const rootIdx = args.indexOf('--root');
  const rawRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const root = resolve(rawRoot);
  const offline = args.includes('--offline') || !args.includes('--online');
  const outputIdx = args.indexOf('--output');
  const output = outputIdx !== -1 && args[outputIdx + 1] ? args[outputIdx + 1] : undefined;

  try {
    const { assessProject } = await import('../src/commands/assess.mjs');
    const report = await assessProject({ root, offline, output });

    if (hasJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(report.summary);
    }

    process.exit(report.status === 'ASSESSED' ? 0 : 1);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        details: err.details ?? {},
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Prepare command routing ---
if (command === 'prepare') {
  const rootIdx = args.indexOf('--root');
  const rawRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const root = resolve(rawRoot);
  const offline = args.includes('--offline') || !args.includes('--online');

  // Resolve target version from --target-version or --version flag
  let targetVersion;
  for (const flag of ['--target-version', '--version']) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1]) {
      targetVersion = args[idx + 1];
      break;
    }
  }

  const hooksAuthorized = args.includes('--acknowledge-hook-side-effects');
  const verificationGatesAuthorized = args.includes('--acknowledge-gate-side-effects');
  const production = args.includes('--production');
  const outputIdx = args.indexOf('--output');
  const output = outputIdx !== -1 && args[outputIdx + 1] ? resolve(args[outputIdx + 1]) : undefined;
  const runDirIdx = args.indexOf('--run-dir');
  const runDir = runDirIdx !== -1 && args[runDirIdx + 1] ? resolve(args[runDirIdx + 1]) : undefined;

  try {
    const { prepareRelease } = await import('../src/commands/prepare.mjs');
    const { readFile: readFileFs } = await import('node:fs/promises');
    const result = await prepareRelease({
      root,
      version: targetVersion,
      offline,
      hooksAuthorized,
      verificationGatesAuthorized,
      production,
      output,
      runDir,
    });

    if (hasJson) {
      // Output the full plan object plus metadata so consumers
      // can inspect status, units, externalActions, planDigest, etc.
      const planContent = await readFileFs(result.planPath, 'utf8');
      const plan = JSON.parse(planContent);
      console.log(JSON.stringify({
        ...plan,
        planPath: result.planPath,
        planDigest: result.planDigest,
        evidenceDir: result.evidenceDir,
      }, null, 2));
    } else {
      console.log(`Plan frozen at: ${result.planPath}`);
      console.log(`Plan digest: ${result.planDigest}`);
      console.log(`Evidence: ${result.evidenceDir}`);
    }

    process.exit(0);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        details: err.details ?? {},
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Approve command routing ---
if (command === 'approve') {

  const planIdx = args.indexOf('--plan');
  const planPath = planIdx !== -1 && args[planIdx + 1] ? args[planIdx + 1] : undefined;
  const digestIdx = args.indexOf('--digest');
  const expectedDigest = digestIdx !== -1 && args[digestIdx + 1] ? args[digestIdx + 1] : undefined;
  const actorIdx = args.indexOf('--actor');
  const actor = actorIdx !== -1 && args[actorIdx + 1] ? args[actorIdx + 1] : undefined;
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 && args[outputIdx + 1] ? resolve(args[outputIdx + 1]) : undefined;

  if (!planPath || !expectedDigest || !actor) {
    const msg = 'approve requires --plan <path>, --digest <sha256>, and --actor <name>';
    if (hasJson) {
      console.log(JSON.stringify({ error: 'MISSING_PARAMETERS', message: msg, exitCode: 1 }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }

  try {
    const { approvePlan } = await import('../src/commands/approve.mjs');
    const resolvedPlanPath = resolve(planPath);
    const planDir = dirname(resolvedPlanPath);
    const releaseDir = basename(planDir) === 'plans' && basename(resolvedPlanPath) === `${expectedDigest}.json`
      ? dirname(planDir)
      : planDir;
    const approvalPath = outputPath ?? join(releaseDir, 'approval-record.json');
    const record = await approvePlan({ planPath, expectedDigest, actor, outputPath: approvalPath });

    if (hasJson) {
      console.log(JSON.stringify(record, null, 2));
    } else {
      console.log(`Plan approved by ${record.actor}`);
      console.log(`Approval record: ${record.approvalPath}`);
      console.log(`Expires at: ${record.expiresAt}`);
    }

    process.exit(0);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Reconcile command routing ---
if (command === 'reconcile') {

  const rootIdx = args.indexOf('--root');
  const rawRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const root = resolve(rawRoot);
  const planIdx = args.indexOf('--plan');
  const planPath = planIdx !== -1 && args[planIdx + 1] ? resolve(args[planIdx + 1]) : undefined;
  const runIdx = args.indexOf('--run');
  const runPath = runIdx !== -1 && args[runIdx + 1] ? resolve(args[runIdx + 1]) : undefined;
  const approvalIdx = args.indexOf('--approval');
  const approvalPath = approvalIdx !== -1 && args[approvalIdx + 1] ? resolve(args[approvalIdx + 1]) : undefined;
  const confirmationIdx = args.indexOf('--confirm-production');
  const productionConfirmation = confirmationIdx !== -1 && args[confirmationIdx + 1]
    ? args[confirmationIdx + 1]
    : undefined;

  if (!planPath || !runPath) {
    const msg = 'reconcile requires --plan <path> and --run <path>';
    if (hasJson) {
      console.log(JSON.stringify({ error: 'MISSING_PARAMETERS', message: msg, exitCode: 1 }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }

  try {
    const { reconcileRelease } = await import('../src/commands/reconcile.mjs');
    const { createGitGithubAdapter } = await import('../src/adapters/git-github.mjs');
    const { createNpmAdapter } = await import('../src/adapters/npm.mjs');
    const { createPluginMarketplaceAdapter } = await import('../src/adapters/plugin-marketplace.mjs');
    const { createPushSnapshotAdapter } = await import('../src/adapters/push-snapshot.mjs');
    const { createAdapterRegistry } = await import('../src/adapters/contract.mjs');
    const registry = createAdapterRegistry([
      createGitGithubAdapter(),
      createNpmAdapter(),
      createPluginMarketplaceAdapter(),
      createPushSnapshotAdapter(),
    ]);

    const result = await reconcileRelease({
      planPath,
      sourceRunPath: runPath,
      approvalPath,
      adapterRegistry: registry,
      root,
      productionConfirmation,
    });

    if (hasJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Reconcile status: ${result.status}`);
      for (const cp of result.checkpoints) {
        console.log(`  ${cp.actionId}: ${cp.status}`);
      }
    }

    process.exit(result.status === 'PUBLISHED' ? 0 : 1);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Verify command routing ---
if (command === 'verify') {

  const rootIdx = args.indexOf('--root');
  const rawRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const root = resolve(rawRoot);
  const planIdx = args.indexOf('--plan');
  const planPath = planIdx !== -1 && args[planIdx + 1] ? resolve(args[planIdx + 1]) : undefined;
  const runIdx = args.indexOf('--run');
  const runPath = runIdx !== -1 && args[runIdx + 1] ? resolve(args[runIdx + 1]) : undefined;
  const verificationGatesAuthorized = args.includes('--acknowledge-gate-side-effects');

  if (!planPath || !runPath) {
    const msg = 'verify requires --plan <path> and --run <path>';
    if (hasJson) {
      console.log(JSON.stringify({ error: 'MISSING_PARAMETERS', message: msg, exitCode: 1 }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }

  try {
    const { verifyRelease } = await import('../src/commands/verify.mjs');
    const { createGitGithubAdapter } = await import('../src/adapters/git-github.mjs');
    const { createNpmAdapter } = await import('../src/adapters/npm.mjs');
    const { createPluginMarketplaceAdapter } = await import('../src/adapters/plugin-marketplace.mjs');
    const { createPushSnapshotAdapter } = await import('../src/adapters/push-snapshot.mjs');
    const { createAdapterRegistry } = await import('../src/adapters/contract.mjs');
    const registry = createAdapterRegistry([
      createGitGithubAdapter(),
      createNpmAdapter(),
      createPluginMarketplaceAdapter(),
      createPushSnapshotAdapter(),
    ]);

    const result = await verifyRelease({
      planPath,
      sourceRunPath: runPath,
      adapterRegistry: registry,
      root,
      verificationGatesAuthorized,
    });

    if (hasJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Verify status: ${result.status}`);
      console.log(`Adapter checks: ${result.adapterChecks.length} passed`);
      console.log(`Smoke test: ${result.smokeTest.passed ? 'PASSED' : 'FAILED'}`);
    }

    process.exit(result.status === 'VERIFIED' ? 0 : 1);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Publish command routing ---
if (command === 'publish') {

  const rootIdx = args.indexOf('--root');
  const rawRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const root = resolve(rawRoot);
  const planIdx = args.indexOf('--plan');
  const planPath = planIdx !== -1 && args[planIdx + 1] ? resolve(args[planIdx + 1]) : undefined;
  const approvalIdx = args.indexOf('--approval');
  const approvalPath = approvalIdx !== -1 && args[approvalIdx + 1] ? resolve(args[approvalIdx + 1]) : undefined;
  const confirmationIdx = args.indexOf('--confirm-production');
  const productionConfirmation = confirmationIdx !== -1 && args[confirmationIdx + 1]
    ? args[confirmationIdx + 1]
    : undefined;

  if (!planPath || !approvalPath || !productionConfirmation) {
    const msg = 'publish requires --plan <path>, --approval <path>, and --confirm-production <plan-digest>';
    if (hasJson) {
      console.log(JSON.stringify({ error: 'MISSING_PARAMETERS', message: msg, exitCode: 1 }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }

  try {
    const { publishRelease } = await import('../src/commands/publish.mjs');
    const { createGitGithubAdapter } = await import('../src/adapters/git-github.mjs');
    const { createNpmAdapter } = await import('../src/adapters/npm.mjs');
    const { createPluginMarketplaceAdapter } = await import('../src/adapters/plugin-marketplace.mjs');
    const { createPushSnapshotAdapter } = await import('../src/adapters/push-snapshot.mjs');
    const { createAdapterRegistry } = await import('../src/adapters/contract.mjs');
    const registry = createAdapterRegistry([
      createGitGithubAdapter(),
      createNpmAdapter(),
      createPluginMarketplaceAdapter(),
      createPushSnapshotAdapter(),
    ]);

    const result = await publishRelease({
      planPath,
      approvalPath,
      adapterRegistry: registry,
      root,
      productionMode: true,
      productionConfirmation,
    });

    if (hasJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Publish status: ${result.status}`);
      for (const cp of result.checkpoints) {
        console.log(`  ${cp.actionId}: ${cp.status}`);
      }
    }

    process.exit(result.status === 'PUBLISHED' ? 0 : 1);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Artifacts command routing ---
if (command === 'artifacts') {
  const rootIdx = args.indexOf('--root');
  const rawRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const root = resolve(rawRoot);
  const outputIdx = args.indexOf('--output');
  const output = outputIdx !== -1 && args[outputIdx + 1] ? resolve(args[outputIdx + 1]) : undefined;

  const subcommand = positional[1] ?? 'status';

  try {
    const { runArtifactsCommand } = await import('../src/commands/artifacts.mjs');
    const result = await runArtifactsCommand({ subcommand, args, root });

    if (hasJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Status: ${result.status}`);
      console.log(`Safe to write: ${result.safeToWrite}`);
      console.log(`Target unchanged: ${result.targetUnchanged}`);
      if (result.nextAction) {
        console.log(`Next action: ${result.nextAction.command}`);
      }
    }

    // Exit code: 0 if clean/safe/drift-detected (dry-run), 1 if blocking
    const blockingStatuses = new Set([
      'BASE_UNAVAILABLE', 'POLICY_INVALID', 'PATH_UNSAFE',
      'CONFLICT', 'DIRTY_SCOPE_CONFLICT',
    ]);
    process.exit(blockingStatuses.has(result.status) ? 1 : 0);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        status: err.code ?? 'UNKNOWN_ERROR',
        safeToWrite: false,
        targetUnchanged: true,
        evidenceDir: null,
        nextAction: { command: 'artifacts inspect --root <path>' },
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Docs command routing ---
if (command === 'docs') {
  try {
    const { ReleaseError, MISSING_PARAMETERS } = await import('../src/core/errors.mjs');

    // --root is extracted and validated here (the router resolves the project
    // root): a following flag is never accepted as the path, and a duplicated
    // --root is an explicit parameter error (previously silently ignored).
    const rootIndexes = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--root') rootIndexes.push(i);
    }
    if (rootIndexes.length > 1) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        'docs received --root more than once',
        { reason: 'DUPLICATE_PARAMETER', field: '--root' },
      );
    }
    let rawRoot = process.cwd();
    if (rootIndexes.length === 1) {
      rawRoot = args[rootIndexes[0] + 1];
      if (typeof rawRoot !== 'string' || rawRoot.length === 0 || rawRoot.startsWith('-')) {
        throw new ReleaseError(
          MISSING_PARAMETERS,
          'docs --root requires a path value',
          { reason: 'MISSING_VALUE', field: '--root' },
        );
      }
    }
    const root = resolve(rawRoot);

    // The docs subcommand is the first bare positional token after the `docs`
    // command token itself. Valued flags and their values are skipped so
    // `--root <path>` can never be mistaken for the subcommand; any flag
    // outside the recognized docs set (including unregistered valued flags)
    // is rejected here so its value can never be mistaken for the subcommand.
    const valuedDocsFlags = new Set(['--root', '--unit', '--confirm-refresh']);
    const booleanDocsFlags = new Set(['--json', '--write', '--ack-local-document-write']);
    let docsSubcommand;
    let sawCommandToken = false;
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i];
      if (typeof token !== 'string') continue;
      if (token.startsWith('--')) {
        const eq = token.indexOf('=');
        const flag = eq === -1 ? token : token.slice(0, eq);
        if (valuedDocsFlags.has(flag)) {
          if (eq === -1) i += 1; // space-separated form: skip the value too
          continue;
        }
        if (booleanDocsFlags.has(flag)) continue;
        throw new ReleaseError(
          MISSING_PARAMETERS,
          `docs does not accept ${flag}`,
          { reason: 'UNRECOGNIZED_PARAMETER', parameter: flag },
        );
      }
      if (token.startsWith('-') && token.length > 1) {
        throw new ReleaseError(
          MISSING_PARAMETERS,
          `docs does not accept ${token}`,
          { reason: 'UNRECOGNIZED_PARAMETER', parameter: token },
        );
      }
      if (!sawCommandToken) {
        sawCommandToken = true; // the `docs` command token itself
        continue;
      }
      docsSubcommand = token;
      break;
    }

    const { runDocsCommand } = await import('../src/commands/docs.mjs');
    const result = await runDocsCommand({ subcommand: docsSubcommand, args, root });

    if (hasJson) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.mode === 'dry-run') {
      console.log(`Status: ${result.status}`);
      console.log(`Unit: ${result.unitId}`);
      console.log(`Version: ${result.version}`);
      console.log(`Refresh digest: ${result.refreshDigest}`);
      for (const file of result.files) {
        const marker = file.changed ? '' : ' (unchanged)';
        console.log(`  ${file.path} ${file.kind} ${file.locale} ${file.change}${marker}`);
      }
      if (result.nextCommand?.argv) {
        console.log(`Next: ${result.nextCommand.argv.join(' ')}`);
      }
      if (result.nextCommand?.writeArgv) {
        console.log(`Next (write): ${result.nextCommand.writeArgv.join(' ')}`);
      }
    } else {
      console.log(`Status: ${result.status}`);
      console.log(`Unit: ${result.unitId}`);
      console.log(`Version: ${result.version}`);
      console.log(`Refresh digest: ${result.refreshDigest}`);
      if (result.refreshed) {
        console.log(`Transaction: ${result.transactionId}`);
        for (const path of result.refreshedPaths ?? []) {
          console.log(`  refreshed ${path}`);
        }
      }
    }

    process.exit(0);
  } catch (err) {
    // docs parameter errors must surface the stable JSON error shape even in
    // text mode (CLI parameter validation precedes any service I/O).
    console.log(JSON.stringify({
      error: err.code ?? 'UNKNOWN_ERROR',
      message: err.message,
      details: err.details ?? {},
      exitCode: err.exitCode ?? 1,
    }));
    process.exit(err.exitCode ?? 1);
  }
}

// Placeholder: remaining commands will be wired in later tasks
console.error(`Command '${command}' is not yet implemented.`);
process.exit(1);
