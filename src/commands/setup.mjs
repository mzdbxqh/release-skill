/**
 * First-use setup discovery and create-once configuration bootstrap.
 *
 * Dry-run is the default. Human-owned files are never regenerated: write
 * mode can only create an absent `.release-skill/project.yaml` after the
 * caller confirms the exact digest of the current facts and answers.
 */

import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promisify } from 'node:util';
import {
  lstat,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import { acquireProjectLock } from '../artifacts/project-lock.mjs';
import {
  CONFIG_EXISTS,
  CONFIG_INVALID,
  ReleaseError,
  SETUP_DIGEST_MISMATCH,
} from '../core/errors.mjs';

const execFile = promisify(execFileCb);
const SKIP_DIRS = new Set([
  '.git', '.release-skill', '.worktrees', '.claude', '.codex', '.cache', '.tmp',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.venv', 'venv',
  'node_modules', 'dist', 'coverage', 'build', 'out', 'tmp', 'temp',
  'runs', 'test', 'tests', 'test-fixtures', 'fixtures', 'examples',
]);
const MAX_JSON_BYTES = 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(await readFile(resolve(__dirname, '..', '..', 'schemas', 'release-project.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateProjectConfig = ajv.compile(schema);

function setupError(code, message, details = {}) {
  return new ReleaseError(code, message, details);
}

function safeRelative(root, path) {
  const rel = relative(root, path).split('\\').join('/');
  return rel || '.';
}

async function readJsonBounded(path, label) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) {
    throw setupError(CONFIG_INVALID, `${label} must be a regular JSON file no larger than 1 MiB`, { path });
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw setupError(CONFIG_INVALID, `${label} is not valid JSON: ${error.message}`, { path });
  }
}

async function walkDiscoveryFiles(root, maxDepth = 5) {
  const found = [];
  async function walk(directory, depth) {
    if (depth > maxDepth) return;
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      const absolute = join(directory, child.name);
      if (child.isDirectory()) {
        if (!SKIP_DIRS.has(child.name)) await walk(absolute, depth + 1);
      } else if (
        child.isFile() &&
        (child.name === 'package.json' ||
          child.name === 'public-release.json' ||
          /^README(?:\.|$)/i.test(child.name) ||
          /^LICENSE(?:\.|$)/i.test(child.name) ||
          /^CHANGELOG(?:\.|$)/i.test(child.name) ||
          absolute.endsWith('/.claude-plugin/plugin.json') ||
          absolute.endsWith('/.codex-plugin/plugin.json') ||
          absolute.endsWith('/.claude-plugin/marketplace.json') ||
          absolute.endsWith('/.codex-plugin/marketplace.json'))
      ) {
        found.push(absolute);
      }
    }
  }
  await walk(root, 0);
  return found;
}

async function digestFile(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw setupError(CONFIG_INVALID, 'discovered file must be regular', { path });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw setupError(CONFIG_INVALID, 'discovered file changed while setup was reading it', { path });
  }
  return { size: after.size, sha256: hash.digest('hex') };
}

