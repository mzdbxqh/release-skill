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
  // Fail closed with static text only: never interpolate bundlePath (or any
  // other machine-specific value) so a copied/installed launcher cannot leak
  // absolute paths, usernames, or host layout on stdout/stderr. This branch
  // is self-contained by design — it must not import src/* or rely on the
  // missing bundle's redaction helpers.
  console.error(
    `Error: release-skill bundle not found (release-skill.bundle.mjs).\n` +
    `The self-contained bundle is required for installed-plugin execution.\n` +
    `Reinstall the plugin, or run 'node scripts/build-bundle.mjs' in a source checkout to rebuild it.`,
  );
  process.exit(1);
}

// The bundle owns the command lifecycle: its entry awaits command completion
// and exits with the real business exit code (success, business errors,
// handled async rejections, unknown commands). The launcher only guards the
// load itself: if the bundle cannot be evaluated (corrupt or incompatible
// build), fail closed with static text only — module-load failures carry
// absolute paths in their messages, so the failure is never interpolated.
try {
  await import(bundlePath);
} catch {
  console.error(
    `Error: release-skill bundle failed to load (release-skill.bundle.mjs).\n` +
    `The self-contained bundle is required for installed-plugin execution.\n` +
    `Reinstall the plugin, or run 'node scripts/build-bundle.mjs' in a source checkout to rebuild it.`,
  );
  process.exit(1);
}
