/**
 * Plugin marketplace adapter for release-skill.
 *
 * Validates generated Claude/Codex plugin manifests and installable content.
 * Uses `execFile` to call `node` for manifest validation. Never uses `exec`,
 * `execSync`, or `shell: true`.
 *
 * Marketplace install actions only require
 * `context.isolatedConsumerWritesAuthorized === true`; they write to
 * isolated consumer directories, not to remote services.
 *
 * @module adapters/plugin-marketplace
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, mkdir, writeFile, rename, readdir, rm, realpath, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';

import {
  ActionType,
  ActionStatus,
  createResult,
  assertWritesAuthorized,
  assertIsolatedConsumerWritesAuthorized,
  matchObservation,
} from './contract.mjs';

import { createHash } from 'node:crypto';
import { computeFrozenSnapshot, resolveFrozenPath } from '../snapshot/frozen.mjs';
import { computePlanDigest } from '../core/plan.mjs';
import { canonicalJson } from '../core/digest.mjs';

const execFile = promisify(execFileCb);

const NAME = 'plugin-marketplace';

function transportPayload(entries) {
  return entries.map(({ path, type, mode, size, contentDigest }) => ({
    path,
    type,
    // The local authority removes write bits when sealing. Git checkout and
    // plugin installation restore owner-write permission, while preserving
    // executable intent. Ignore only write bits; retain every other mode bit.
    mode: mode & ~0o222,
    size,
    contentDigest,
  }));
}

// Consumer-owned transport metadata written into the plugin install root
// that is not part of the published payload. Codex checks out the
// repository (root `.git` metadata); Claude marks in-use plugin checkouts
// with an empty root `.in_use` marker. Exclusions apply to root entries
// only; all payload paths keep the fail-closed file checks.
function consumerTransportExclusions(consumer) {
  if (consumer === 'claude') return ['.in_use'];
  if (consumer === 'codex' || consumer === 'kimi') return ['.git'];
  return [];
}

/**
 * Extract the marketplace plugin entry's declared source as a validated,
 * normalized snapshot-relative subpath ("." for root layouts).
 *
 * The rejection set is preserved verbatim from the preflight safety checks:
 * non-empty string, no absolute paths, no ".." traversal (substring check,
 * deliberately stricter than per-segment), no backslashes, no remote URLs.
 * Normalization runs AFTER validation and collapses "./", ".", and trailing
 * slashes. Throws with the preflight's exact error messages.
 */
function extractDeclaredPluginSource(consumer, entry) {
  const rawSource = consumer === 'claude'
    ? entry.source
    : entry.source?.source === 'local' ? entry.source?.path : null;
  if (typeof rawSource !== 'string' || rawSource.length === 0) {
    throw new Error(`marketplace plugin entry source must be a non-empty relative path${consumer === 'codex' ? ' (object with source:"local")' : ''}, got ${JSON.stringify(entry.source)}`);
  }
  if (
    rawSource.startsWith('/') ||
    rawSource.includes('..') ||
    rawSource.includes('\\') ||
    /^https?:\/\//i.test(rawSource)
  ) {
    throw new Error(`marketplace plugin entry source "${rawSource}" is not a safe relative path`);
  }
  const segments = rawSource.split('/').filter((segment) => segment !== '' && segment !== '.');
  // Redundant post-normalization invariant: ".." was already rejected by the
  // substring check above; fail closed if it ever survives normalization.
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`marketplace plugin entry source "${rawSource}" is not a safe relative path`);
  }
  return segments.length === 0 ? '.' : segments.join('/');
}

/**
 * Resolve the payload subpath the consumer CLI installs for this action,
 * read from the marketplace manifest inside the digest-verified frozen
 * snapshot. Returns "." when the whole snapshot is the installed payload
 * (root layouts, and kimi which has no marketplace manifest).
 *
 * Throws (fail closed) if the manifest is absent from the verified entries,
 * unreadable, names a different marketplace, or does not declare exactly
 * one plugins[] entry for action.plugin. The manifest itself lives inside
 * the digest-sealed snapshot, so the declared subpath is authority-bound:
 * tampering with it fails the snapshot digest revalidation first.
 */
async function resolveInstalledPayloadSubpath(snapshotDir, sourceEntries, action, consumer) {
  if (consumer === 'kimi') return '.';
  const marketplaceRelative = consumer === 'claude'
    ? '.claude-plugin/marketplace.json'
    : '.agents/plugins/marketplace.json';
  // Anchor the manifest read to the digest-verified entry walk: the target
  // must be one of the regular files that already passed the fail-closed
  // read checks (O_NOFOLLOW, single link, before/after stat stability).
  const anchored = sourceEntries.some((entry) => entry.type === 'file' && entry.path === marketplaceRelative);
  if (!anchored) {
    throw new Error(`frozen snapshot is missing the marketplace manifest ${marketplaceRelative}`);
  }
  const result = await validateManifestFile(resolve(snapshotDir, marketplaceRelative), ['name', 'plugins']);
  if (!result.valid) {
    throw new Error(`frozen snapshot ${marketplaceRelative} invalid: ${result.error}`);
  }
  if (result.manifest.name !== action.marketplace) {
    throw new Error(`marketplace manifest name "${result.manifest.name}" does not match action marketplace "${action.marketplace}"`);
  }
  const plugins = result.manifest.plugins;
  if (!Array.isArray(plugins)) {
    throw new Error(`${marketplaceRelative} must have a plugins[] array`);
  }
  const matches = plugins.filter((entry) => entry.name === action.plugin);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one plugins[] entry with name "${action.plugin}", found ${matches.length}`);
  }
  return extractDeclaredPluginSource(consumer, matches[0]);
}

async function verifyInstalledMarketplacePayload(action, context, installPath, consumer) {
  const sourcePath = await resolveFrozenPath(
    context.root,
    action.snapshotPath,
    'frozen marketplace snapshot',
  );
  const sourceSnapshot = await computeFrozenSnapshot(sourcePath);
  if (sourceSnapshot.digest !== action.manifestDigest) {
    throw new Error('frozen marketplace snapshot digest no longer matches the plan');
  }
  // Consumer marketplaces install only the plugin entry's declared source
  // subtree (e.g. "./adapters/claude"), not the whole unit snapshot. The
  // sealed whole-snapshot digest above remains the authority; bind the
  // installed payload to that snapshot's declared subtree. Root layouts
  // and kimi keep the whole-tree comparison ("." subpath, no filtering).
  const payloadSubpath = await resolveInstalledPayloadSubpath(
    sourcePath,
    sourceSnapshot.entries,
    action,
    consumer,
  );
  const prefix = payloadSubpath === '.' ? null : `${payloadSubpath}/`;
  const authorityEntries = prefix === null
    ? sourceSnapshot.entries
    : sourceSnapshot.entries
        // The trailing slash keeps sibling directories (e.g.
        // "adapters/claude-x") out of the comparison set. Prefix removal on
        // a path-sorted array is order-preserving, so no re-sort is needed.
        .filter((entry) => entry.path.startsWith(prefix))
        .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
  if (authorityEntries.length === 0) {
    throw new Error('frozen snapshot contains no payload under the declared marketplace source');
  }
  const installedSnapshot = await computeFrozenSnapshot(installPath, {
    excludeRootEntries: consumerTransportExclusions(consumer),
  });
  if (
    JSON.stringify(transportPayload(authorityEntries))
    !== JSON.stringify(transportPayload(installedSnapshot.entries))
  ) {
    throw new Error('installed marketplace payload differs in path, bytes, size, or non-write mode bits');
  }
  // This is not an expected-value backfill: the sealed authority digest was
  // revalidated above and the installed payload was independently compared.
  return action.manifestDigest;
}

async function writeEvidenceAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(tempPath, filePath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Kimi Code protocol-gap modeling (BLOCKER-1 / MAJOR-1 / MAJOR-4 / MINOR-1).
//
// Kimi Code has NO scriptable plugin install/list CLI: plugin management is
// interactive-only (`/plugins install <path-or-url>` in the TUI). There is no
// `kimi plugins ...` subcommand and no `--json` output protocol. Therefore the
// kimi-marketplace-install action is modeled as a protocol capability gap:
//
//   - execute NEVER execs a kimi CLI. It emits an actionable, version-pinned
//     manual-install requirement bound to the frozen plan digest + identity.
//   - observe consumes a structured human attestation (written after the
//     operator runs the interactive install) plus read-only verification of
//     the installed managed copy. Missing/expired/mismatched/escaping proof
//     fails closed, so a kimi unit can never reach VERIFIED without it.
// ---------------------------------------------------------------------------

/** Structured manual-install requirement written by kimi execute. */
const KIMI_REQUIREMENT_FILE = 'release-skill-kimi-manual-install.json';
/** Structured human attestation consumed by kimi observe. */
const KIMI_ATTESTATION_FILE = 'release-skill-kimi-attestation.json';
/** Kimi Code managed install layout: $KIMI_CODE_HOME/plugins/managed/<id>/. */
const KIMI_MANAGED_SUBPATH = join('plugins', 'managed');
/** Maximum attestation validity window (mirrors the 24h approval expiry). */
const KIMI_MAX_ATTESTATION_VALIDITY_MS = 24 * 60 * 60 * 1000;

/** 64-char lowercase hex plan/payload digest pattern. */
const HEX_DIGEST_RE = /^[a-f0-9]{64}$/;

/**
 * Normalize a plan back to its frozen form for digest comparison.
 *
 * Only lifecycle status fields are reset: the top-level `status` returns to
 * "PREPARED" and every `externalActions[].status` returns to "PENDING". Every
 * other field is preserved verbatim. publish/reconcile/verify mutate exactly
 * these status fields in memory as the saga progresses, so normalizing them
 * recovers the frozen digest while leaving all security-relevant fields
 * (baseline, units, action parameters/expected, production config, …) intact.
 *
 * @param {object} plan
 * @returns {object} the lifecycle-normalized plan
 */
function normalizePlanForDigest(plan) {
  const normalized = { ...plan, status: 'PREPARED' };
  if (Array.isArray(plan.externalActions)) {
    normalized.externalActions = plan.externalActions.map((action) => (
      action && typeof action === 'object' && !Array.isArray(action)
        ? { ...action, status: 'PENDING' }
        : action
    ));
  }
  return normalized;
}

/**
 * Resolve and verify the genuine frozen plan digest from the adapter context.
 *
 * The kimi manual-install requirement and attestation bind to the REAL frozen
 * plan digest (`context.plan.digest`) — never to `action.manifestDigest`, which
 * is only the snapshot payload digest.
 *
 * Integrity model: the carried `context.plan.digest` is recomputed from the
 * lifecycle-normalized plan and must match EXACTLY. Status transitions
 * (top-level status, per-action checkpoint status) are normalized away, but any
 * other field tamper changes the recomputed digest and fails closed. This
 * proves the attestation is bound to the genuine frozen plan, not to a spoofed
 * or mutated stand-in.
 *
 * @param {object} context - adapter context (must carry the frozen `plan`).
 * @returns {string} the verified frozen plan digest.
 * @throws {Error} when the plan is absent or the digest does not match.
 */
function resolveBoundPlanDigest(context) {
  const plan = context?.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('context.plan is required to bind the kimi plan digest');
  }
  const carried = plan.digest;
  if (typeof carried !== 'string' || !HEX_DIGEST_RE.test(carried)) {
    throw new Error('context.plan.digest must be a 64-char lowercase hex frozen plan digest');
  }
  const normalized = normalizePlanForDigest(plan);
  if (computePlanDigest(normalized) !== carried) {
    throw new Error('context.plan.digest does not match the normalized frozen plan (a non-lifecycle field was tampered)');
  }
  return carried;
}

/**
 * Authoritative, cross-run attestation directory for a kimi install.
 *
 * Lives at a stable root-fixed location keyed by the verified frozen plan
 * digest and plugin id:
 *   <root>/.release-skill/kimi-attestations/<planDigest>/<plugin>/
 *
 * This survives the publish -> manual install -> reconcile -> verify chain,
 * where each command otherwise uses a fresh runDir (an attestation written to a
 * publish runDir would be invisible to reconcile/verify). Both the requirement
 * and the human attestation live here. The segments are pre-validated (planDigest
 * is 64-hex, plugin matches SAFE_ID_RE) and the resolved path is contained
 * within the authority base, so no path escape is possible.
 *
 * @param {object} context - adapter context (needs `root`).
 * @param {string} planDigest - verified frozen plan digest (64-hex).
 * @param {string} plugin - plugin id (SAFE_ID_RE).
 * @returns {string} absolute authority directory.
 */
function kimiAuthorityDir(context, planDigest, plugin) {
  if (!context?.root) {
    throw new Error('context.root is required for the kimi attestation authority');
  }
  if (!HEX_DIGEST_RE.test(planDigest)) {
    throw new Error('kimi attestation authority requires a 64-hex plan digest');
  }
  if (!SAFE_ID_RE.test(plugin)) {
    throw new Error(`kimi attestation authority requires a safe plugin id: "${plugin}"`);
  }
  const base = resolve(context.root, '.release-skill', 'kimi-attestations');
  const dir = resolve(base, planDigest, plugin);
  const rel = relative(base, dir);
  const sep = process.platform === 'win32' ? '\\' : '/';
  if (
    rel === '' || rel === '..' || isAbsolute(rel) || rel.startsWith(`..${sep}`)
    || rel.split(sep).some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error('kimi attestation authority path escapes its base');
  }
  return dir;
}

/**
 * Build the official, version-pinned install URL for a frozen Git ref.
 *
 * Prefers the GitHub release-tag URL (`/releases/tag/<ref>`), which pins the
 * exact published ref; `/tree/<ref>` is the documented equivalent. A bare
 * repository URL is NOT acceptable because it installs the latest release (or
 * default branch), which need not equal the frozen version.
 *
 * @param {string} repo - owner/repo
 * @param {string} ref - frozen Git ref (tag)
 * @returns {string}
 */
function buildKimiInstallUrl(repo, ref) {
  return `https://github.com/${repo}/releases/tag/${ref}`;
}

