/**
 * Producer registry and deterministic closure runner.
 *
 * Provides:
 * - `buildProducerGraph(policy, registry)` — re-export from graph.mjs
 * - `createBuiltInProducerRegistry()` — registry of built-in producers
 * - `runProducerClosure({ registry, graph, inputSnapshot, artifactIds, tempRootFactory })`
 *   — runs producers in topological order with deterministic dual-run verification
 *
 * @module artifacts/producer-registry
 */

import { readFile, readdir, stat, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import {
  ReleaseError,
  ARTIFACT_POLICY_INVALID,
  PRODUCER_NONDETERMINISTIC,
  PRODUCER_SCOPE_VIOLATION,
} from '../core/errors.mjs';
import { buildProducerGraph } from './graph.mjs';
import { digestEntryManifest } from './entry.mjs';

// Re-export buildProducerGraph for convenience
export { buildProducerGraph };

// ---------------------------------------------------------------------------
// Static import collector (for implementation digest)
// ---------------------------------------------------------------------------

/**
 * Recursively collect all local (relative) static import targets from an
 * ES module source file. Returns absolute file paths of all reachable
 * .mjs modules in the dependency closure.
 *
 * @param {string} filePath - Absolute path to the entry module.
 * @param {Set<string>} [visited] - Already-visited paths (cycle guard).
 * @returns {string[]} Absolute paths of all reachable local modules.
 */
function collectStaticImports(filePath, visited = new Set()) {
  const abs = new URL(`file://${filePath}`).pathname;
  if (visited.has(abs)) return [];
  visited.add(abs);

  let source;
  try {
    source = readFileSync(abs, 'utf-8');
  } catch {
    return [abs];
  }

  const results = [abs];
  const importRe = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"](\.[^'"]+)['"]/g;
  let match;
  const dir = abs.replace(/\/[^/]*$/, '');

  while ((match = importRe.exec(source)) !== null) {
    const spec = match[1];
    let resolved = join(dir, spec);
    if (!resolved.endsWith('.mjs')) resolved += '.mjs';
    results.push(...collectStaticImports(resolved, visited));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Built-in producer registry
// ---------------------------------------------------------------------------

const BUILTIN_PRODUCERS = Object.freeze([
  Object.freeze({
    id: 'sync-skills',
    modulePath: '../producers/sync-skills.mjs',
    produceFn: 'produceSyncSkills',
    digestFn: 'computeSyncSkillsDigest',
  }),
  Object.freeze({
    id: 'build-adapters',
    modulePath: '../producers/build-adapters.mjs',
    produceFn: 'produceBuildAdapters',
    digestFn: 'computeBuildAdaptersDigest',
  }),
  Object.freeze({
    id: 'render-public-assets',
    modulePath: '../producers/render-public-assets.mjs',
    produceFn: 'produceRenderPublicAssets',
    digestFn: 'computeRenderDigest',
  }),
]);

/**
 * Create a fully loaded producer registry (async).
 *
 * Loads all built-in producer modules and computes implementation digests.
 * Implementation digest covers: producer module + all static local imports
 * (full dependency closure), pnpm-lock.yaml, process.version, and fixed
 * locale/timezone.
 *
 * @returns {Promise<ProducerRegistry>}
 */
export async function createBuiltInProducerRegistry() {
  const producers = new Map();

  // Resolve lockfile path (one level up from package root)
  const lockfilePath = join(new URL('../../..', import.meta.url).pathname, 'pnpm-lock.yaml');
  let lockfileBytes;
  try {
    lockfileBytes = await readFile(lockfilePath);
  } catch {
    lockfileBytes = Buffer.from('');
  }

  for (const def of BUILTIN_PRODUCERS) {
    const moduleUrl = new URL(def.modulePath, import.meta.url);
    const mod = await import(moduleUrl.href);
    const produce = mod[def.produceFn];
    const computeDigest = mod[def.digestFn];

    if (!produce || !computeDigest) {
      throw new Error(`Producer "${def.id}" missing ${def.produceFn} or ${def.digestFn}`);
    }

    // Collect full static dependency closure
    const modulePath = new URL(moduleUrl).pathname;
    const allModulePaths = collectStaticImports(modulePath);
    const allModuleBytes = await Promise.all(
      allModulePaths.map(async (p) => {
        try { return await readFile(p); } catch { return Buffer.from(''); }
      }),
    );

    const implementationDigest = computeDigest([...allModuleBytes, lockfileBytes]);

    producers.set(def.id, Object.freeze({ produce, implementationDigest }));
  }

  return Object.freeze({
    get(id) { return producers.get(id); },
  });
}

/**
 * Compute an implementation digest from source bytes.
 *
 * Covers: source bytes, process.version, fixed locale/timezone.
 *
 * @param {Buffer[]} sourceBytes
 * @returns {string}
 */
export function computeImplDigest(sourceBytes) {
  const h = createHash('sha256');
  for (const buf of sourceBytes) h.update(buf);
  h.update(`node:${process.version}`);
  h.update('locale:en-US timezone:UTC');
  return `sha256:${h.digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read all entries from a directory (recursively), PRESERVING content.
 * Returns entries with relative paths and actual file bytes.
 *
 * @param {string} dirPath - Absolute directory path.
 * @param {string} [relBase] - Relative base for entry paths.
 * @returns {Promise<Array>}
 */
async function readDirEntries(dirPath, relBase = '') {
  const entries = [];
  const items = await readdir(dirPath, { withFileTypes: true });

  for (const item of items) {
    if (item.name === '.git') continue;
    const absPath = join(dirPath, item.name);
    const relPath = relBase ? `${relBase}/${item.name}` : item.name;
    const st = await stat(absPath);

    if (st.isDirectory()) {
      entries.push(...await readDirEntries(absPath, relPath));
    } else {
      const content = await readFile(absPath);
      entries.push(Object.freeze({
        path: relPath,
        type: 'blob',
        mode: (st.mode & 0o111) ? '100755' : '100644',
        content,
        sha256: sha256Hex(content),
        size: st.size,
      }));
    }
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return Object.freeze(entries);
}

/**
 * Materialize entries to a directory.
 * Writes content from entries to disk.
 *
 * @param {Array} entries - Entry objects with relative paths and content.
 * @param {string} dirPath - Target directory.
 */
async function materializeEntries(entries, dirPath) {
  for (const entry of entries) {
    if (!entry.path) continue;
    const targetPath = join(dirPath, entry.path);
    if (entry.type === 'tree' || entry.kind === 'tree') {
      await mkdir(targetPath, { recursive: true });
    } else {
      await mkdir(join(targetPath, '..'), { recursive: true });
      if (entry.content) {
        await writeFile(targetPath, entry.content);
      }
    }
  }
}

/**
 * Verify producer determinism by running the producer twice in separate
 * temp directories and comparing output manifest digests.
 *
 * @param {Function} produce - The producer function.
 * @param {object} runOptions - Options passed to the producer.
 * @param {string} dir1 - First temp directory.
 * @param {string} dir2 - Second temp directory.
 * @returns {Promise<{entries: Array, outputDir: string}>} Entries from the second run.
 * @throws {ReleaseError} PRODUCER_NONDETERMINISTIC if outputs differ.
 */
async function verifyDeterminism(produce, runOptions, dir1, dir2) {
  // Run 1
  await produce({ ...runOptions, output: dir1 });
  const entries1 = await readDirEntries(dir1);

  // Run 2
  await produce({ ...runOptions, output: dir2 });
  const entries2 = await readDirEntries(dir2);

  // Compare output manifest digests
  const digest1 = digestEntryManifest(entries1);
  const digest2 = digestEntryManifest(entries2);

  if (digest1 !== digest2) {
    throw new ReleaseError(
      PRODUCER_NONDETERMINISTIC,
      `producer produced different outputs in two runs: ${digest1} vs ${digest2}`,
      { digest1, digest2 },
    );
  }

  // Clean up dir1 (the verification copy)
  await rm(dir1, { recursive: true, force: true }).catch(() => {});

  return { entries: entries2, outputDir: dir2 };
}

/**
 * Compute the upstream closure of a set of artifact IDs.
 * For each requested ID, includes all transitive upstream dependencies.
 *
 * @param {string[]} ids - Requested artifact IDs.
 * @param {object} graph - Producer graph.
 * @returns {Set<string>} All needed artifact IDs (including originals).
 */
function computeUpstreamClosure(ids, graph) {
  const needed = new Set(ids);
  const queue = [...ids];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const up of graph.upstreamOf(id)) {
      if (!needed.has(up)) {
        needed.add(up);
        queue.push(up);
      }
    }
  }
  return needed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run producer closure: execute producers in topological order, scoped to
 * requested artifact IDs and their upstream closure.
 *
 * Each producer is run twice in separate temp directories to verify
 * deterministic output. The second run's output is used as the
 * canonical result.
 *
 * For declared artifacts, the input is resolved from `inputSnapshot`.
 * For generated artifacts, the input is resolved from upstream producer
 * outputs (if available), falling back to `inputSnapshot`.
 *
 * @param {object} options
 * @param {ProducerRegistry} options.registry - Producer registry.
 * @param {object} options.graph - Producer graph from buildProducerGraph.
 * @param {Map<string, object[]>} options.inputSnapshot - Input entries per artifact ID.
 * @param {string[]} options.artifactIds - Artifact IDs to produce.
 * @param {Function} [options.tempRootFactory] - Factory for temp directories.
 * @returns {Promise<{byArtifact: Map<string, CandidateManifest>}>}
 */
export async function runProducerClosure({
  registry,
  graph,
  inputSnapshot,
  artifactIds,
  tempRootFactory = async () => mkdtemp(join(tmpdir(), 'producer-')),
} = {}) {
  // Validate requested artifact IDs exist in graph
  const generatedSet = new Set(graph.topologicalOrder);
  for (const id of artifactIds) {
    if (!generatedSet.has(id)) {
      throw new ReleaseError(
        ARTIFACT_POLICY_INVALID,
        `artifact "${id}" is not a generated artifact in the graph`,
        { id, generated: [...generatedSet] },
      );
    }
  }

  // Scope: only run the upstream closure of requested artifacts
  const neededSet = computeUpstreamClosure(artifactIds, graph);

  const outputMap = new Map(); // artifact ID → output directory path
  const byArtifact = new Map(); // artifact ID → CandidateManifest
  const tempDirs = [];

  try {
    for (const id of graph.topologicalOrder) {
      // Skip artifacts outside the needed scope
      if (!neededSet.has(id)) continue;

      const producerName = graph.producerOf(id);
      if (!producerName) continue;
      const entry = registry.get(producerName);
      if (!entry) continue;

      const { produce, implementationDigest } = entry;

      // Resolve input path:
      // For generated artifacts, prefer upstream producer output.
      // For declared artifacts, use inputSnapshot.
      let inputPath;

      // Check if any upstream artifact produced output
      const upstreamIds = graph.upstreamOf(id);
      for (const upstreamId of upstreamIds) {
        if (outputMap.has(upstreamId)) {
          inputPath = outputMap.get(upstreamId);
          break;
        }
      }

      if (!inputPath) {
        const inputEntries = inputSnapshot.get(id);
        if (inputEntries) {
          // For tree entries: the path field is the absolute root directory
          // For file entries: the path field is the absolute file path
          const first = inputEntries[0];
          if (first && first.path) {
            const absPath = first.path.startsWith('/') ? first.path : join(process.cwd(), first.path);
            try {
              const st = await stat(absPath);
              if (st.isDirectory()) {
                inputPath = absPath;
              } else {
                // File entry — materialize to temp dir
                const matDir = await tempRootFactory();
                tempDirs.push(matDir);
                await materializeEntries(inputEntries, matDir);
                inputPath = matDir;
              }
            } catch {
              // Not a valid path — materialize entries
              const matDir = await tempRootFactory();
              tempDirs.push(matDir);
              await materializeEntries(inputEntries, matDir);
              inputPath = matDir;
            }
          } else {
            // No path — materialize to temp dir
            const matDir = await tempRootFactory();
            tempDirs.push(matDir);
            await materializeEntries(inputEntries, matDir);
            inputPath = matDir;
          }
        }
      }

      // Create temp directories for dual-run verification
      const dir1 = await tempRootFactory();
      const dir2 = await tempRootFactory();
      tempDirs.push(dir1, dir2);

      const runOptions = { inputs: inputPath };

      // Verify determinism and get entries from second run
      const { entries, outputDir } = await verifyDeterminism(produce, runOptions, dir1, dir2);

      // Build input manifest digest
      let inputManifestDigest;
      if (inputPath) {
        const inputEntriesForDigest = await readDirEntries(inputPath);
        inputManifestDigest = digestEntryManifest(inputEntriesForDigest);
      } else {
        inputManifestDigest = digestEntryManifest([]);
      }

      // Build CandidateManifest
      const manifest = Object.freeze({
        producerId: id,
        implementationDigest,
        inputManifestDigest,
        outputManifestDigest: digestEntryManifest(entries),
        outputs: entries,
        outputDir,
      });

      outputMap.set(id, outputDir);
      byArtifact.set(id, manifest);
    }
  } finally {
    // Temp dirs containing canonical outputs are NOT cleaned here;
    // they are cleaned by the caller or at process exit.
  }

  return Object.freeze({ byArtifact });
}
