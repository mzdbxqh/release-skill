/**
 * README contract evaluation for release-skill.
 *
 * Validates that README files in a snapshot directory contain
 * machine-readable HTML-comment markers covering capability, command,
 * safety, and version requirements. Also extracts executable code
 * blocks annotated with release-skill:exec metadata.
 *
 * Marker formats supported:
 *   - Simple:       <!-- release-skill:<name> -->
 *   - Categorized:  <!-- release-skill:<category>:<name> -->
 * Exec metadata:    <!-- release-skill:exec fixture=<id> -->
 *
 * @module readme/contract
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Marker definitions
// ---------------------------------------------------------------------------

/**
 * All known contract markers with their category and bilingual key.
 * Markers may appear in READMEs as:
 *   <!-- release-skill:<name> -->              (simple)
 *   <!-- release-skill:<category>:<name> -->   (categorized)
 */
const MARKER_DEFS = [
  // capability
  { category: 'capability', name: 'safe-first-command', bilingualKey: 'safe-first-command', required: true },
  { category: 'capability', name: 'supported-topology', bilingualKey: 'supported-topology', required: false },
  { category: 'capability', name: 'unsupported-scope', bilingualKey: 'unsupported-scope', required: false },
  { category: 'capability', name: 'external-write-boundary', bilingualKey: 'external-write-boundary', required: true },
  // command
  { category: 'command', name: 'release-help', bilingualKey: 'release-help', required: false },
  { category: 'command', name: 'safe-assess-command', bilingualKey: 'safe-assess-command', required: false },
  // safety
  { category: 'safety', name: 'publish-authorization', bilingualKey: 'publish-authorization', required: false },
  { category: 'safety', name: 'reconcile-guidance', bilingualKey: 'reconcile-guidance', required: false },
  { category: 'safety', name: 'security', bilingualKey: 'security', required: false },
  { category: 'safety', name: 'troubleshooting', bilingualKey: 'troubleshooting', required: false },
  // version
  { category: 'version', name: 'skill-list', bilingualKey: 'skill-list', required: false },
  { category: 'version', name: 'version-info', bilingualKey: 'version-info', required: false },
];

/** Set of required marker names. */
const REQUIRED_MARKER_NAMES = new Set(
  MARKER_DEFS.filter((d) => d.required).map((d) => d.name),
);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract all marker names present in a README string.
 *
 * Handles both simple (release-skill:<name>) and categorized
 * (release-skill:<category>:<name>) formats. The "exec" pseudo-marker
 * is excluded since it serves a different purpose (executable metadata).
 *
 * @param {string} content
 * @returns {Set<string>} Set of plain marker names.
 */
function extractMarkers(content) {
  const regex = /<!--\s*release-skill:((?:[\w-]+:)*[\w-]+)\s*-->/g;
  const found = new Set();
  let match;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[1];
    // Skip exec metadata pseudo-marker
    if (raw.startsWith('exec')) continue;
    // The canonical name is the last colon-separated segment.
    const parts = raw.split(':');
    const name = parts[parts.length - 1];
    found.add(name);
  }
  return found;
}

/**
 * Extract executable commands from fenced code blocks that carry
 * release-skill:exec metadata on the preceding line.
 *
 * @param {string} content
 * @returns {Array<{ fixture: string, language: string, commands: string[] }>}
 */