/**
 * Human-facing, actionable manual-install closed-loop instructions for Kimi Code.
 *
 * @param {{installUrl:string, plugin:string, version:string, ref:string, isolatedHome:string, attestationDir:string}} p
 * @returns {string[]}
 */
function buildKimiManualInstructions({ installUrl, plugin, version, ref, isolatedHome, attestationDir }) {
  return [
    `Kimi Code has no scriptable plugin-install CLI; installation is a manual, interactive step.`,
    `1) publish fails closed at this kimi checkpoint and leaves the run PARTIAL (the automated Git branch/tag, npm, and GitHub Release writes still complete first).`,
    `2) Launch Kimi Code with the ISOLATED home from this requirement so the managed copy lands inside it: set HOME="${isolatedHome}" and KIMI_CODE_HOME="${isolatedHome}". The plugin installs to "${isolatedHome}/plugins/managed/${plugin}/".`,
    `3) In that isolated Kimi Code session run: /plugins install ${installUrl}  (pinned to frozen ref "${ref}", version ${version}; never install the bare repository URL). Confirm the trust prompt for plugin "${plugin}", then run /plugins reload (or /new).`,
    `4) Write the attestation JSON to: ${attestationDir}/${KIMI_ATTESTATION_FILE}. planDigest MUST be the frozen plan digest; payloadDigest MUST be the frozen snapshot payload digest; installPath MUST be the isolated managed directory above. attestedAt must not be in the future and expiresAt must be within 24 hours of attestedAt.`,
    `   Required fields: consumer="kimi", plugin, version, entrySkill, repo, ref, installPath, planDigest, payloadDigest, attestedBy, attestedAt, expiresAt.`,
    `5) Re-run release-skill reconcile (promotes PARTIAL -> PUBLISHED) and then verify (-> VERIFIED). Both read the attestation from this same plan-digest-keyed authority directory, so a fresh run directory does not lose the proof.`,
    `An install into the ordinary ~/.kimi-code is NOT acceptable proof: the attested installPath must resolve inside this requirement's isolated KIMI_CODE_HOME managed root, otherwise verification fails closed.`,
  ];
}

/**
 * Read the authoritative Kimi plugin manifest from a verified plugin root.
 *
 * `kimi.plugin.json` at the root takes priority over `.kimi-plugin/plugin.json`
 * when both exist (official precedence). Returns the parsed manifest and the
 * root-relative manifest path. Throws when no valid manifest is present.
 *
 * @param {string} pluginRootReal - realpath of the verified plugin root.
 * @returns {Promise<{manifest:object, manifestRelative:string}>}
 */
async function readKimiManifest(pluginRootReal) {
  const candidates = [
    'kimi.plugin.json',
    join('.kimi-plugin', 'plugin.json'),
  ];
  for (const manifestRelative of candidates) {
    const manifestPath = resolve(pluginRootReal, manifestRelative);
    let content;
    try {
      content = await readFile(manifestPath, 'utf8');
    } catch {
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(content);
    } catch {
      throw new Error(`kimi plugin manifest ${manifestRelative} is not valid JSON`);
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(`kimi plugin manifest ${manifestRelative} is not an object`);
    }
    return { manifest, manifestRelative };
  }
  throw new Error('no kimi plugin manifest found (expected kimi.plugin.json or .kimi-plugin/plugin.json)');
}

/**
 * Validate that a manifest `skills` value is a safe plugin-root-relative path.
 *
 * Accepts "./" or "./some/dir/" forms. Rejects absolute paths, ".." traversal,
 * backslashes, and URLs. Returns the normalized root-relative path (no leading
 * "./"). Throws on unsafe values.
 *
 * @param {string} skillsRaw
 * @returns {string} normalized relative path ('' for the plugin root itself)
 */
function normalizeKimiSkillsRel(skillsRaw) {
  if (typeof skillsRaw !== 'string' || skillsRaw.length === 0) {
    throw new Error('kimi manifest skills must be a non-empty relative path when present');
  }
  if (
    skillsRaw.startsWith('/') ||
    skillsRaw.includes('..') ||
    skillsRaw.includes('\\') ||
    /^https?:\/\//i.test(skillsRaw)
  ) {
    throw new Error(`kimi manifest skills "${skillsRaw}" is not a safe relative path`);
  }
  let rel = skillsRaw.replace(/^\.\//, '');
  rel = rel.replace(/\/+$/, '');
  if (rel.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`kimi manifest skills "${skillsRaw}" is not a safe relative path`);
  }
  return rel;
}

/**
 * Resolve the entry SKILL.md for a Kimi plugin from its authoritative manifest.
 *
 * - When the manifest declares `skills`, the entry skill resolves under that
 *   skills root (validated + realpath-contained within the plugin root).
 * - When `skills` is omitted, Kimi's official single-skill semantics apply: the
 *   plugin root's own SKILL.md is the single skill.
 *
 * The returned path is realpath-contained within pluginRootReal and is a
 * regular, non-symlink file. Throws on missing/escaping/invalid layouts so the
 * caller fails closed.
 *
 * @param {string} pluginRootReal - realpath of the verified plugin root.
 * @param {object} manifest - parsed kimi plugin manifest.
 * @param {string} entrySkill - expected entry skill id.
 * @returns {Promise<string>} realpath of the entry SKILL.md
 */