function parseGithubRepo(value) {
  if (!value) return null;
  const raw = typeof value === 'string' ? value : value.url;
  if (typeof raw !== 'string') return null;
  const match = raw.match(/github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:#.*)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function safeUnitId(pkg, relDir) {
  const fromName = typeof pkg.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : '';
  const fallback = relDir === '.' ? 'root' : basename(relDir);
  const candidate = (fromName || fallback).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return candidate || 'release-unit';
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
}

function summarizeLegacyReleaseConfig(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw setupError(CONFIG_INVALID, 'public-release.json must contain a JSON object', { path });
  }
  const topLevelRepo = optionalString(value.repoId) ?? parseGithubRepo(value.publicRepoUrl);
  const topLevelSource = optionalString(value.publicSourceDir) ?? stringList(value.publicRoots)[0] ?? '.';
  const declaredRepos = Array.isArray(value.repos) ? value.repos : [];
  const releaseUnits = declaredRepos
    .filter((repo) => repo && typeof repo === 'object' && !Array.isArray(repo))
    .map((repo, index) => ({
      id: optionalString(repo.id) ?? optionalString(repo.name) ?? `legacy-unit-${index + 1}`,
      source: optionalString(repo.source) ?? '.',
      publicRepo: optionalString(repo.publicRepo),
      tagPrefix: optionalString(repo.tagPrefix),
      npmPackage: optionalString(repo.npmPackage),
      npmPackageDeclared: Object.hasOwn(repo, 'npmPackage'),
      docsSource: optionalString(repo.docsSource),
      requiredPathCandidates: stringList(repo.requiredPackagePaths),
      snapshotCommands: Array.isArray(repo.snapshotCommands) ? repo.snapshotCommands : [],
    }));
  if (releaseUnits.length === 0 && (topLevelRepo || value.plugins || value.snapshotCommands)) {
    const plugins = Array.isArray(value.plugins) ? value.plugins : [];
    const pluginName = plugins
      .filter((plugin) => plugin && typeof plugin === 'object' && !Array.isArray(plugin))
      .map((plugin) => optionalString(plugin.name))
      .find(Boolean);
    releaseUnits.push({
      id: pluginName ?? basename(topLevelSource),
      source: topLevelSource,
      publicRepo: topLevelRepo,
      tagPrefix: optionalString(value.tagPrefix),
      npmPackage: plugins
        .filter((plugin) => plugin && typeof plugin === 'object' && !Array.isArray(plugin))
        .map((plugin) => optionalString(plugin.npmPackage))
        .find(Boolean) ?? null,
      npmPackageDeclared: plugins.some((plugin) => (
        plugin && typeof plugin === 'object' && !Array.isArray(plugin) && Object.hasOwn(plugin, 'npmPackage')
      )),
      docsSource: null,
      requiredPathCandidates: stringList(value.requiredPaths),
      snapshotCommands: Array.isArray(value.snapshotCommands) ? value.snapshotCommands : [],
    });
  }
  return {
    path,
    owner: optionalString(value.owner),
    defaultBranch: optionalString(value.defaultBranch),
    parentRepo: optionalString(value.parentRepo),
    releaseUnits,
    sharedFileCandidates: Array.isArray(value.sharedFiles)
      ? value.sharedFiles
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .map((item) => ({ source: optionalString(item.source), target: optionalString(item.target) }))
        .filter((item) => item.source && item.target)
      : [],
    docFileCandidates: stringList(value.docFiles),
    forbiddenPathCandidates: [
      ...stringList(value.forbiddenPublicPaths),
      ...stringList(value.forbiddenPaths),
    ].sort(),
    forbiddenContentPatternCandidates: stringList(value.forbiddenContentPatterns).sort(),
  };
}

