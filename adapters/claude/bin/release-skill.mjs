#!/usr/bin/env node
/**
 * release-skill CLI entry point.
 *
 * Loads the self-contained bundle (release-skill.bundle.mjs) which runs
 * without node_modules. Fails closed with a clear error when the bundle
 * is missing — never falls back to source CLI in installed state.
 */

import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(__dirname, 'release-skill.bundle.mjs');

let bundleExists = false;
try {
  const st = await stat(bundlePath);
  bundleExists = st.isFile();
} catch {
  // Bundle does not exist.
}

if (!bundleExists) {
  console.error(
    `Error: release-skill bundle not found at:\n  ${bundlePath}\n` +
    `The bundle is required for installed-plugin execution.\n` +
    `Reinstall the plugin or run 'node scripts/build-bundle.mjs' in the source checkout.`,
  );
  process.exit(1);
}

await import(bundlePath);