async function resolveKimiEntrySkillFile(pluginRootReal, manifest, entrySkill) {
  if (!entrySkill || typeof entrySkill !== 'string' || !SAFE_ID_RE.test(entrySkill)) {
    throw new Error(`unsafe entrySkill: "${entrySkill}"`);
  }
  let entryAbs;
  if (manifest.skills === undefined || manifest.skills === null) {
    // Official single-skill semantics: root SKILL.md is the sole skill.
    entryAbs = resolve(pluginRootReal, 'SKILL.md');
  } else {
    const skillsRel = normalizeKimiSkillsRel(manifest.skills);
    const skillsRootAbs = skillsRel === '' ? pluginRootReal : resolve(pluginRootReal, skillsRel);
    const skillsRootReal = await realpath(skillsRootAbs).catch(() => null);
    if (!skillsRootReal) {
      throw new Error(`kimi manifest skills root does not exist: ${manifest.skills}`);
    }
    const skillsContainment = relative(pluginRootReal, skillsRootReal);
    const sepK = process.platform === 'win32' ? '\\' : '/';
    if (
      skillsContainment !== '' &&
      (isAbsolute(skillsContainment) || skillsContainment === '..' || skillsContainment.startsWith(`..${sepK}`))
    ) {
      throw new Error(`kimi manifest skills "${manifest.skills}" escapes the plugin root after symlink resolution`);
    }
    entryAbs = resolve(skillsRootReal, entrySkill, 'SKILL.md');
  }

  // lstat the LEXICAL entry BEFORE realpath. A symlinked SKILL.md must be
  // rejected outright; lstat-ing the realpath target instead would observe the
  // resolved regular file and silently miss the symlink.
  let entryLexicalStat;
  try {
    entryLexicalStat = await lstat(entryAbs);
  } catch {
    throw new Error(`kimi entry skill not found: ${relative(pluginRootReal, entryAbs) || 'SKILL.md'}`);
  }
  if (entryLexicalStat.isSymbolicLink()) {
    throw new Error('kimi entry skill must not be a symlink');
  }
  if (!entryLexicalStat.isFile()) {
    throw new Error('kimi entry skill is not a regular file');
  }

  const entryReal = await realpath(entryAbs).catch(() => null);
  if (!entryReal) {
    throw new Error(`kimi entry skill not found: ${relative(pluginRootReal, entryAbs) || 'SKILL.md'}`);
  }
  const entryContainment = relative(pluginRootReal, entryReal);
  const sepE = process.platform === 'win32' ? '\\' : '/';
  if (
    entryContainment !== '' &&
    (isAbsolute(entryContainment) || entryContainment === '..' || entryContainment.startsWith(`..${sepE}`))
  ) {
    throw new Error('kimi entry skill escapes the plugin root after symlink resolution');
  }
  return entryReal;
}

/**
 * Validate a structured kimi manual-install attestation against the frozen
 * action and the verified frozen plan digest.
 *
 * Bindings (fail closed on any mismatch):
 * - `planDigest` binds to the REAL frozen plan digest (`boundPlanDigest`, from
 *   `context.plan.digest`) — NOT to `action.manifestDigest`.
 * - `payloadDigest` binds separately to `action.manifestDigest` (the sealed
 *   snapshot payload digest).
 * - plugin identity, version, entry skill, repo, and frozen ref must match.
 * - Time bounds: `attestedAt` must not be in the future, the validity window
 *   (`expiresAt - attestedAt`) must not exceed 24h, and the attestation must
 *   not be expired relative to `isoNow`.
 *
 * @param {object} attestation - parsed attestation JSON.
 * @param {object} action - the expanded kimi action (top-level fields).
 * @param {string} isoNow - current ISO timestamp.
 * @param {string} boundPlanDigest - verified frozen plan digest.
 * @returns {{valid:boolean, error:string|null}}
 */
function validateKimiAttestation(attestation, action, isoNow, boundPlanDigest) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    return { valid: false, error: 'kimi attestation is not an object' };
  }
  const requiredStrings = ['plugin', 'version', 'entrySkill', 'repo', 'ref', 'installPath', 'payloadDigest', 'planDigest', 'attestedBy', 'attestedAt', 'expiresAt'];
  for (const field of requiredStrings) {
    if (typeof attestation[field] !== 'string' || attestation[field].length === 0) {
      return { valid: false, error: `kimi attestation missing required field "${field}"` };
    }
  }
  if (attestation.consumer !== 'kimi') {
    return { valid: false, error: `kimi attestation consumer "${attestation.consumer}" must be "kimi"` };
  }
  if (!HEX_DIGEST_RE.test(attestation.planDigest)) {
    return { valid: false, error: 'kimi attestation planDigest must be a 64-char lowercase hex digest' };
  }
  if (attestation.planDigest !== boundPlanDigest) {
    return { valid: false, error: 'kimi attestation planDigest does not match the frozen plan digest' };
  }
  if (attestation.plugin !== action.plugin) {
    return { valid: false, error: `kimi attestation plugin "${attestation.plugin}" does not match action plugin "${action.plugin}"` };
  }
  if (attestation.version !== action.version) {
    return { valid: false, error: `kimi attestation version "${attestation.version}" does not match action version "${action.version}"` };
  }
  if (attestation.entrySkill !== action.entrySkill) {
    return { valid: false, error: `kimi attestation entrySkill "${attestation.entrySkill}" does not match action entrySkill "${action.entrySkill}"` };
  }
  if (attestation.repo !== action.repo) {
    return { valid: false, error: `kimi attestation repo "${attestation.repo}" does not match action repo "${action.repo}"` };
  }
  const expectedRef = action.ref ?? `v${action.version}`;
  if (attestation.ref !== expectedRef) {
    return { valid: false, error: `kimi attestation ref "${attestation.ref}" does not match frozen ref "${expectedRef}"` };
  }
  if (attestation.payloadDigest !== action.manifestDigest) {
    return { valid: false, error: 'kimi attestation payloadDigest does not match the frozen payload digest' };
  }
  const attestedMs = Date.parse(attestation.attestedAt);
  const expiresMs = Date.parse(attestation.expiresAt);
  const nowMs = Date.parse(isoNow);
  if (!Number.isFinite(attestedMs) || !Number.isFinite(expiresMs) || !Number.isFinite(nowMs)) {
    return { valid: false, error: 'kimi attestation attestedAt/expiresAt must be valid ISO timestamps' };
  }
  if (attestedMs > nowMs) {
    return { valid: false, error: 'kimi attestation attestedAt is in the future' };
  }
  if (expiresMs <= attestedMs) {
    return { valid: false, error: 'kimi attestation expiresAt must be after attestedAt' };
  }
  if (expiresMs - attestedMs > KIMI_MAX_ATTESTATION_VALIDITY_MS) {
    return { valid: false, error: 'kimi attestation validity must not exceed 24 hours' };
  }
  if (nowMs > expiresMs) {
    return { valid: false, error: 'kimi attestation has expired' };
  }
  return { valid: true, error: null };
}

/**
 * Kimi Code protocol capability gap (BLOCKER-1): there is NO scriptable
 * `kimi plugins install/list` CLI and no `--json` protocol. execute NEVER execs
 * a kimi command. Instead it emits an actionable, version-pinned manual-install
 * requirement bound to the real frozen plan digest + identity, and leaves
 * success to observe, which consumes only a trusted human attestation plus
 * read-only verification. Without that proof the checkpoint fails closed and can
 * never reach VERIFIED.
 *
 * Isolation model (B/C): the kimi home is a STABLE, plan-digest-keyed directory
 * under the attestation authority (`<authorityDir>/kimi-home`), not the per-run
 * runDir consumer dir. The operator launches Kimi Code with that KIMI_CODE_HOME
 * so the managed copy lands at `<kimiHome>/plugins/managed/<plugin>/`, a
 * location that is identical across publish/reconcile/verify run dirs. execute
 * creates ONLY the managed parent (`plugins/managed`), never `managed/<plugin>`
 * (the operator's interactive install creates that). The requirement write is
 * idempotent: an identical existing requirement is left untouched, a divergent
 * one fails closed.
 *
 * @param {object} action - expanded kimi action (validated params already).
 * @param {object} context - adapter context (root, runDir, plan).
 * @returns {Promise<import('./contract.mjs').AdapterResult>}
 */
async function executeKimiManualRequirement(action, context) {
  const actionType = ActionType.KIMI_MARKETPLACE_INSTALL;

  // (A) Bind to the REAL frozen plan digest via strict normalized recompute.
  let planDigest;
  try {
    planDigest = resolveBoundPlanDigest(context);
  } catch (planErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: `cannot bind kimi requirement to the frozen plan: ${planErr.message}`,
    });
  }

  // Validate the frozen timeout. Kimi execs no CLI, but the frozen-timeout
  // fail-closed invariant still holds for every marketplace action.
  try {
    resolveTimeoutMs(action);
  } catch (timeoutErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: timeoutErr.message,
    });
  }

  const ref = action.ref ?? `v${action.version}`;
  const installUrl = buildKimiInstallUrl(action.repo, ref);

  // (B) Stable, plan-digest-keyed authority dir — the ONLY kimi home, shared
  // across publish/reconcile/verify run dirs.
  let attestationDir;
  try {
    attestationDir = kimiAuthorityDir(context, planDigest, action.plugin);
  } catch (dirErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: dirErr.message,
    });
  }
  const kimiHome = resolve(attestationDir, 'kimi-home');
  const managedParent = resolve(kimiHome, KIMI_MANAGED_SUBPATH); // plugins/managed
  // plugins/managed/<plugin> — created by the operator's interactive install.
  const managedInstallRoot = resolve(managedParent, action.plugin);

  const instructions = buildKimiManualInstructions({
    installUrl,
    plugin: action.plugin,
    version: action.version,
    ref,
    isolatedHome: kimiHome,
    attestationDir,
  });

  const requirement = {
    kind: 'kimi-manual-install-requirement',
    consumer: 'kimi',
    plugin: action.plugin,
    version: action.version,
    entrySkill: action.entrySkill,
    repo: action.repo,
    ref,
    installUrl,
    // (A) planDigest binds to the real frozen plan digest;
    // expectedPayloadDigest binds separately to the snapshot payload digest.
    planDigest,
    expectedPayloadDigest: action.manifestDigest,
    isolatedHome: kimiHome,
    kimiCodeHome: kimiHome,
    managedInstallRoot,
    attestationDir,
    attestationFile: KIMI_ATTESTATION_FILE,
    attestationTemplate: {
      consumer: 'kimi',
      plugin: action.plugin,
      version: action.version,
      entrySkill: action.entrySkill,
      repo: action.repo,
      ref,
      installPath: managedInstallRoot,
      planDigest,
      payloadDigest: action.manifestDigest,
      attestedBy: '<person responsible for the manual install>',
      attestedAt: '<ISO 8601 now; must not be in the future>',
      expiresAt: '<ISO 8601; within 24h of attestedAt>',
    },
    instructions,
  };

  // Create ONLY the managed parent (plugins/managed); never pre-create
  // managed/<plugin> — the operator's interactive install creates that.
  try {
    await mkdir(managedParent, { recursive: true, mode: 0o700 });
  } catch (mkdirErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: `cannot create kimi managed parent directory: ${mkdirErr.message}`,
    });
  }

  // Idempotent requirement write: an identical existing requirement is left
  // untouched; a divergent existing requirement fails closed (never silently
  // overwritten). `createdAt` is volatile and excluded from the comparison.
  const requirementPath = resolve(attestationDir, KIMI_REQUIREMENT_FILE);
  let existing = null;
  let requirementMissing = false;
  try {
    const existingRaw = await readFile(requirementPath, 'utf8');
    try {
      existing = JSON.parse(existingRaw);
    } catch (parseErr) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `existing kimi manual-install requirement is invalid JSON; refusing to overwrite: ${parseErr.message}`,
      });
    }
  } catch (readErr) {
    if (readErr?.code === 'ENOENT') {
      requirementMissing = true;
    } else {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `existing kimi manual-install requirement cannot be read; refusing to overwrite: ${readErr.message}`,
      });
    }
  }
  if (!requirementMissing) {
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: 'existing kimi manual-install requirement is not an object; refusing to overwrite',
      });
    }
    const { createdAt: _existingCreatedAt, ...existingBody } = existing;
    if (canonicalJson(existingBody) !== canonicalJson(requirement)) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: 'existing kimi manual-install requirement conflicts with the current frozen action; refusing to overwrite',
      });
    }
  } else {
    await writeEvidenceAtomic(requirementPath, { ...requirement, createdAt: new Date().toISOString() });
  }

  return createResult({
    actionType,
    status: ActionStatus.EXECUTED,
    observation: {
      installed: false,
      manualInstallRequired: true,
      consumer: 'kimi',
      plugin: action.plugin,
      version: action.version,
      entrySkill: action.entrySkill,
      repo: action.repo,
      ref,
      installUrl,
      planDigest,
      attestationDir,
      kimiCodeHome: kimiHome,
      managedInstallRoot,
      instructions,
    },
  });
}

