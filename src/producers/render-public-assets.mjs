/**
 * Pure producer: render public assets from standards/ and schemas/.
 *
 * Deterministically renders authoritative standards and schemas into the
 * public plugin directory. Normalizes line endings (LF), strips trailing
 * whitespace, ensures trailing newline. No timestamps in output — time
 * is only written to evidence.
 *
 * Deterministic: sorted file enumeration, content normalization, no randomness.
 *
 * @module producers/render-public-assets
 */

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

import { canonicalJson, sha256Hex } from '../core/digest.mjs';

/**
 * Compute an implementation digest from the source bytes of this module.
 *
 * @param {Buffer[]} sourceBytes
 * @returns {string}
 */
export function computeRenderDigest(sourceBytes) {
  const h = createHash('sha256');
  for (const buf of sourceBytes) h.update(buf);
  h.update(`node:${process.version}`);
  h.update('locale:en-US timezone:UTC');
  return `sha256:${h.digest('hex')}`;
}

/**
 * Recursively collect all file paths under dirPath.
 * Returns relative paths sorted by POSIX path for deterministic ordering.
 */
async function collectFiles(dirPath, base) {
  const result = [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectFiles(abs, base));
    } else if (entry.isFile()) {
      result.push(relative(base, abs));
    }
  }
  return result;
}

/**
 * Normalize line endings to LF, strip trailing whitespace per line,
 * and ensure a single trailing newline.
 */
function normalizeContent(buf) {
  return buf.toString('utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n+$/, '\n');
}

/**
 * Deterministically render all files from srcDir into outDir.
 *
 * @param {string} srcDir - Source directory.
 * @param {string} outDir - Output directory.
 * @returns {Promise<Array<{path:string,type:string,mode:string,content:Buffer,sha256:string,size:number}>>}
 */
async function renderDir(srcDir, outDir, pathPrefix) {
  await mkdir(outDir, { recursive: true });

  const files = await collectFiles(srcDir, srcDir);
  files.sort();

  const outputs = [];
  for (const rel of files) {
    const destPath = join(outDir, rel);
    await mkdir(join(destPath, '..'), { recursive: true });

    const raw = await readFile(join(srcDir, rel));
    const contentStr = normalizeContent(raw);
    const content = Buffer.from(contentStr, 'utf8');

    await writeFile(destPath, content, 'utf8');
    outputs.push(Object.freeze({
      path: pathPrefix ? `${pathPrefix}/${rel}` : rel,
      type: 'blob',
      mode: '100644',
      content,
      sha256: sha256Hex(content),
      size: content.length,
    }));
  }

  return outputs;
}

/**
 * Pure producer function for rendering public assets.
 *
 * @param {object} options
 * @param {string} [options.inputs] - Root directory containing standards/ and schemas/.
 * @param {string} options.output - Output base directory (references/ and schemas/ are created under it).
 * @returns {Promise<{outputs: Array, outputManifestDigest: string}>}
 */
export async function produceRenderPublicAssets({ inputs, output } = {}) {
  const defaultRoot = new URL('../../..', import.meta.url).pathname;
  const root = inputs ?? defaultRoot;

  const srcDirs = [
    { src: join(root, 'standards'), out: join(output, 'references'), label: 'standards', prefix: 'references' },
    { src: join(root, 'schemas'), out: join(output, 'schemas'), label: 'schemas', prefix: 'schemas' },
  ];

  const allOutputs = [];

  for (const { src, out, prefix } of srcDirs) {
    let dirExists = false;
    try {
      const s = await stat(src);
      dirExists = s.isDirectory();
    } catch {
      dirExists = false;
    }

    if (!dirExists) continue;

    const outputs = await renderDir(src, out, prefix);
    allOutputs.push(...outputs);
  }

  return Object.freeze({
    outputs: Object.freeze(allOutputs),
    outputManifestDigest: digestEntryOutputs(allOutputs),
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
