#!/usr/bin/env node
/**
 * build-bundle.mjs
 *
 * Deterministic CLI bundle for self-contained plugin execution.
 * Bundles bin/release-skill.mjs + all npm dependencies into a single
 * ESM file that runs without node_modules.
 *
 * Schemas and native addons remain external (loaded at runtime from
 * the plugin root via PKG_ROOT).
 *
 * Usage:
 *   node scripts/build-bundle.mjs           # build mode
 *   node scripts/build-bundle.mjs --check   # check-only mode (exit 1 on drift)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const CHECK_MODE = process.argv.includes('--check');

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const PKG_ROOT = join(SCRIPT_DIR, '..');
const ENTRY = join(PKG_ROOT, 'bin', 'release-skill-cli.mjs');
const OUTFILE = join(PKG_ROOT, 'bin', 'release-skill.bundle.mjs');

// Banner: compute PKG_ROOT deterministically from the bundle's own path.
// No env-var override — callers cannot hijack schema/native resolution.
// Uses import.meta.url only — process.argv[1] is not a reliable resource root.
//
// The banner also injects the package identity (__bundlePkg) as a build-time
// constant so the CLI --version probe carries no bundle-relative file
// dependency: the Claude and Codex adapter closures ship the bundle at a
// different depth with no package.json next to it, while the npm closure does.
// Reading package.json here (build input) keeps the output deterministic.
function buildBanner(pkgIdentity) {
  return `\
// --- release-skill bundle (deterministic build) ---
// Compute package root from the bundle's own file location (import.meta.url).
// The bundle lives at <PKG_ROOT>/bin/release-skill.bundle.mjs, so go up one level.
import { fileURLToPath as __bundleFileURLToPath } from 'node:url';
import { dirname as __bundleDirname, resolve as __bundleResolve } from 'node:path';
import { createRequire as __bundleCreateRequire } from 'node:module';
const __bundlePkgRoot = __bundleResolve(__bundleDirname(__bundleFileURLToPath(import.meta.url)), '..');
// Provide a real require() for CJS packages bundled into ESM (e.g. yaml, ajv).
const __bundleRealRequire = __bundleCreateRequire(import.meta.url);
// Package identity injected at build time — closure-independent --version probe.
const __bundlePkg = Object.freeze(${JSON.stringify(pkgIdentity)});
`;
}

// Pattern to replace esbuild's broken __require shim with a real require().
const REQUIRE_SHIM_PATTERN = /var __require = \/\* @__PURE__ \*\/ \(\(x\) => typeof require !== "undefined" \? require : typeof Proxy !== "undefined" \? new Proxy\(x, \{[\s\S]*?\}\) : x\)\(function\(x\) \{[\s\S]*?\}\);/;

const REQUIRE_SHIM_REPLACEMENT = `var __require = __bundleRealRequire;`;

async function buildBundle() {
  // Dynamic import so the script works even if esbuild is not yet installed.
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    console.error('Error: esbuild not installed. Run: npm install');
    process.exit(1);
  }

  const pkgJson = JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf-8'));
  const banner = buildBanner({ name: pkgJson.name, version: pkgJson.version });

  const result = await esbuild.build({
    entryPoints: [ENTRY],
    absWorkingDir: PKG_ROOT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: OUTFILE,
    banner: { js: banner },
    // External: Node.js builtins, native addon loader, and the native addon itself.
    external: [
      'node:*',
      '*/safe_write.node',
      '*.node',
    ],
    // Keep names for stack traces; deterministic across runs for same input.
    keepNames: true,
    // No minification — preserve readable output for debugging.
    minify: false,
    // Sourcemap not needed for production bundle.
    sourcemap: false,
    // Tree-shake unused code.
    treeShaking: true,
    // Write to outfile.
    write: false,
  });

  let content = result.outputFiles[0].text;

  // Replace esbuild's broken __require shim with a real require().
  if (REQUIRE_SHIM_PATTERN.test(content)) {
    content = content.replace(REQUIRE_SHIM_PATTERN, REQUIRE_SHIM_REPLACEMENT);
  }

  // Generated dependency comments may contain editor-authored trailing spaces.
  // Normalize them so committed bundles pass repository whitespace checks.
  content = content.replace(/[ \t]+$/gm, '');

  return content;
}

async function main() {
  const content = await buildBundle();

  if (CHECK_MODE) {
    let existing;
    try {
      existing = await readFile(OUTFILE, 'utf-8');
    } catch {
      console.error('Bundle drift: output file does not exist.');
      process.exit(1);
    }
    if (existing !== content) {
      console.error('Bundle drift: output differs from expected.');
      const existingHash = createHash('sha256').update(existing).digest('hex');
      const expectedHash = createHash('sha256').update(content).digest('hex');
      console.error(`  existing: sha256:${existingHash}`);
      console.error(`  expected: sha256:${expectedHash}`);
      process.exit(1);
    }
    console.log('Bundle in sync.');
    process.exit(0);
  }

  await mkdir(dirname(OUTFILE), { recursive: true });
  await writeFile(OUTFILE, content, 'utf-8');
  const hash = createHash('sha256').update(content).digest('hex');
  console.log(`Bundle written: ${OUTFILE}`);
  console.log(`  sha256:${hash}`);
  console.log(`  size: ${content.length} bytes`);
}

main().catch((err) => {
  console.error(`build-bundle failed: ${err.message}`);
  process.exit(1);
});