const SUPPORTED_TYPES = [
  ActionType.PLUGIN_MANIFEST_VALIDATE,
  ActionType.PLUGIN_INSTALL_CHECK,
  ActionType.CLAUDE_MARKETPLACE_INSTALL,
  ActionType.CODEX_MARKETPLACE_INSTALL,
  ActionType.KIMI_MARKETPLACE_INSTALL,
];

/** Safe identifier pattern: lowercase alphanumeric, hyphens, dots, underscores. */
const SAFE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Safe repo pattern: owner/repo with alphanumeric, hyphens, dots, underscores. */
const SAFE_REPO_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Strict semver pattern: supports prerelease and build metadata.
 * Matches: 1.0.0, 1.0.0-beta.1, 1.0.0-rc.1+build.123
 */
const STRICT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Validate a Git ref for injection safety.
 * Rejects: backslash, //, leading/trailing /, trailing ., .lock, @{, standalone @,
 * .., control characters, option-like values.
 *
 * @param {string} ref
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateSafeRef(ref) {
  if (!ref || typeof ref !== 'string') {
    return { valid: false, error: 'ref is required' };
  }
  if (/[\x00-\x1f]/.test(ref)) {
    return { valid: false, error: 'ref contains control characters' };
  }
  if (ref.startsWith('-')) {
    return { valid: false, error: `ref must not start with '-': "${ref}"` };
  }
  if (ref.includes('\\')) {
    return { valid: false, error: 'ref contains backslash' };
  }
  if (ref.includes('//')) {
    return { valid: false, error: 'ref contains //' };
  }
  if (ref.startsWith('/') || ref.endsWith('/')) {
    return { valid: false, error: 'ref must not start or end with /' };
  }
  if (ref.endsWith('.')) {
    return { valid: false, error: 'ref must not end with .' };
  }
  if (ref.endsWith('.lock')) {
    return { valid: false, error: 'ref must not end with .lock' };
  }
  if (ref.includes('@{')) {
    return { valid: false, error: 'ref contains @{' };
  }
  if (ref === '@') {
    return { valid: false, error: 'ref must not be standalone @' };
  }
  if (ref.includes('..')) {
    return { valid: false, error: 'ref contains ..' };
  }
  if (/[;|&`$(){}]/.test(ref)) {
    return { valid: false, error: 'ref contains shell metacharacters' };
  }
  // Must match safe alphanumeric pattern
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref)) {
    return { valid: false, error: `unsafe ref: "${ref}"` };
  }
  return { valid: true, error: null };
}

/**
 * Validate marketplace install parameters for injection-safe values.
 *
 * @param {object} params - The action parameters.
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateMarketplaceParams(params) {
  if (!params || typeof params !== 'object') {
    return { valid: false, error: 'parameters must be an object' };
  }
  const { consumer, plugin, marketplace, repo, version, entrySkill } = params;
  if (!['claude', 'codex', 'kimi'].includes(consumer)) {
    return { valid: false, error: `invalid consumer: "${consumer}"` };
  }
  if (!plugin || !SAFE_ID_RE.test(plugin)) {
    return { valid: false, error: `unsafe plugin identifier: "${plugin}"` };
  }
  // marketplace is a required identity field for Claude/Codex, which have
  // scriptable marketplace add/install interfaces. Kimi Code has an interactive
  // marketplace but NO non-interactive install API, so `marketplace` carries no
  // executable meaning for kimi and is optional (validated only if present); it
  // must not become a required identity condition for kimi execution/observe.
  if (consumer === 'kimi') {
    if (marketplace !== undefined && marketplace !== null && !SAFE_ID_RE.test(marketplace)) {
      return { valid: false, error: `unsafe marketplace identifier: "${marketplace}"` };
    }
  } else if (!marketplace || !SAFE_ID_RE.test(marketplace)) {
    return { valid: false, error: `unsafe marketplace identifier: "${marketplace}"` };
  }
  if (!repo || !SAFE_REPO_RE.test(repo)) {
    return { valid: false, error: `unsafe repo identifier: "${repo}"` };
  }
  if (!version || !STRICT_SEMVER_RE.test(version)) {
    return { valid: false, error: `unsafe version (must be valid semver): "${version}"` };
  }
  if (!entrySkill || !SAFE_ID_RE.test(entrySkill)) {
    return { valid: false, error: `unsafe entrySkill: "${entrySkill}"` };
  }
  return { valid: true, error: null };
}


/**
 * Resolve and validate the frozen timeoutMs from the expanded adapter action.
 *
 * The publish/reconcile/verify call path expands plan actions as
 * `{ actionType, ...action.parameters }`, so `parameters.timeoutMs` in the
 * plan becomes `action.timeoutMs` at the adapter level. This function reads
 * from the top-level action, not from a nested `parameters` sub-object.
 *
 * Rules:
 * - Missing field (undefined): returns 300000 default (legacy compatibility).
 * - Present but null/invalid (null, string, NaN, Infinity, non-integer,
 *   out of range): fail-closed, throws.
 * - Valid integer in [30000, 900000]: returns the value as-is.
 *
 * @param {object} action - The expanded adapter action (top-level).
 * @returns {number} Validated timeout in milliseconds.
 * @throws {Error} If the value is present but invalid.
 */
function resolveTimeoutMs(action) {
  const raw = action?.timeoutMs;
  if (raw === undefined) {
    return 300000;
  }
  if (raw === null || typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new Error(
      `action.timeoutMs must be a finite integer, got: ${JSON.stringify(raw)}`,
    );
  }
  if (raw < 30000 || raw > 900000) {
    throw new Error(
      `action.timeoutMs must be between 30000 and 900000, got: ${raw}`,
    );
  }
  return raw;
}

/**
 * Run a CLI command using execFile (never shell: true).
 */
async function run(cmd, args, options = {}) {
  return execFile(cmd, args, {
    shell: false,
    encoding: 'utf8',
    timeout: 30_000,
    ...options,
  });
}

/**
 * Validate that a manifest file exists and contains required fields.
 *
 * @param {string} manifestPath - Absolute path to the manifest JSON file.
 * @param {string[]} requiredFields - Fields that must be present.
 * @returns {Promise<{ valid: boolean, manifest: Object|null, missing: string[], error: string|null }>}
 */
async function validateManifestFile(manifestPath, requiredFields) {
  try {
    const content = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(content);

    const missing = requiredFields.filter((f) => !(f in manifest));

    return {
      valid: missing.length === 0,
      manifest,
      missing,
      error: missing.length > 0 ? `Missing required fields: ${missing.join(', ')}` : null,
    };
  } catch (err) {
    return {
      valid: false,
      manifest: null,
      missing: requiredFields,
      error: `Failed to read manifest: ${err.message}`,
    };
  }
}

/**
 * Check that required files exist in a directory.
 *
 * @param {string} dir - Absolute path to check.
 * @param {string[]} requiredFiles - File paths relative to dir.
 * @returns {Promise<{ allPresent: boolean, missing: string[] }>}
 */
async function checkRequiredFiles(dir, requiredFiles) {
  const missing = [];
  for (const file of requiredFiles) {
    try {
      await stat(resolve(dir, file));
    } catch {
      missing.push(file);
    }
  }
  return { allPresent: missing.length === 0, missing };
}

/**
 * Create the plugin-marketplace adapter.
 *
 * @param {Object} [deps]
 * @param {typeof run} [deps.exec] - Injectable exec function for testing.
 * @returns {import('./contract.mjs').Adapter}
 */
export function createPluginMarketplaceAdapter(deps = {}) {
  const exec = deps.exec ?? run;

  return Object.freeze({
    name: NAME,
    actionTypes: SUPPORTED_TYPES,

    /**
     * Preflight: read-only checks before execution.
     * Fail-closed: snapshotPath, ref, manifestDigest are required for
     * marketplace install actions.
     */
    async preflight(action, context) {
      const { actionType } = action;

      try {
        if (actionType === ActionType.PLUGIN_MANIFEST_VALIDATE) {
          const manifestPath = action.manifestPath;
          if (!manifestPath) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'manifestPath is required',
            });
          }

          // Read-only check: manifest file exists and is parseable
          const result = await validateManifestFile(manifestPath, [
            'name',
            'version',
            'description',
          ]);

          if (!result.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: result.error,
            });
          }

          return createResult({
            actionType,
            status: ActionStatus.PREFLIGHT_PASSED,
          });
        }

        if (actionType === ActionType.PLUGIN_INSTALL_CHECK) {
          const pluginDir = action.pluginDir;
          if (!pluginDir) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'pluginDir is required',
            });
          }

          // Check directory exists
          try {
            const s = await stat(pluginDir);
            if (!s.isDirectory()) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `pluginDir is not a directory: ${pluginDir}`,
              });
            }
          } catch {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `pluginDir does not exist: ${pluginDir}`,
            });
          }

          return createResult({
            actionType,
            status: ActionStatus.PREFLIGHT_PASSED,
          });
        }

        // Marketplace install preflight: fail-closed validation
        if (
          actionType === ActionType.CLAUDE_MARKETPLACE_INSTALL ||
          actionType === ActionType.CODEX_MARKETPLACE_INSTALL ||
          actionType === ActionType.KIMI_MARKETPLACE_INSTALL
        ) {
          // 1. Validate all parameters for injection safety
          const validation = validateMarketplaceParams(action);
          if (!validation.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: validation.error,
            });
          }

          // 2. ref is required and must be safe
          const ref = action.ref;
          if (!ref) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'ref is required for marketplace install',
            });
          }
          const refValidation = validateSafeRef(ref);
          if (!refValidation.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: refValidation.error,
            });
          }

          // 3. snapshotPath is required
          const snapshotPath = action.snapshotPath;
          if (!snapshotPath) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'snapshotPath is required for marketplace install',
            });
          }

          // 4. manifestDigest is required
          const manifestDigest = action.manifestDigest;
          if (!manifestDigest || typeof manifestDigest !== 'string') {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'manifestDigest is required for marketplace install',
            });
          }
          if (!/^[a-f0-9]{64}$/.test(manifestDigest)) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `manifestDigest must be a 64-char lowercase hex string`,
            });
          }

          // 5. Validate context (root and runDir required)
          if (!context?.root) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'context.root is required for marketplace install',
            });
          }
          if (!context.runDir) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'context.runDir is required for marketplace install',
            });
          }

          // 6. Verify frozen snapshot exists and contains required marketplace files
          const consumer = action.consumer;
          let snapshotDirReal;
          // Authoritative kimi manifest (from the frozen snapshot), used to
          // resolve the entry skill via the manifest-declared skills root.
          let kimiSnapshotManifest = null;
          try {
            snapshotDirReal = await resolveFrozenPath(context.root, snapshotPath, 'frozen snapshot path');
          } catch (frozenErr) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `frozen snapshot validation failed: ${frozenErr.message}`,
            });
          }

          // Kimi has no non-interactive marketplace/install API: the whole repo
          // is installed as one plugin. The authoritative manifest is read from
          // the verified snapshot root with official precedence
          // (kimi.plugin.json over .kimi-plugin/plugin.json).
          if (consumer === 'kimi') {
            let kimiManifestResult;
            try {
              kimiManifestResult = await readKimiManifest(snapshotDirReal);
            } catch (manifestErr) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `frozen snapshot kimi manifest invalid: ${manifestErr.message}`,
              });
            }
            const kimiManifest = kimiManifestResult.manifest;
            if (typeof kimiManifest.name !== 'string' || kimiManifest.name !== action.plugin) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `plugin manifest name "${kimiManifest.name}" does not match action plugin "${action.plugin}"`,
              });
            }
            if (typeof kimiManifest.version !== 'string' || kimiManifest.version !== action.version) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `plugin manifest version "${kimiManifest.version}" does not match action version "${action.version}"`,
              });
            }
            kimiSnapshotManifest = kimiManifest;
          }

          if (consumer !== 'kimi') {
          // Verify marketplace files exist.
          // marketplace.json is at the snapshot root; plugin manifest is
          // resolved relative to the entry's declared source path.
          const marketplaceRelative = consumer === 'claude'
            ? '.claude-plugin/marketplace.json'
            : '.agents/plugins/marketplace.json';

          const marketplacePath = resolve(snapshotDirReal, marketplaceRelative);

          // marketplace.json must exist and have root name (no root version required)
          const marketplaceResult = await validateManifestFile(marketplacePath, ['name']);
          if (!marketplaceResult.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `frozen snapshot ${marketplaceRelative} invalid: ${marketplaceResult.error}`,
            });
          }

          // Root name must equal action.marketplace
          if (marketplaceResult.manifest.name !== action.marketplace) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace.json name "${marketplaceResult.manifest.name}" does not match action marketplace "${action.marketplace}"`,
            });
          }

          // plugins[] must exist with exactly one entry matching action.plugin
          const plugins = marketplaceResult.manifest.plugins;
          if (!Array.isArray(plugins)) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `${marketplaceRelative} must have a plugins[] array`,
            });
          }
          const pluginEntry = plugins.filter((p) => p.name === action.plugin);
          if (pluginEntry.length !== 1) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `expected exactly one plugins[] entry with name "${action.plugin}", found ${pluginEntry.length}`,
            });
          }
          const entry = pluginEntry[0];

          // Entry source must be a safe relative path within the snapshot.
          // Accepts "./" (root-level), "./adapters/claude" (subdirectory),
          // etc. Rejects absolute paths, ".." traversal, remote URLs, and
          // empty strings. Normalized to "." for root layouts; the same
          // helper backs verify-side payload subtree resolution, so both
          // paths can never drift apart.
          let sourcePath;
          try {
            sourcePath = extractDeclaredPluginSource(consumer, entry);
          } catch (sourceErr) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: sourceErr.message,
            });
          }
          // Verify the declared source directory exists and contains the
          // expected plugin manifest inside the frozen snapshot.
          const sourceDirAbs = resolve(snapshotDirReal, sourcePath);
          const sourceDirReal = await realpath(sourceDirAbs).catch(() => null);
          if (!sourceDirReal) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace plugin entry source directory does not exist: ${sourcePath}`,
            });
          }
          // Containment check: source must stay inside the snapshot
          const sourceRelCheck = relative(snapshotDirReal, sourceDirReal);
          if (sourceRelCheck.startsWith('..') || isAbsolute(sourceRelCheck)) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace plugin entry source "${sourcePath}" escapes the frozen snapshot`,
            });
          }

          // Resolve plugin manifest relative to the declared source path.
          // For root layouts (source: "./"), this resolves to
          //   snapshot/.claude-plugin/plugin.json
          // For subdirectory layouts (source: "./adapters/claude"), this resolves to
          //   snapshot/adapters/claude/.claude-plugin/plugin.json
          const manifestRelative = consumer === 'claude'
            ? join(sourcePath, '.claude-plugin', 'plugin.json')
            : join(sourcePath, '.codex-plugin', 'plugin.json');
          const manifestPath = resolve(snapshotDirReal, manifestRelative);

          const manifestResult = await validateManifestFile(manifestPath, ['name', 'version']);
          if (!manifestResult.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `frozen snapshot ${manifestRelative} invalid: ${manifestResult.error}`,
            });
          }

          // Claude carries the version in the marketplace entry. Codex keeps
          // the authoritative version in .codex-plugin/plugin.json.
          if (consumer === 'claude' && entry.version !== action.version) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace plugin entry version "${entry.version}" does not match action version "${action.version}"`,
            });
          }

          // Verify plugin manifest name/version match marketplace entry
          const pluginManifestResult = await validateManifestFile(manifestPath, ['name', 'version']);
          if (!pluginManifestResult.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `frozen snapshot ${manifestRelative} invalid: ${pluginManifestResult.error}`,
            });
          }
          if (pluginManifestResult.manifest.name !== entry.name) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `plugin manifest name "${pluginManifestResult.manifest.name}" does not match marketplace entry name "${entry.name}"`,
            });
          }
          if (pluginManifestResult.manifest.version !== action.version) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `plugin manifest version "${pluginManifestResult.manifest.version}" does not match action version "${action.version}"`,
            });
          }
          }

          // Verify the entry skill exists in the snapshot.
          // Claude/Codex manifests always declare ./skills/, so the fixed
          // skills/<entrySkill>/SKILL.md layout is authoritative for them.
          // Kimi resolves the entry skill via the manifest-declared skills root
          // (MAJOR-4): the root is validated + realpath-contained, and omitted
          // `skills` means the official single-skill root SKILL.md.
          if (consumer === 'kimi') {
            try {
              await resolveKimiEntrySkillFile(snapshotDirReal, kimiSnapshotManifest, action.entrySkill);
            } catch (entryErr) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `entry skill not resolvable in snapshot: ${entryErr.message}`,
              });
            }
          } else {
            const entrySkillFile = resolve(snapshotDirReal, 'skills', action.entrySkill, 'SKILL.md');
            try {
              await stat(entrySkillFile);
            } catch {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `entry skill not found in snapshot: skills/${action.entrySkill}/SKILL.md`,
              });
            }
          }

          // Verify manifestDigest matches actual snapshot content using frozen algorithm
          try {
            const { digest: actualDigest } = await computeFrozenSnapshot(snapshotDirReal);
            if (actualDigest !== manifestDigest) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `manifestDigest mismatch: expected ${manifestDigest.slice(0, 16)}..., actual ${actualDigest.slice(0, 16)}...`,
              });
            }
          } catch (digestErr) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `failed to compute snapshot digest: ${digestErr.message}`,
            });
          }

          return createResult({
            actionType,
            status: ActionStatus.PREFLIGHT_PASSED,
          });
        }

        return createResult({
          actionType,
          status: ActionStatus.PREFLIGHT_FAILED,
          error: `Unsupported action type: ${actionType}`,
        });
      } catch (err) {
        return createResult({
          actionType,
          status: ActionStatus.PREFLIGHT_FAILED,
          error: err.message,
        });
      }
    },

    /**
     * Execute: perform the validation/write action. For marketplace,
     * "execute" means running structured validation.
     * Some actions require authorization (e.g., updating remote metadata).
     */
    async execute(action, context) {
      const { actionType } = action;

      // Plugin validation is read-only; no authorization needed for validate
      // Only actual remote writes require authorization
      if (actionType === ActionType.PLUGIN_MANIFEST_VALIDATE) {
        try {
          const manifestPath = action.manifestPath;
          const requiredFields = action.requiredFields ?? ['name', 'version', 'description'];

          const result = await validateManifestFile(manifestPath, requiredFields);

          if (!result.valid) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: result.error,
              observation: { valid: false, missing: result.missing },
            });
          }

          // Additional structural validation via node --check if a JS entry is specified
          if (action.entryPoint) {
            try {
              await exec(process.execPath, ['--check', action.entryPoint]);
            } catch (checkErr) {
              return createResult({
                actionType,
                status: ActionStatus.EXECUTE_FAILED,
                error: `Entry point syntax check failed: ${checkErr.message}`,
              });
            }
          }

          return createResult({
            actionType,
            status: ActionStatus.EXECUTED,
            observation: {
              valid: true,
              manifest: result.manifest,
              manifestPath,
            },
          });
        } catch (err) {
          return createResult({
            actionType,
            status: ActionStatus.EXECUTE_FAILED,
            error: err.message,
          });
        }
      }

      if (actionType === ActionType.PLUGIN_INSTALL_CHECK) {
        // Install check may involve writing temp files in some cases
        // For now it's read-only, so no authorization check needed
        try {
          const { pluginDir, requiredFiles } = action;
          const check = await checkRequiredFiles(pluginDir, requiredFiles ?? []);

          if (!check.allPresent) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: `Missing required files: ${check.missing.join(', ')}`,
              observation: { allPresent: false, missing: check.missing },
            });
          }

          // Smoke test: try loading the entry point
          if (action.entryPoint) {
            try {
              await exec(process.execPath, ['--check', resolve(pluginDir, action.entryPoint)]);
            } catch (checkErr) {
              return createResult({
                actionType,
                status: ActionStatus.EXECUTE_FAILED,
                error: `Install smoke test failed: ${checkErr.message}`,
              });
            }
          }

          return createResult({
            actionType,
            status: ActionStatus.EXECUTED,
            observation: {
              allPresent: true,
              pluginDir,
              checkedFiles: requiredFiles ?? [],
            },
          });
        } catch (err) {
          return createResult({
            actionType,
            status: ActionStatus.EXECUTE_FAILED,
            error: err.message,
          });
        }
      }

      // Marketplace install execute
      if (
        actionType === ActionType.CLAUDE_MARKETPLACE_INSTALL ||
        actionType === ActionType.CODEX_MARKETPLACE_INSTALL ||
        actionType === ActionType.KIMI_MARKETPLACE_INSTALL
      ) {
        try {
          assertIsolatedConsumerWritesAuthorized(context, actionType);

          const validation = validateMarketplaceParams(action);
          if (!validation.valid) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: validation.error,
            });
          }

          // Validate context
          if (!context?.root) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: 'context.root is required for marketplace install',
            });
          }
          if (!context.runDir) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: 'context.runDir is required for marketplace install',
            });
          }

          // Kimi has NO scriptable install CLI. It is handled entirely by the
          // manual-requirement helper, which uses a stable plan-digest-keyed
          // home and deliberately SKIPS the per-run isolated consumer dir and
          // its runDir containment check (that model only fits claude/codex,
          // which exec a real CLI into a per-run HOME).
          if (action.consumer === 'kimi') {
            return executeKimiManualRequirement(action, context);
          }

          const consumer = action.consumer;
          const runDir = context.runDir;
          const isolatedHome = resolve(runDir, 'consumers', `${consumer}-${action.plugin}`);

          // Verify consumer directory is inside runDir
          const runDirReal = await realpath(runDir).catch(() => runDir);
          const isolatedHomePreReal = await realpath(isolatedHome).catch(() => isolatedHome);
          const relToRun = relative(runDirReal, isolatedHomePreReal);
          const sepE = process.platform === 'win32' ? '\\' : '/';
          if (relToRun !== '' && (isAbsolute(relToRun) || relToRun === '..' || relToRun.startsWith(`..${sepE}`))) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: `consumer directory escapes runDir: ${isolatedHome}`,
            });
          }

          // Create isolated HOME and required subdirectories
          await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
          if (consumer === 'claude') {
            await mkdir(resolve(isolatedHome, '.claude'), { recursive: true, mode: 0o700 });
          } else {
            await mkdir(resolve(isolatedHome, '.codex'), { recursive: true, mode: 0o700 });
          }

          const cliCmd = consumer === 'claude' ? 'claude' : 'codex';
          const baseEnv = { ...process.env, ...context.env };
          const env = {
            ...baseEnv,
            ...(consumer === 'claude'
              ? { HOME: isolatedHome, CLAUDE_CONFIG_DIR: resolve(isolatedHome, '.claude') }
              : { HOME: isolatedHome, CODEX_HOME: isolatedHome }),
          };
          // Ensure real HOME/CODEX_HOME don't leak back (already overridden
          // above).

          // Resolve frozen timeoutMs from the expanded action (top-level,
          // not action.parameters -- the publish/reconcile/verify call path
          // expands plan action as { actionType, ...action.parameters }).
          // Default to 300000 for old plans that lack the field.
          // Fail closed on invalid values (null, non-integer, non-finite,
          // out of range).
          let frozenTimeoutMs;
          try {
            frozenTimeoutMs = resolveTimeoutMs(action);
          } catch (timeoutErr) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: timeoutErr.message,
            });
          }

          // Step 1: Add marketplace (claude/codex only; kimi returned above)
          const ref = action.ref ?? `v${action.version}`;
          let addOutput = null;
          if (consumer !== 'kimi') {
          const marketplaceArgs = consumer === 'claude'
            ? ['plugin', 'marketplace', 'add', `${action.repo}@${ref}`]
            : ['plugin', 'marketplace', 'add', action.repo, '--ref', ref, '--json'];
          try {
            const addResult = await exec(cliCmd, marketplaceArgs, { env, cwd: context.root, timeout: frozenTimeoutMs });
            if (consumer === 'codex') {
              try {
                addOutput = JSON.parse(addResult.stdout);
                if (!addOutput || typeof addOutput !== 'object') {
                  return createResult({
                    actionType,
                    status: ActionStatus.EXECUTE_FAILED,
                    error: 'marketplace add returned invalid JSON output',
                  });
                }
                if (addOutput.marketplaceName !== action.marketplace) {
                  return createResult({
                    actionType,
                    status: ActionStatus.EXECUTE_FAILED,
                    error: `marketplace add marketplaceName "${addOutput.marketplaceName}" does not match action marketplace "${action.marketplace}"`,
                  });
                }
              } catch {
                return createResult({
                  actionType,
                  status: ActionStatus.EXECUTE_FAILED,
                  error: 'marketplace add returned malformed JSON',
                });
              }
            }
          } catch (addErr) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: `marketplace add failed: ${addErr.message}`,
            });
          }
          }

          // Step 2: Install plugin (claude/codex only; kimi has no install CLI
          // and returned the manual-install requirement above).
          let installOutput;
          const installArgs = consumer === 'claude'
            ? ['plugin', 'install', `${action.plugin}@${action.marketplace}`]
            : ['plugin', 'add', `${action.plugin}@${action.marketplace}`, '--json'];
          try {
            const installResult = await exec(cliCmd, installArgs, { env, cwd: context.root, timeout: frozenTimeoutMs });
            if (consumer === 'codex') {
              try {
                installOutput = JSON.parse(installResult.stdout);
                if (!installOutput || typeof installOutput !== 'object') {
                  return createResult({
                    actionType,
                    status: ActionStatus.EXECUTE_FAILED,
                    error: 'plugin install returned invalid JSON output',
                  });
                }
                const expectedPluginId = `${action.plugin}@${action.marketplace}`;
                const installFields = {
                  pluginId: installOutput.pluginId,
                  name: installOutput.name,
                  marketplaceName: installOutput.marketplaceName,
                  version: installOutput.version,
                  installedPath: installOutput.installedPath,
                };
                const expectedFields = {
                  pluginId: expectedPluginId,
                  name: action.plugin,
                  marketplaceName: action.marketplace,
                  version: action.version,
                  installedPath: undefined, // must exist and be non-empty
                };
                for (const [field, expected] of Object.entries(expectedFields)) {
                  if (field === 'installedPath') {
                    if (!installFields.installedPath) {
                      return createResult({
                        actionType,
                        status: ActionStatus.EXECUTE_FAILED,
                        error: `plugin install JSON missing installedPath`,
                      });
                    }
                    // installedPath must be inside isolated HOME
                    const installPathAbs = resolve(installFields.installedPath);
                    const installPathRel = relative(isolatedHome, installPathAbs);
                    if (isAbsolute(installPathRel) || installPathRel === '..' || installPathRel.startsWith(`..${sepE}`)) {
                      return createResult({
                        actionType,
                        status: ActionStatus.EXECUTE_FAILED,
                        error: `plugin install installedPath escapes isolated HOME: ${installFields.installedPath}`,
                      });
                    }
                  } else if (installFields[field] !== expected) {
                    return createResult({
                      actionType,
                      status: ActionStatus.EXECUTE_FAILED,
                      error: `plugin install JSON ${field} "${installFields[field]}" does not match expected "${expected}"`,
                    });
                  }
                }
              } catch {
                return createResult({
                  actionType,
                  status: ActionStatus.EXECUTE_FAILED,
                  error: 'plugin install returned malformed JSON',
                });
              }
            }
          } catch (installErr) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: `plugin install failed: ${installErr.message}`,
            });
          }

          // Build and write structured evidence for observe cross-validation
          const evidence = {
            isolatedHome,
            consumer,
            plugin: action.plugin,
            marketplace: action.marketplace,
            repo: action.repo,
            ref,
            version: action.version,
            addOutput,
            installOutput,
            executedAt: new Date().toISOString(),
          };

          // Write evidence file to runDir/evidence/ (outside isolatedHome/installPath digest scope)
          const evidenceDir = resolve(runDir, 'evidence', `${consumer}-${action.plugin}`);
          await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
          const evidencePath = resolve(evidenceDir, 'release-skill-install-evidence.json');
          await writeEvidenceAtomic(evidencePath, evidence);

          // Compute manifestDigest from installed content and build
          // expected-compatible observation for executeCheckpoint's
          // matchObservation check.
          const installPath = installOutput?.installedPath;
          let executeManifestDigest = null;
          if (installPath) {
            try {
              executeManifestDigest = await verifyInstalledMarketplacePayload(
                action,
                context,
                installPath,
                consumer,
              );
            } catch {
              // Digest computation failure is caught at verify time
            }
          }

          const executeObservation = {
            ...evidence,
            installed: true,
            entrySkill: action.entrySkill,
            ...(executeManifestDigest ? { manifestDigest: executeManifestDigest } : {}),
          };

          return createResult({
            actionType,
            status: ActionStatus.EXECUTED,
            observation: executeObservation,
          });
        } catch (err) {
          return createResult({
            actionType,
            status: ActionStatus.EXECUTE_FAILED,
            error: err.message,
          });
        }
      }

      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `Unsupported action type: ${actionType}`,
      });
    },

    /**
     * Observe: read the current state of the plugin manifest and content.
     * Never infers success from exit code alone.
     *
     * For Claude: uses id === "plugin@marketplace" match in list array,
     * reads installPath from CLI output, verifies install dir is inside
     * isolated HOME, computes real manifestDigest from installed content.
     *
     * For Codex: uses pluginId === "plugin@marketplace" match in installed array,
     * reads installedPath from add/install output or list, verifies install dir
     * is inside isolated HOME, computes real manifestDigest.
     *
     * For Kimi: uses name === plugin match in installed array, reads
     * installedPath from validated install evidence, verifies install dir
     * is inside isolated HOME, computes real manifestDigest.
     */
    async observe(action, context) {
      const { actionType } = action;

      try {
        if (actionType === ActionType.PLUGIN_MANIFEST_VALIDATE) {
          const manifestPath = action.manifestPath;
          try {
            const content = await readFile(manifestPath, 'utf8');
            const manifest = JSON.parse(content);
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                exists: true,
                name: manifest.name,
                version: manifest.version,
                description: manifest.description,
              },
            });
          } catch {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: { exists: false },
            });
          }
        }

        if (actionType === ActionType.PLUGIN_INSTALL_CHECK) {
          const { pluginDir, requiredFiles } = action;
          const check = await checkRequiredFiles(pluginDir, requiredFiles ?? []);

          return createResult({
            actionType,
            status: ActionStatus.OBSERVED,
            observation: {
              allPresent: check.allPresent,
              missing: check.missing,
              pluginDir,
            },
          });
        }

        // Marketplace install observe
        if (
          actionType === ActionType.CLAUDE_MARKETPLACE_INSTALL ||
          actionType === ActionType.CODEX_MARKETPLACE_INSTALL ||
          actionType === ActionType.KIMI_MARKETPLACE_INSTALL
        ) {
          const consumer = action.consumer;
          const runDir = context.runDir;
          if (!runDir) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: { installed: false, error: 'context.runDir is required' },
            });
          }
          const isolatedHome = resolve(runDir, 'consumers', `${consumer}-${action.plugin}`);
          const cliCmd = consumer === 'claude' ? 'claude' : consumer === 'codex' ? 'codex' : 'kimi';
          const baseEnv = { ...process.env, ...(context.env ?? {}) };
          const env = {
            ...baseEnv,
            ...(consumer === 'claude'
              ? { HOME: isolatedHome, CLAUDE_CONFIG_DIR: resolve(isolatedHome, '.claude') }
              : consumer === 'codex'
                ? { HOME: isolatedHome, CODEX_HOME: isolatedHome }
                : { HOME: isolatedHome, KIMI_CODE_HOME: isolatedHome }),
          };

          // Resolve frozen timeoutMs from the expanded action (top-level).
          // Default to 300000 for old plans. Fail closed on invalid values.
          let frozenTimeoutMs;
          try {
            frozenTimeoutMs = resolveTimeoutMs(action);
          } catch (timeoutErr) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: { installed: false, error: timeoutErr.message },
              error: timeoutErr.message,
            });
          }

          // Kimi Code protocol capability gap (BLOCKER-1): there is NO
          // `kimi plugins list --json` interface. observe never execs a kimi
          // command. Instead it consumes a structured human attestation (written
          // after the interactive install) bound to the frozen plan digest and
          // expected identity, then performs read-only verification of the
          // installed managed copy: payload digest vs the sealed authority,
          // entry skill resolved via the manifest skills root (MAJOR-4), and
          // manifest name/version. Missing/expired/mismatched/escaping proof
          // fails closed so a kimi unit can never reach VERIFIED without it.
          if (consumer === 'kimi') {
            const expectedRef = action.ref ?? `v${action.version}`;

            // Bind to the REAL frozen plan digest (A). Fail closed if the
            // context does not carry an intact frozen plan.
            let boundPlanDigest;
            try {
              boundPlanDigest = resolveBoundPlanDigest(context);
            } catch (planErr) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `cannot bind kimi observation to the frozen plan: ${planErr.message}`,
                },
              });
            }

            // Stable, cross-run attestation authority (B). The requirement and
            // attestation live here, keyed by the verified plan digest + plugin,
            // so they survive publish PARTIAL -> reconcile -> verify (each of
            // which uses a fresh runDir).
            let attestationDir;
            try {
              attestationDir = kimiAuthorityDir(context, boundPlanDigest, action.plugin);
            } catch (dirErr) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: dirErr.message },
              });
            }

            // The execute-emitted requirement must exist and bind to the action
            // and the frozen plan digest.
            let requirement = null;
            try {
              requirement = JSON.parse(await readFile(resolve(attestationDir, KIMI_REQUIREMENT_FILE), 'utf8'));
            } catch {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  manualInstallRequired: true,
                  error: 'kimi manual-install requirement is missing; run execute first',
                },
              });
            }
            if (
              requirement.planDigest !== boundPlanDigest ||
              requirement.plugin !== action.plugin ||
              requirement.version !== action.version ||
              requirement.entrySkill !== action.entrySkill ||
              requirement.repo !== action.repo ||
              requirement.ref !== expectedRef
            ) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: 'kimi manual-install requirement does not match the frozen plan/action',
                },
              });
            }

            // The trusted human attestation is mandatory and is read from the
            // stable authority dir. Without it the interactive install has not
            // been proven: fail closed.
            let attestation = null;
            try {
              attestation = JSON.parse(await readFile(resolve(attestationDir, KIMI_ATTESTATION_FILE), 'utf8'));
            } catch {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  manualInstallRequired: true,
                  installUrl: requirement.installUrl,
                  attestationDir,
                  error: `kimi attestation is missing; write ${resolve(attestationDir, KIMI_ATTESTATION_FILE)} after the interactive install (${requirement.installUrl})`,
                },
              });
            }

            const attestationCheck = validateKimiAttestation(attestation, action, new Date().toISOString(), boundPlanDigest);
            if (!attestationCheck.valid) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: attestationCheck.error },
              });
            }

            // The attested install path must live in the documented managed
            // layout under the STABLE, plan-digest-keyed isolated home (B). The
            // managed root is derived from the authority dir (itself derived from
            // the verified plan digest + plugin), so it is identical across
            // publish/reconcile/verify run dirs. No lexical-containment fallback
            // (C): every path must realpath-resolve and stay contained; a missing
            // home/root, a symlink, or an escape fails closed.
            const kimiCodeHome = resolve(attestationDir, 'kimi-home');
            const kimiCodeHomeReal = await realpath(kimiCodeHome).catch(() => null);
            if (!kimiCodeHomeReal) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `KIMI_CODE_HOME does not exist or cannot be resolved: ${kimiCodeHome}`,
                },
              });
            }
            const managedRootReal = await realpath(resolve(kimiCodeHomeReal, KIMI_MANAGED_SUBPATH, action.plugin)).catch(() => null);
            if (!managedRootReal) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `kimi managed plugin root does not exist: ${resolve(kimiCodeHomeReal, KIMI_MANAGED_SUBPATH, action.plugin)}`,
                },
              });
            }
            // installPath must be a real directory (not a symlink) that resolves
            // inside the managed root.
            const installPath = resolve(attestation.installPath);
            let installPathStat;
            try {
              installPathStat = await lstat(installPath);
            } catch {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: `kimi install path does not exist: ${attestation.installPath}` },
              });
            }
            if (installPathStat.isSymbolicLink()) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: `kimi install path must not be a symlink: ${attestation.installPath}` },
              });
            }
            if (!installPathStat.isDirectory()) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: `kimi install path must be a directory: ${attestation.installPath}` },
              });
            }
            const installPathReal = await realpath(installPath).catch(() => null);
            if (!installPathReal) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: `kimi install path cannot be resolved: ${attestation.installPath}` },
              });
            }
            const sepK = process.platform === 'win32' ? '\\' : '/';
            const relToManaged = relative(managedRootReal, installPathReal);
            if (
              relToManaged !== '' &&
              (isAbsolute(relToManaged) || relToManaged === '..' || relToManaged.startsWith(`..${sepK}`))
            ) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `kimi install path escapes the managed root (${managedRootReal}): ${attestation.installPath}`,
                },
              });
            }

            // Read-only payload binding: the installed managed copy must match
            // the sealed frozen authority exactly (transport-normalized).
            let manifestDigest;
            try {
              manifestDigest = await verifyInstalledMarketplacePayload(action, context, installPathReal, consumer);
            } catch (digestErr) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath: installPathReal,
                  error: `failed to bind installed kimi payload to frozen authority: ${digestErr.message}`,
                },
              });
            }
            if (manifestDigest !== action.manifestDigest) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath: installPathReal,
                  error: 'installed kimi payload digest does not match the frozen plan digest',
                },
              });
            }

            // Entry skill must resolve via the installed manifest's skills root
            // (MAJOR-4), with official manifest precedence.
            let installedManifest;
            let entrySkillFound = false;
            try {
              const readManifest = await readKimiManifest(installPathReal);
              installedManifest = readManifest.manifest;
              await resolveKimiEntrySkillFile(installPathReal, installedManifest, action.entrySkill);
              entrySkillFound = true;
            } catch (entryErr) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath: installPathReal,
                  manifestDigest,
                  entrySkillFound: false,
                  error: `kimi entry skill not resolvable in installed copy: ${entryErr.message}`,
                },
              });
            }

            // Installed manifest identity must match the frozen action.
            if (installedManifest.name !== action.plugin) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath: installPathReal,
                  manifestDigest,
                  entrySkillFound: true,
                  error: `installed kimi manifest name "${installedManifest.name}" does not match action plugin "${action.plugin}"`,
                },
              });
            }
            if (installedManifest.version !== action.version) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath: installPathReal,
                  manifestDigest,
                  entrySkillFound: true,
                  error: `installed kimi manifest version "${installedManifest.version}" does not match action version "${action.version}"`,
                },
              });
            }

            // Build the observation from independently verified fields only.
            // marketplace is intentionally NOT a kimi identity field (MINOR-1).
            const observation = {
              installed: true,
              installPath: installPathReal,
              entrySkillFound: true,
              entrySkill: action.entrySkill,
              manifestDigest,
              consumer,
              plugin: installedManifest.name,
              version: installedManifest.version,
              repo: action.repo,
              ref: expectedRef,
            };
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation,
            });
          }

          // Read execute evidence — mandatory for observe validation
          let evidence = null;
          try {
            const evidenceRaw = await readFile(resolve(runDir, 'evidence', `${consumer}-${action.plugin}`, 'release-skill-install-evidence.json'), 'utf8');
            evidence = JSON.parse(evidenceRaw);
          } catch {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: false,
                error: 'execute evidence file is missing or unreadable',
              },
            });
          }

          if (
            evidence.consumer !== consumer ||
            evidence.plugin !== action.plugin ||
            evidence.marketplace !== action.marketplace ||
            evidence.version !== action.version ||
            evidence.repo !== action.repo ||
            evidence.ref !== action.ref ||
            evidence.isolatedHome !== isolatedHome
          ) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: false,
                error: 'execute evidence identity does not match the frozen action',
              },
            });
          }

          // Run list command to verify installation (claude/codex only; kimi
          // has no list CLI and returned via the attestation path above).
          const listArgs = ['plugin', 'list', '--json'];

          let listOutput;
          try {
            const result = await exec(cliCmd, listArgs, { env, cwd: context.root, timeout: frozenTimeoutMs });
            listOutput = JSON.parse(result.stdout);
          } catch (listErr) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: false,
                error: `list command failed: ${listErr.message}`,
              },
            });
          }

          const pluginId = `${action.plugin}@${action.marketplace}`;
          let found = null;
          let installPath = null;

          if (consumer === 'claude') {
            // Claude: list returns an array; find by id === "plugin@marketplace"
            if (!Array.isArray(listOutput)) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: 'Claude plugin list did not return an array',
                },
              });
            }
            found = listOutput.find((p) => p.id === pluginId);
            if (!found) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `plugin "${pluginId}" not found in Claude plugin list`,
                },
              });
            }
            if (!found.installPath) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `plugin "${pluginId}" found but missing installPath`,
                },
              });
            }
            installPath = found.installPath;
          } else if (consumer === 'codex') {
            // Codex: installPath comes from validated evidence, not from list
            installPath = evidence.installOutput?.installedPath;
            if (!installPath) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: 'evidence install JSON missing installedPath',
                },
              });
            }

            // Cross-validate with list (list does NOT provide installedPath)
            const installed = listOutput?.installed;
            if (!Array.isArray(installed)) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: 'Codex plugin list did not return {installed: [...]}',
                },
              });
            }
            found = installed.find((p) => p.pluginId === pluginId);
            if (!found) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `plugin "${pluginId}" not found in Codex installed list`,
                },
              });
            }
            // Cross-validate: list fields must match evidence/action
            if (found.name !== action.plugin) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: `list name "${found.name}" does not match action plugin "${action.plugin}"` },
              });
            }
            if (found.marketplaceName !== action.marketplace) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: `list marketplaceName "${found.marketplaceName}" does not match action marketplace "${action.marketplace}"` },
              });
            }
            if (found.version !== action.version) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: `list version "${found.version}" does not match action version "${action.version}"` },
              });
            }
          }

          // Verify installPath is inside or at isolated HOME (path escape protection)
          const isolatedHomeReal = await realpath(isolatedHome).catch(() => isolatedHome);
          const installPathReal = await realpath(installPath).catch(() => installPath);
          const relToHome = relative(isolatedHomeReal, installPathReal);
          const sep = process.platform === 'win32' ? '\\' : '/';
          if (
            relToHome !== '' &&
            (isAbsolute(relToHome) || relToHome === '..' || relToHome.startsWith(`..${sep}`))
          ) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: false,
                error: `install path escapes isolated HOME: ${installPath}`,
              },
            });
          }

          // Verify entry skill exists as a regular file in install dir
          const entrySkillPath = resolve(installPath, 'skills', action.entrySkill, 'SKILL.md');
          let entrySkillFound = false;
          try {
            const skillStat = await lstat(entrySkillPath);
            if (skillStat.isFile() && !skillStat.isSymbolicLink()) {
              entrySkillFound = true;
            }
          } catch {
            // entry skill not found
          }

          if (!entrySkillFound) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: false,
                error: `entry skill not found: skills/${action.entrySkill}/SKILL.md`,
              },
            });
          }

          // Bind the installed payload back to the sealed authority while
          // normalizing only transport-restored write permission bits.
          let manifestDigest;
          let manifestError = null;
          try {
            manifestDigest = await verifyInstalledMarketplacePayload(
              action,
              context,
              installPath,
              consumer,
            );
          } catch (digestErr) {
            // Preserve independently observed fields for diagnostics. This
            // raw digest is not accepted as plan authority because the error
            // is returned and verify therefore fails closed.
            try {
              const installedSnapshot = await computeFrozenSnapshot(installPath, {
                excludeRootEntries: consumerTransportExclusions(consumer),
              });
              manifestDigest = installedSnapshot.digest;
            } catch {
              manifestDigest = undefined;
            }
            manifestError = `failed to bind manifestDigest to frozen authority: ${digestErr.message}`;
          }

          // Build observation with CLI-proven fields only (no action backfill)
          const observation = {
            installed: true,
            installPath,
            entrySkillFound: true,
            entrySkill: action.entrySkill,
            manifestDigest,
            consumer,
          };

          // Fields from CLI evidence only (claude/codex; kimi observe returns
          // via the attestation path above and never reaches this point).
          if (consumer === 'claude') {
            // Claude list may not have name; extract plugin/marketplace from id
            const idParts = found.id.split('@');
            observation.plugin = idParts[0];
            observation.marketplace = idParts.slice(1).join('@');
            if (found.version) observation.version = found.version;
          } else if (consumer === 'codex') {
            if (found.name) observation.plugin = found.name;
            if (found.marketplaceName) observation.marketplace = found.marketplaceName;
            if (found.version) observation.version = found.version;
          }

          // Cross-validate version: evidence vs CLI
          if (evidence.version && observation.version && evidence.version !== observation.version) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: true,
                manifestDigest,
                error: `version mismatch: CLI reports ${observation.version}, evidence shows ${evidence.version}`,
              },
            });
          }

          // Verify installed manifest name/version matches CLI/evidence
          try {
            const installedManifestPath = resolve(installPath, consumer === 'claude' ? '.claude-plugin/plugin.json' : '.codex-plugin/plugin.json');
            const installedManifestContent = await readFile(installedManifestPath, 'utf8');
            const installedManifest = JSON.parse(installedManifestContent);
            const expectedName = observation.plugin;
            if (expectedName && installedManifest.name !== expectedName) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath,
                  entrySkillFound: true,
                  manifestDigest,
                  error: `installed manifest name "${installedManifest.name}" does not match CLI plugin "${expectedName}"`,
                },
              });
            }
            if (observation.version && installedManifest.version !== observation.version) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath,
                  entrySkillFound: true,
                  manifestDigest,
                  error: `installed manifest version "${installedManifest.version}" does not match CLI version "${observation.version}"`,
                },
              });
            }
          } catch (manifestErr) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: true,
                manifestDigest,
                error: `installed plugin manifest is missing or invalid: ${manifestErr.message}`,
              },
            });
          }

          // Cross-validate repo/ref: evidence requested values must match current action
          if (evidence.repo && evidence.repo !== action.repo) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: true,
                manifestDigest,
                error: `evidence repo "${evidence.repo}" does not match action repo "${action.repo}"`,
              },
            });
          }
          if (evidence.ref && evidence.ref !== action.ref) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: true,
                manifestDigest,
                error: `evidence ref "${evidence.ref}" does not match action ref "${action.ref}"`,
              },
            });
          }

          // Output repo/ref only after cross-validation
          if (evidence.repo) observation.repo = evidence.repo;
          if (evidence.ref) observation.ref = evidence.ref;

          return createResult({
            actionType,
            status: ActionStatus.OBSERVED,
            observation,
            error: manifestError,
          });
        }

        return createResult({
          actionType,
          status: ActionStatus.OBSERVED,
          observation: {},
        });
      } catch (err) {
        return createResult({
          actionType,
          status: ActionStatus.OBSERVED,
          error: err.message,
          observation: {},
        });
      }
    },

    /**
     * Verify: compare observed state against the frozen plan's expected state.
     */
    async verify(action, context) {
      const observed = await this.observe(action, context);

      if (observed.error) {
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.VERIFY_FAILED,
          observation: observed.observation,
          error: observed.error,
        });
      }

      const expected = action.expected ?? {};
      const { matches, mismatches } = matchObservation(expected, observed.observation);

      return createResult({
        actionType: action.actionType,
        status: matches ? ActionStatus.VERIFIED : ActionStatus.VERIFY_FAILED,
        observation: observed.observation,
        error: matches ? null : `Observation mismatch: ${mismatches.join('; ')}`,
      });
    },
  });
}

// Test-support exports: white-box regression tests assert the Kimi entry-skill
// resolution and manifest-reading contracts directly (FU-3 / MAJOR-4).
export { resolveKimiEntrySkillFile, readKimiManifest };
