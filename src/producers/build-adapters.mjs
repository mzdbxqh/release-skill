/**
 * Pure producer: build adapters from skills and plugin templates.
 *
 * Reads skill metadata from skills-src/ and plugin.json templates,
 * generates adapter directories for each platform (claude, codex).
 *
 * Deterministic: sorted directory enumeration, no timestamps, no randomness.
 *
 * @module producers/build-adapters
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

import { canonicalJson, sha256Hex } from '../core/digest.mjs';

/**
 * Compute an implementation digest from the source bytes of this module.
 *
 * @param {Buffer[]} sourceBytes
 * @returns {string}
 */
export function computeBuildAdaptersDigest(sourceBytes) {
  const h = createHash('sha256');
  for (const buf of sourceBytes) h.update(buf);
  h.update(`node:${process.version}`);
  h.update('locale:en-US timezone:UTC');
  return `sha256:${h.digest('hex')}`;
}

// Platform definitions (same as legacy script)
const PLATFORMS = [
  {
    name: 'claude',
    pluginDirName: '.claude-plugin',
    templateFileName: 'plugin.json',
    marketplaceFileName: 'marketplace.json',
    hasMarketplace: true,
  },
  {
    name: 'codex',
    pluginDirName: '.codex-plugin',
    templateFileName: 'plugin.json',
    hasMarketplace: false,
  },
];

/**
 * Collect skill metadata from skills-src/.
 *
 * @param {string} srcDir - Absolute path to skills-src/.
 * @returns {Promise<Array<{name:string,description:string,content:string}>>}
 */
async function collectSkills(srcDir) {
  const entries = await readdir(srcDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  dirs.sort();

  const skills = [];
  for (const dirName of dirs) {
    const skillMdPath = join(srcDir, dirName, 'SKILL.md');
    let content;
    try {
      content = await readFile(skillMdPath, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }

    // Extract description: first paragraph of the first ## section.
    const lines = content.split('\n');
    let inFirstSection = false;
    let pastSectionHeader = false;
    const descLines = [];
    for (const line of lines) {
      if (line.startsWith('## ')) {
        if (inFirstSection) break;
        inFirstSection = true;
        continue;
      }
      if (inFirstSection && !pastSectionHeader) {
        if (line.trim() === '') pastSectionHeader = true;
        continue;
      }
      if (pastSectionHeader) {
        if (line.trim() === '') break;
        descLines.push(line);
      }
    }
    const description = descLines.join('\n').trim();
    skills.push({ name: dirName, description, content });
  }
  return skills;
}

/**
 * Generate the full file tree for an adapter platform.
 *
 * @param {object} platform - Platform definition.
 * @param {Array} skills - Skill metadata array.
 * @param {object} templateJson - Parsed plugin.json template.
 * @param {object|null} marketplaceTemplateJson - Parsed marketplace template.
 * @returns {Promise<Array<{relPath:string,content:string}>>}
 */
async function generateAdapterFiles(platform, skills, templateJson, marketplaceTemplateJson = null) {
  const files = [];

  // Transform plugin.json: rewrite source paths
  const adapted = JSON.parse(JSON.stringify(templateJson));

  // Preserve platform-supported directory auto-discovery in generated adapters.
  // Codex validation requires the canonical "skills" directory, and Claude
  // also accepts the same plugin-root-relative directory contract.
  if (typeof adapted.skills === 'string') {
    adapted.skills = './skills/';
  } else if (Array.isArray(adapted.skills)) {
    for (const skill of adapted.skills) {
      skill.source = `../skills/${skill.name}/SKILL.md`;
    }
  }

  const pluginJsonContent = JSON.stringify(adapted, null, 2) + '\n';
  files.push({
    relPath: join(platform.pluginDirName, 'plugin.json'),
    content: pluginJsonContent,
  });

  // Generate marketplace.json for platforms that need it
  if (platform.hasMarketplace) {
    const marketplace = JSON.parse(JSON.stringify(marketplaceTemplateJson ?? {}));
    marketplace.name = adapted.name;
    marketplace.description = adapted.description;
    marketplace.owner = marketplace.owner ?? adapted.author;
    marketplace.plugins = [{
      ...(marketplace.plugins?.[0] ?? {}),
      name: adapted.name,
      source: './',
      version: adapted.version,
      description: adapted.description,
    }];
    const marketplaceContent = JSON.stringify(marketplace, null, 2) + '\n';
    files.push({
      relPath: join(platform.pluginDirName, 'marketplace.json'),
      content: marketplaceContent,
    });
  }

  // Copy SKILL.md files verbatim
  for (const skill of skills) {
    files.push({
      relPath: join('skills', skill.name, 'SKILL.md'),
      content: skill.content,
    });
  }

  // Sort for deterministic output
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

/**
 * Pure producer function for building adapters.
 *
 * @param {object} options
 * @param {string} [options.inputs] - Root directory path. Defaults to package root.
 * @param {string} options.output - Output directory path.
 * @param {string} [options.platformFilter] - Only generate for this platform name.
 */
export async function produceBuildAdapters({ inputs, output, platformFilter } = {}) {
  const defaultRoot = new URL('../..', import.meta.url).pathname;
  const root = inputs ?? defaultRoot;
  const srcDir = join(root, 'skills-src');

  const skills = await collectSkills(srcDir);

  const outputs = [];

  for (const platform of PLATFORMS) {
    if (platformFilter && platform.name !== platformFilter) continue;
    const templatePath = join(root, platform.pluginDirName, platform.templateFileName);
    const templateRaw = await readFile(templatePath, 'utf-8');
    const templateJson = JSON.parse(templateRaw);
    let marketplaceTemplateJson = null;
    if (platform.hasMarketplace) {
      try {
        marketplaceTemplateJson = JSON.parse(
          await readFile(join(root, platform.pluginDirName, platform.marketplaceFileName), 'utf-8'),
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    const files = await generateAdapterFiles(platform, skills, templateJson, marketplaceTemplateJson);

    for (const file of files) {
      const dstPath = join(output, file.relPath);
      await mkdir(dirname(dstPath), { recursive: true });
      const content = Buffer.from(file.content, 'utf-8');
      await writeFile(dstPath, content);

      outputs.push(Object.freeze({
        path: file.relPath,
        type: 'blob',
        mode: '100644',
        content,
        sha256: sha256Hex(content),
        size: content.length,
      }));
    }
  }

  return Object.freeze({
    outputs: Object.freeze(outputs),
    outputManifestDigest: digestEntryOutputs(outputs),
  });
}

/**
 * Compute manifest digest from output entries.
 *
 * @param {Array<{path:string,type:string,mode:string,sha256:string,size:number}>} entries
 * @returns {string}
 */
export function digestEntryOutputs(entries) {
  const canonical = entries.map(({ path, type, mode, sha256, size }) => ({
    path, type, mode, size, sha256,
  }));
  return `sha256:${sha256Hex(canonicalJson(canonical))}`;
}