function extractExecBlocks(content) {
  const results = [];
  const regex = /<!--\s*release-skill:exec\s+fixture=([\w-]+)\s*-->\s*\n```(sh|bash)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const fixture = match[1];
    const language = match[2];
    const blockBody = match[3];
    const commands = blockBody
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    results.push({ fixture, language, commands });
  }
  return results;
}

/**
 * Safely read a file; return null if absent.
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
async function safeRead(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Resolve a single skill entry to its name.
 *
 * Handles both the legacy object format ({ name: string }) and the
 * official Codex plugin manifest string-path format
 * (e.g. "../skills-src/release-help/SKILL.md").
 *
 * @param {string | { name: string }} entry
 * @returns {string | null}
 */
function resolveSkillName(entry) {
  if (typeof entry === 'string') {
    // String path: extract directory name as skill name.
    // "../skills-src/release-help/SKILL.md" → "release-help"
    const parts = entry.replace(/\\/g, '/').split('/');
    // Walk backwards to find the first segment that looks like a skill name
    // (skipping SKILL.md or similar file names).
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = parts[i];
      if (seg && !seg.includes('.')) return seg;
    }
    return null;
  }
  if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
    return entry.name;
  }
  return null;
}

/**
 * Extract all skill names from a plugin manifest skills array.
 * Supports both object arrays ({ name }) and string-path arrays.
 *
 * @param {Array<{ name: string } | string>} skills
 * @returns {string[]}
 */
export function extractManifestSkillNames(skills) {
  if (!Array.isArray(skills)) return [];
  return skills.map(resolveSkillName).filter(Boolean);
}

/**
 * Find Skill names mentioned in README content.
 * @param {string} content
 * @param {string[]} manifestSkillNames
 * @returns {string[]}
 */
function findSkillNames(content, manifestSkillNames) {
  return manifestSkillNames.filter((name) => content.includes(name));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate README files in a snapshot directory against the release-skill
 * contract. Requires both README.md and README.zh-CN.md to be present.
 *
 * @param {object} options
 * @param {string} options.snapshotDir  Path to the snapshot directory.
 * @param {{ name?: string, entrySkill?: string, skills?: Array<{ name: string }> }} [options.pluginManifest]
 *   Optional plugin manifest for Skill name validation.
 * @returns {Promise<ReadmeReport>}
 *
 * @typedef {object} ReadmeReport
 * @property {string[]} present   Required marker names found in README.md.
 * @property {string[]} missing   Required marker names absent from README.md.
 * @property {object}   bilingualMarkers  Per-category arrays of { en, zh-CN } values.
 * @property {object}   firstScreen  Booleans for the four first-screen questions.
 * @property {string[]} skillNames  Skill names found in README content.
 * @property {Array<{ fixture: string, language: string, commands: string[] }>} execCommands
 * @property {Array<{ code: string, message: string, language?: string }>} findings
 */
export async function evaluateReadme({ snapshotDir, pluginManifest }) {
  const findings = [];

  // ---- 1. Read README files ----
  const enPath = path.join(snapshotDir, 'README.md');
  const zhPath = path.join(snapshotDir, 'README.zh-CN.md');

  const enContent = await safeRead(enPath);
  const zhContent = await safeRead(zhPath);

  if (!enContent) {
    findings.push({
      code: 'README_MISSING',
      message: 'README.md not found in snapshot directory',
    });
  }
  if (!zhContent) {
    findings.push({
      code: 'LANG_MISSING',
      message: 'README.zh-CN.md not found in snapshot directory',
      language: 'zh-CN',
    });
  }

  // ---- 2. Extract markers from each README ----
  const enMarkers = enContent ? extractMarkers(enContent) : new Set();
  const zhMarkers = zhContent ? extractMarkers(zhContent) : new Set();

  // ---- 3. Determine present / missing for required markers ----
  const present = [...REQUIRED_MARKER_NAMES].filter((name) => enMarkers.has(name)).sort();
  const missing = [...REQUIRED_MARKER_NAMES].filter((name) => !enMarkers.has(name)).sort();

  // ---- 4. Build bilingual markers per category ----
  const bilingualMarkers = {};
  for (const category of ['capability', 'command', 'safety', 'version']) {
    bilingualMarkers[category] = [];
  }

  for (const def of MARKER_DEFS) {
    bilingualMarkers[def.category].push({
      en: enMarkers.has(def.name) ? def.bilingualKey : '',
      'zh-CN': zhMarkers.has(def.name) ? def.bilingualKey : '',
    });
  }

  // ---- 5. First-screen questions ----
  const firstScreen = {
    identity: enContent ? /^#\s+.+$/m.test(enContent) : false,
    audienceProblem: enContent
      ? enMarkers.has('unsupported-scope') ||
        (enContent.includes('release-skill') && /who|适合|需要|problem|问题/i.test(enContent))
      : false,
    externalWriteBoundary: enMarkers.has('external-write-boundary'),
    safeFirstCommand: enMarkers.has('safe-first-command'),
  };

  // ---- 6. Skill names from manifest ----
  const manifestSkillNames = extractManifestSkillNames(pluginManifest?.skills);
  const skillNames = enContent
    ? findSkillNames(enContent, manifestSkillNames)
    : [];

  // ---- 7. Extract executable commands ----
  const execCommands = enContent ? extractExecBlocks(enContent) : [];
  if (zhContent) {
    const zhExec = extractExecBlocks(zhContent);
    for (const block of zhExec) {
      const existing = execCommands.find(
        (e) => e.fixture === block.fixture && e.language === block.language,
      );
      if (!existing) {
        execCommands.push(block);
      }
    }
  }

  return {
    present,
    missing,
    bilingualMarkers,
    firstScreen,
    skillNames,
    execCommands,
    findings,
  };
}