function normalizeLegacyCommand(value) {
  if (Array.isArray(value) && typeof value[0] === 'string') {
    if (Array.isArray(value[1]) && value[1].every((item) => typeof item === 'string')) {
      return [value[0], ...value[1]];
    }
    if (value.every((item) => typeof item === 'string')) return [...value];
  }
  if (typeof value === 'string' && !/[|&;<>`$'"\\]/.test(value)) {
    const tokens = value.trim().split(/\s+/).filter(Boolean);
    return tokens.length > 0 ? tokens : null;
  }
  return null;
}

function classifyScript(name, command, unitId, distributionTypes) {
  const normalized = `${name} ${command}`.toLowerCase();
  const highCost = /(llm|real[-_: ]?smoke|end[-_: ]?to[-_: ]?end|\be2e\b|integration)/.test(normalized);
  const mayWrite = /(build|generate|update|fix|format|codegen)/.test(normalized);
  const networkLikely = /(llm|network|online|publish|release|deploy)/.test(normalized);
  const isSmoke = /smoke/.test(normalized);
  const distribution = distributionTypes.length === 1 ? distributionTypes[0] : null;
  return {
    id: `${unitId}-script-${name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`,
    script: name,
    command: ['npm', 'run', name],
    recommendedPhase: isSmoke ? 'consumer-verify' : 'snapshot-verify',
    scope: {
      unit: unitId,
      ...(isSmoke && distribution ? { distribution } : {}),
    },
    ...(
      isSmoke && !distribution && distributionTypes.length > 1
        ? { distributionCandidates: [...distributionTypes] }
        : {}
    ),
    cost: highCost ? 'high' : /test|smoke/.test(normalized) ? 'medium' : 'low',
    sideEffects: {
      mayWriteFiles: mayWrite,
      networkLikely,
      unsandboxed: true,
    },
    reason: isSmoke
      ? '脚本名称表明它可能验证安装后的实际使用；必须人工确认后才能注册。'
      : '项目已声明质量脚本，可在冻结快照副本上复用；不会自动注册。',
  };
}

async function discoverGit(root) {
  const run = async (args) => {
    try {
      const { stdout } = await execFile('git', args, { cwd: root, shell: false, encoding: 'utf8', timeout: 5000 });
      return stdout.trim();
    } catch {
      return '';
    }
  };
  const remoteLines = (await run(['remote', '-v'])).split('\n').filter(Boolean);
  const remotes = [];
  const seen = new Set();
  for (const line of remoteLines) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const key = `${match[1]}\0${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    remotes.push({ name: match[1], url: match[2], repo: parseGithubRepo(match[2]) });
  }
  remotes.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return {
    repository: Boolean(await run(['rev-parse', '--git-dir'])),
    branch: await run(['branch', '--show-current']) || null,
    head: await run(['rev-parse', 'HEAD']) || null,
    tags: (await run(['tag', '--list'])).split('\n').filter(Boolean).sort(),
    remotes,
  };
}

async function discoverFacts(root) {
  const files = await walkDiscoveryFiles(root);
  const packageFiles = files.filter((path) => (
    basename(path) === 'package.json' &&
    !/[\\/]adapters[\\/](?:claude|codex)[\\/]package\.json$/.test(path)
  ));
  const pluginFiles = files.filter((path) => path.endsWith('/plugin.json'));
  const marketplaceFiles = files.filter((path) => path.endsWith('/marketplace.json'));
  const legacyReleaseFiles = files.filter((path) => basename(path) === 'public-release.json');
  const fileDigests = [];
  for (const path of files) {
    fileDigests.push({ path: safeRelative(root, path), ...await digestFile(path) });
  }
  fileDigests.sort((a, b) => a.path.localeCompare(b.path));
  const packages = [];
  for (const path of packageFiles) {
    const pkg = await readJsonBounded(path, 'discovered package.json');
    const relPath = safeRelative(root, path);
    const relDir = safeRelative(root, dirname(path));
    packages.push({
      path: relPath,
      directory: relDir,
      name: typeof pkg.name === 'string' ? pkg.name : null,
      version: typeof pkg.version === 'string' ? pkg.version : null,
      private: pkg.private === true,
      repository: parseGithubRepo(pkg.repository),
      publishRegistry: typeof pkg.publishConfig?.registry === 'string' ? pkg.publishConfig.registry : null,
      files: Array.isArray(pkg.files) ? pkg.files.filter((item) => typeof item === 'string').sort() : [],
      scripts: Object.fromEntries(Object.entries(pkg.scripts ?? {})
        .filter(([, value]) => typeof value === 'string')
        .sort(([a], [b]) => a.localeCompare(b))),
    });
  }
  packages.sort((a, b) => a.path.localeCompare(b.path));

  const manifests = [];
  for (const path of [...pluginFiles, ...marketplaceFiles].sort()) {
    const value = await readJsonBounded(path, 'discovered plugin manifest');
    manifests.push({
      path: safeRelative(root, path),
      host: path.includes('/.claude-plugin/') ? 'claude' : 'codex',
      kind: path.endsWith('/marketplace.json') ? 'marketplace' : 'plugin',
      name: typeof value.name === 'string' ? value.name : null,
      version: typeof value.version === 'string' ? value.version : null,
    });
  }

  const legacyReleaseConfigs = [];
  for (const path of legacyReleaseFiles.sort()) {
    const value = await readJsonBounded(path, 'discovered public-release.json');
    legacyReleaseConfigs.push(summarizeLegacyReleaseConfig(value, safeRelative(root, path)));
  }

  return { git: await discoverGit(root), packages, manifests, legacyReleaseConfigs, fileDigests };
}

function buildCandidates(facts) {
  const gitRepos = facts.git.remotes.map((remote) => remote.repo).filter(Boolean);
  const uniqueGitRepos = [...new Set(gitRepos)];
  const units = [];
  const gates = [];
  const ids = new Set();
  const knownFiles = new Set(facts.fileDigests.map((file) => file.path));
  const manifestRoots = facts.manifests.map((manifest) => {
    const match = manifest.path.match(/^(.*?)(?:\/)?(?:\.claude-plugin|\.codex-plugin)\/(?:plugin|marketplace)\.json$/);
    return { ...manifest, root: match?.[1] || '.' };
  });
  const manifestOwners = new Map();
  const legacyUnits = facts.legacyReleaseConfigs.flatMap((config) => config.releaseUnits);
  const legacyDefaultBranches = [...new Set(facts.legacyReleaseConfigs
    .map((config) => config.defaultBranch)
    .filter(Boolean))];
  for (const manifest of manifestRoots) {
    const owners = facts.packages
      .filter((pkg) => pkg.directory === '.' || manifest.root === pkg.directory || manifest.root.startsWith(`${pkg.directory}/`))
      .sort((a, b) => b.directory.length - a.directory.length);
    if (owners[0]) manifestOwners.set(manifest.path, owners[0].path);
  }

  for (const pkg of facts.packages) {
    const sourceMatchedLegacyUnits = legacyUnits.filter((unit) => unit.source === pkg.directory);
    const preferredLegacyId = sourceMatchedLegacyUnits.map((unit) => unit.id).find(Boolean);
    let id = preferredLegacyId ?? safeUnitId(pkg, pkg.directory);
    let suffix = 2;
    while (ids.has(id)) id = `${safeUnitId(pkg, pkg.directory)}-${suffix++}`;
    ids.add(id);
    const matchingLegacyUnits = legacyUnits.filter((unit) => (
      unit.id === id || unit.source === pkg.directory || unit.source === dirname(pkg.path)
    ));
    const pluginHosts = facts.manifests
      .filter((manifest) => manifestOwners.get(manifest.path) === pkg.path)
      .filter((manifest) => manifest.kind === 'plugin')
      .map((manifest) => manifest.host);
    const distributions = [];
    const legacyChannelsAreAuthoritative = matchingLegacyUnits.length > 0;
    const npmExplicitlyDeclared = matchingLegacyUnits.some((unit) => (
      unit.npmPackageDeclared && unit.npmPackage !== null
    ));
    const npmExplicitlyForbidden = matchingLegacyUnits.some((unit) => (
      unit.npmPackageDeclared && unit.npmPackage === null
    ));
    if (
      !pkg.private &&
      pkg.name &&
      !npmExplicitlyForbidden &&
      (!legacyChannelsAreAuthoritative || npmExplicitlyDeclared)
    ) distributions.push('npm');
    if (pluginHosts.includes('claude')) distributions.push('claude-plugin');
    if (pluginHosts.includes('codex')) distributions.push('codex-plugin');
    if (pkg.private && matchingLegacyUnits.length === 0 && facts.legacyReleaseConfigs.length > 0) continue;
    if (pkg.private && distributions.length === 0) continue;
    const repositoryCandidates = [...new Set([
      pkg.repository,
      ...matchingLegacyUnits.map((unit) => unit.publicRepo),
      ...uniqueGitRepos,
    ].filter(Boolean))];
    const legacyTagTemplates = matchingLegacyUnits
      .map((unit) => unit.tagPrefix ? `${unit.tagPrefix}{version}` : null)
      .filter(Boolean);
    const branchCandidates = [...new Set([
      ...legacyDefaultBranches,
      facts.git.branch,
    ].filter(Boolean))];
    units.push({
      id,
      source: pkg.directory,
      packagePath: pkg.path,
      version: pkg.version,
      publicRepoCandidates: repositoryCandidates,
      distributionCandidates: distributions,
      tagTemplateCandidates: [...new Set([
        ...legacyTagTemplates,
        ...(facts.git.tags.some((tag) => pkg.version && tag === `v${pkg.version}`) ? ['v{version}'] : []),
        ...(facts.git.tags.some((tag) => pkg.version && tag === `${id}-v${pkg.version}`)
          ? [`${id}-v{version}`]
          : []),
      ])],
      branchCandidates,
      branchStrategyCandidates: repositoryCandidates.length > 0
        ? ['advance-existing-branch', 'create-release-branch', 'initialize-default-branch']
        : [],
      previousPublicBaselineStatus: repositoryCandidates.length === 0
        ? 'CHANNEL_MISSING'
        : facts.git.tags.length > 0
          ? 'BOUND_REQUIRES_ONLINE_OBSERVATION'
          : 'FIRST_RELEASE_OR_BOUND_REQUIRES_HUMAN_DECISION',
      publicFileCandidates: [
        pkg.path,
        pkg.directory === '.' ? 'README.md' : `${pkg.directory}/README.md`,
        pkg.directory === '.' ? 'README.zh-CN.md' : `${pkg.directory}/README.zh-CN.md`,
        pkg.directory === '.' ? 'LICENSE' : `${pkg.directory}/LICENSE`,
        ...facts.manifests
          .filter((manifest) => manifestOwners.get(manifest.path) === pkg.path)
          .map((manifest) => manifest.path),
      ].filter((value, index, array) => array.indexOf(value) === index && knownFiles.has(value)).sort(),
      legacyPublicFileHints: matchingLegacyUnits.flatMap((unit) => unit.requiredPathCandidates).sort(),
      packageFilePatternCandidates: [...pkg.files],
    });
    for (const [script, command] of Object.entries(pkg.scripts)) {
      if (/^(docs|build|test|typecheck|lint|check|validate|verify|smoke)(?:$|[:_-])/.test(script)) {
        gates.push(classifyScript(script, command, id, distributions));
      }
    }
    for (const legacy of matchingLegacyUnits) {
      legacy.snapshotCommands.forEach((rawCommand, index) => {
        const command = normalizeLegacyCommand(rawCommand);
        gates.push({
          id: `${id}-legacy-snapshot-${index + 1}`,
          source: 'public-release.json snapshotCommands',
          command,
          recommendedPhase: 'snapshot-verify',
          scope: { unit: id },
          cost: 'medium',
          sideEffects: { mayWriteFiles: true, networkLikely: false, unsandboxed: true },
          requiresManualCommandArray: !command,
          reason: '旧发布配置声明了快照校验；迁移为 gate 前必须人工确认命令数组、副作用和耗时。',
        });
      });
    }
  }

  // A skill/plugin repository may intentionally have no package.json. Keep
  // it discoverable as a plugin-only candidate instead of inventing npm.
  const unownedPluginRoots = [...new Set(manifestRoots
    .filter((manifest) => manifest.kind === 'plugin' && !manifestOwners.has(manifest.path))
    .map((manifest) => manifest.root))];
  for (const pluginRoot of unownedPluginRoots.sort()) {
    const rootManifests = manifestRoots.filter((manifest) => manifest.root === pluginRoot && manifest.kind === 'plugin');
    const name = rootManifests.map((manifest) => manifest.name).find(Boolean) || basename(pluginRoot);
    const baseId = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'plugin';
    let id = baseId;
    let suffix = 2;
    while (ids.has(id)) id = `${baseId}-${suffix++}`;
    ids.add(id);
    units.push({
      id,
      source: pluginRoot,
      packagePath: null,
      version: rootManifests.map((manifest) => manifest.version).find(Boolean) ?? null,
      publicRepoCandidates: [...uniqueGitRepos],
      distributionCandidates: [...new Set(rootManifests.map((manifest) => `${manifest.host}-plugin`))].sort(),
      tagTemplateCandidates: [],
      branchCandidates: [...new Set([...legacyDefaultBranches, facts.git.branch].filter(Boolean))],
      branchStrategyCandidates: uniqueGitRepos.length > 0
        ? ['advance-existing-branch', 'create-release-branch', 'initialize-default-branch']
        : [],
      previousPublicBaselineStatus: uniqueGitRepos.length > 0
        ? (facts.git.tags.length > 0
          ? 'BOUND_REQUIRES_ONLINE_OBSERVATION'
          : 'FIRST_RELEASE_OR_BOUND_REQUIRES_HUMAN_DECISION')
        : 'CHANNEL_MISSING',
      publicFileCandidates: [...knownFiles]
        .filter((path) => pluginRoot === '.' || path.startsWith(`${pluginRoot}/`))
        .filter((path) => /(?:README|LICENSE|CHANGELOG|plugin\.json|marketplace\.json)/i.test(path))
        .sort(),
    });
  }
  units.sort((a, b) => a.id.localeCompare(b.id));
  gates.sort((a, b) => a.id.localeCompare(b.id));
  return { units, gates };
}

function buildDecisionsRequired(candidates, localOnly) {
  const decisions = [];
  if (localOnly) {
    decisions.push({
      id: 'remote-channel',
      description: '未发现 GitHub/npm 远端渠道；决定建立真实渠道，或保持 local-only 并暂停生产发布配置。',
    });
  }
  for (const unit of candidates.units) {
    decisions.push({
      id: `unit:${unit.id}:public-repo`,
      description: unit.publicRepoCandidates.length === 1
        ? `确认公开仓候选 ${unit.publicRepoCandidates[0]}，不得因唯一候选而跳过人工确认。`
        : `从 ${JSON.stringify(unit.publicRepoCandidates)} 中选择公开仓；空列表表示必须先建立渠道。`,
    });
    decisions.push({
      id: `unit:${unit.id}:tag-and-branch`,
      description: `确认 tag 模板、目标分支和 branchStrategy；候选 tag=${JSON.stringify(unit.tagTemplateCandidates)}，branch=${JSON.stringify(unit.branchCandidates)}。`,
    });
    decisions.push({
      id: `unit:${unit.id}:previous-public-baseline`,
      description: `当前状态 ${unit.previousPublicBaselineStatus}；已有公开版本必须在线绑定精确 repo/ref/commit，只有确认不存在前序版本才使用 mode=none。`,
    });
    decisions.push({
      id: `unit:${unit.id}:distributions-and-files`,
      description: `逐项确认渠道 ${JSON.stringify(unit.distributionCandidates)}、公开文件边界和 requiredPublicFiles；候选不是授权。`,
    });
  }
  decisions.push({
    id: 'verification-gates',
    description: '逐项选择要注册的 gate；发现脚本不等于授权，未选择时必须显式使用 selectedGateIds: []。',
  });
  return decisions;
}

function validateAnswers(answers, gateCandidates) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw setupError(CONFIG_INVALID, 'setup answers must be a JSON object');
  }
  if (!answers.projectConfig || typeof answers.projectConfig !== 'object') {
    throw setupError(CONFIG_INVALID, 'setup answers must contain projectConfig');
  }
  if (!Array.isArray(answers.selectedGateIds)) {
    throw setupError(CONFIG_INVALID, 'setup answers must contain selectedGateIds array (use [] to select none)');
  }
  const selected = new Set(answers.selectedGateIds);
  if (selected.size !== answers.selectedGateIds.length) {
    throw setupError(CONFIG_INVALID, 'selectedGateIds must be unique');
  }
  const candidateIds = new Set(gateCandidates.map((gate) => gate.id));
  for (const id of selected) {
    if (!candidateIds.has(id)) throw setupError(CONFIG_INVALID, `selectedGateIds contains unknown candidate "${id}"`);
  }
  const configuredIds = (answers.projectConfig.verificationGates ?? []).map((gate) => gate.id).sort();
  if (JSON.stringify([...selected].sort()) !== JSON.stringify(configuredIds)) {
    throw setupError(
      CONFIG_INVALID,
      'selectedGateIds must exactly match projectConfig.verificationGates[].id',
      { selectedGateIds: [...selected].sort(), configuredGateIds: configuredIds },
    );
  }
  if (!validateProjectConfig(answers.projectConfig)) {
    const errors = validateProjectConfig.errors ?? [];
    throw setupError(
      CONFIG_INVALID,
      `projectConfig in setup answers is invalid: ${errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')}`,
      { validationErrors: errors },
    );
  }
}

function directoryIdentity(entry, label) {
  if (
    !entry || entry.type !== 'directory' ||
    !Number.isInteger(entry.dev) || !Number.isInteger(entry.ino)
  ) {
    throw setupError(CONFIG_INVALID, `${label} must be an identity-bound real directory`);
  }
  return { dev: entry.dev, ino: entry.ino };
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openBoundConfigDirectory(root, safeFs) {
  const rootHandle = await safeFs.openRoot(root);
  let releaseHandle;
  try {
    const rootIdentity = directoryIdentity(await rootHandle.readEntry('.'), 'project root');
    let releaseEntry = await rootHandle.readEntry('.release-skill');
    if (releaseEntry === null) {
      await rootHandle.mkdir('.release-skill', 0o700);
      releaseEntry = await rootHandle.readEntry('.release-skill');
    }
    const linkedIdentity = directoryIdentity(releaseEntry, '.release-skill');
    releaseHandle = await rootHandle.openDir('.release-skill');
    const openedIdentity = directoryIdentity(await releaseHandle.readEntry('.'), '.release-skill handle');
    if (!sameDirectoryIdentity(linkedIdentity, openedIdentity)) {
      throw setupError(CONFIG_INVALID, '.release-skill identity changed while setup opened it');
    }
    return { rootHandle, releaseHandle, rootIdentity, releaseIdentity: openedIdentity };
  } catch (error) {
    await releaseHandle?.close().catch(() => {});
    await rootHandle.close().catch(() => {});
    throw error;
  }
}

async function assertConfigDirectoryStillBound(root, safeFs, expected) {
  const current = await openBoundConfigDirectory(root, safeFs);
  try {
    if (
      !sameDirectoryIdentity(current.rootIdentity, expected.rootIdentity) ||
      !sameDirectoryIdentity(current.releaseIdentity, expected.releaseIdentity)
    ) {
      throw setupError(
        CONFIG_INVALID,
        'project root or .release-skill identity changed immediately before config creation',
      );
    }
  } finally {
    await current.releaseHandle.close().catch(() => {});
    await current.rootHandle.close().catch(() => {});
  }
}

async function createConfigOnce(root, config, { beforeRename } = {}) {
  const { loadSafeFs } = await import('../artifacts/safe-fs.mjs');
  const safeFs = await loadSafeFs();
  const releaseDir = join(root, '.release-skill');
  const target = join(releaseDir, 'project.yaml');
  const bound = await openBoundConfigDirectory(root, safeFs);
  let tempToken;
  const bytes = Buffer.from(YAML.stringify(config, { lineWidth: 0 }), 'utf8');
  try {
    const existing = await bound.releaseHandle.readEntry('project.yaml');
    if (existing !== null) {
      throw setupError(CONFIG_EXISTS, 'configuration was created concurrently; setup did not overwrite it', { configPath: target });
    }
    tempToken = await bound.releaseHandle.createTemp('project.yaml', 0o600, bytes);
    const commitAuthority = beforeRename ? await beforeRename() : null;
    await assertConfigDirectoryStillBound(root, safeFs, bound);
    try {
      await bound.releaseHandle.rename(tempToken, 'project.yaml');
      tempToken = null;
    } catch (error) {
      if (await bound.releaseHandle.readEntry('project.yaml') !== null) {
        throw setupError(CONFIG_EXISTS, 'configuration was created concurrently; setup did not overwrite it', { configPath: target });
      }
      throw error;
    }
    await bound.releaseHandle.fsync();
    await bound.rootHandle.fsync();
    try {
      await assertConfigDirectoryStillBound(root, safeFs, bound);
    } catch (error) {
      const created = await bound.releaseHandle.readFile('project.yaml').catch(() => null);
      if (created?.bytes?.equals(bytes)) {
        await bound.releaseHandle.unlink('project.yaml').catch(() => {});
        await bound.releaseHandle.fsync().catch(() => {});
      }
      throw error;
    }
    const canonical = await bound.releaseHandle.readFile('project.yaml');
    if (!canonical?.bytes?.equals(bytes)) {
      throw setupError(CONFIG_INVALID, 'created configuration bytes do not match the confirmed setup answers');
    }
    return {
      path: target,
      configSha256: sha256Hex(bytes),
      commitAuthority,
    };
  } finally {
    if (tempToken) await bound.releaseHandle.abortTemp(tempToken).catch(() => {});
    await bound.releaseHandle.close().catch(() => {});
    await bound.rootHandle.close().catch(() => {});
  }
}

/** Run deterministic first-use discovery or create the confirmed config. */
export async function setupProject({ root, answersPath, write = false, confirmSetup, faultInjector } = {}) {
  if (!root || typeof root !== 'string' || !isAbsolute(root)) {
    throw setupError(CONFIG_INVALID, 'setup root must be an absolute path');
  }
  const rootReal = await realpath(root).catch((error) => {
    throw setupError(CONFIG_INVALID, `cannot resolve setup root: ${error.message}`);
  });
  const configPath = join(rootReal, '.release-skill', 'project.yaml');
  let configExists = false;
  try {
    const stat = await lstat(configPath);
    configExists = true;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw setupError(CONFIG_INVALID, 'existing project.yaml must be a regular file');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (configExists) {
    if (write) throw setupError(CONFIG_EXISTS, 'configuration already exists; setup never overwrites it', { configPath });
    const [facts, configBytes] = await Promise.all([
      discoverFacts(rootReal),
      readFile(configPath, 'utf8'),
    ]);
    const candidates = buildCandidates(facts);
    let configuredUnitIds = [];
    let configuredGateIds = [];
    let parseError = null;
    let validationErrors = [];
    try {
      const existing = YAML.parse(configBytes);
      configuredUnitIds = (existing?.releaseUnits ?? []).map((unit) => unit?.id).filter(Boolean).sort();
      configuredGateIds = (existing?.verificationGates ?? []).map((gate) => gate?.id).filter(Boolean).sort();
      if (!validateProjectConfig(existing)) {
        validationErrors = (validateProjectConfig.errors ?? []).map((error) => ({
          instancePath: error.instancePath,
          schemaPath: error.schemaPath,
          keyword: error.keyword,
          params: error.params,
          message: error.message,
        }));
      }
    } catch (error) {
      parseError = error.message;
    }
    const discoveredUnitIds = candidates.units.map((unit) => unit.id).sort();
    const unconfiguredGateCandidateIds = candidates.gates
      .map((gate) => gate.id)
      .filter((id) => !configuredGateIds.includes(id))
      .sort();
    return {
      setupVersion: 1,
      status: 'ALREADY_CONFIGURED',
      configPath,
      existingConfigSha256: sha256Hex(configBytes),
      facts,
      releaseUnitCandidates: candidates.units,
      gateCandidates: candidates.gates,
      audit: {
        configuredUnitIds,
        discoveredUnitIds,
        configuredGateIds,
        unconfiguredGateCandidateIds,
        ...(parseError ? { parseError } : {}),
        ...(validationErrors.length > 0 ? { validationErrors } : {}),
        patchSuggestions: [
          ...(parseError ? ['已有配置无法解析；先人工修复，再运行 release-assess。'] : []),
          ...(validationErrors.length > 0
            ? ['已有配置不符合 release-project schema；按 validationErrors 人工增量修复，不重新生成。']
            : []),
          ...(canonicalJson(configuredUnitIds) !== canonicalJson(discoveredUnitIds)
            ? ['发现的发布单元与已有配置不同；人工比较后仅做增量编辑，不重新生成。']
            : []),
          ...(unconfiguredGateCandidateIds.length > 0
            ? ['存在未配置的验证候选；逐项审阅副作用后决定是否人工注册。']
            : []),
        ],
      },
      next: '运行 release-skill assess 审计已有配置；需要调整时依据建议人工增量编辑。',
    };
  }

  const facts = await discoverFacts(rootReal);
  const candidates = buildCandidates(facts);
  let answers = null;
  if (answersPath) {
    const resolvedAnswers = isAbsolute(answersPath) ? answersPath : resolve(rootReal, answersPath);
    answers = await readJsonBounded(resolvedAnswers, 'setup answers');
    validateAnswers(answers, candidates.gates);
  }
  const selectedGateIds = answers?.selectedGateIds ?? [];
  const digestAuthority = {
    setupVersion: 1,
    facts,
    releaseUnitCandidates: candidates.units,
    gateCandidates: candidates.gates,
    selectedGateIds,
    projectConfig: answers?.projectConfig ?? null,
  };
  const setupDigest = sha256Hex(canonicalJson(digestAuthority));
  const hasDiscoveredRemoteChannel = facts.git.remotes.some((remote) => remote.repo) ||
    facts.packages.some((pkg) => pkg.publishRegistry);
  const status = answers
    ? 'READY_TO_WRITE'
    : hasDiscoveredRemoteChannel
      ? 'NEEDS_INPUT'
      : 'LOCAL_ONLY_DETECTED';
  const localOnly = status === 'LOCAL_ONLY_DETECTED';
  const report = {
    ...digestAuthority,
    status,
    setupDigest,
    productionReadiness: status === 'LOCAL_ONLY_DETECTED'
      ? 'LOCAL_ONLY'
      : answers
        ? 'CONFIG_DRAFT_READY'
        : 'HUMAN_DECISIONS_REQUIRED',
    decisionsRequired: answers ? [] : buildDecisionsRequired(candidates, localOnly),
    writeContract: {
      default: 'dry-run',
      requires: ['--write', `--confirm-setup ${setupDigest}`, '--answers <json>'],
      target: '.release-skill/project.yaml',
      overwrite: false,
    },
  };

  if (!write) return report;
  if (!answers) throw setupError(CONFIG_INVALID, 'setup --write requires --answers <json>');
  if (confirmSetup !== setupDigest) {
    throw setupError(
      SETUP_DIGEST_MISMATCH,
      'setup confirmation does not match the current facts and answers; rerun dry-run and review again',
      { expected: setupDigest, received: confirmSetup ?? null },
    );
  }
  const lock = await acquireProjectLock({ root: rootReal, command: 'setup', mode: 'exclusive' });
  let committedConfig;
  try {
    committedConfig = await lock.capture(async () => {
      if (faultInjector) await faultInjector('before-config-commit');
      const lockedFacts = await discoverFacts(rootReal);
      const lockedCandidates = buildCandidates(lockedFacts);
      const resolvedAnswers = isAbsolute(answersPath) ? answersPath : resolve(rootReal, answersPath);
      const lockedAnswers = await readJsonBounded(resolvedAnswers, 'setup answers');
      validateAnswers(lockedAnswers, lockedCandidates.gates);
      const lockedAuthority = {
        setupVersion: 1,
        facts: lockedFacts,
        releaseUnitCandidates: lockedCandidates.units,
        gateCandidates: lockedCandidates.gates,
        selectedGateIds: lockedAnswers.selectedGateIds,
        projectConfig: lockedAnswers.projectConfig,
      };
      const lockedDigest = sha256Hex(canonicalJson(lockedAuthority));
      if (lockedDigest !== confirmSetup) {
        throw setupError(
          SETUP_DIGEST_MISMATCH,
          'project facts or setup answers changed immediately before config creation; rerun dry-run and review the new digest',
          { expected: lockedDigest, received: confirmSetup },
        );
      }
      return createConfigOnce(rootReal, lockedAnswers.projectConfig, {
        beforeRename: async () => {
          if (faultInjector) await faultInjector('before-config-link');
          const finalFacts = await discoverFacts(rootReal);
          const finalCandidates = buildCandidates(finalFacts);
          const finalAnswers = await readJsonBounded(resolvedAnswers, 'setup answers');
          validateAnswers(finalAnswers, finalCandidates.gates);
          const finalAuthority = {
            setupVersion: 1,
            facts: finalFacts,
            releaseUnitCandidates: finalCandidates.units,
            gateCandidates: finalCandidates.gates,
            selectedGateIds: finalAnswers.selectedGateIds,
            projectConfig: finalAnswers.projectConfig,
          };
          const finalDigest = sha256Hex(canonicalJson(finalAuthority));
          if (finalDigest !== confirmSetup) {
            throw setupError(
              SETUP_DIGEST_MISMATCH,
              'project facts or setup answers changed in the final create-once window; rerun dry-run and review the new digest',
              { expected: finalDigest, received: confirmSetup },
            );
          }
          return {
            setupDigest: finalDigest,
            factsDigest: sha256Hex(canonicalJson(finalFacts)),
            answersDigest: sha256Hex(canonicalJson(finalAnswers)),
          };
        },
      });
    });
  } finally {
    await lock.release();
  }
  return {
    ...report,
    status: 'CONFIG_CREATED',
    configPath: committedConfig.path,
    configSha256: committedConfig.configSha256,
    committedSetupDigest: committedConfig.commitAuthority.setupDigest,
    committedFactsDigest: committedConfig.commitAuthority.factsDigest,
    committedAnswersDigest: committedConfig.commitAuthority.answersDigest,
    next: '运行 release-skill assess；再根据 gate 副作用决定 prepare/verify 的显式授权。',
  };
}
