/**
 * Bilingual README parity check for release-skill.
 *
 * Compares machine-readable HTML-comment markers between README.md and
 * README.zh-CN.md to ensure capability, command, safety, and version
 * markers are present in both languages. Does NOT perform natural
 * language semantic comparison -- only marker set equality.
 *
 * Marker formats supported:
 *   - Simple:       <!-- release-skill:<name> -->
 *   - Categorized:  <!-- release-skill:<category>:<name> -->
 *
 * @module readme/parity
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract all release-skill marker names from a README string.
 *
 * Matches HTML comments of the form:
 *   <!-- release-skill:<name> -->
 *   <!-- release-skill:<category>:<name> -->
 *
 * The canonical name is the last colon-separated segment.
 * The "exec" pseudo-marker is excluded (it serves a different purpose).
 *
 * @param {string} content
 * @returns {Set<string>} Set of marker names.
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compare bilingual README markers and report any drift.
 *
 * Extracts machine-readable markers from both README.md and
 * README.zh-CN.md in the given snapshot directory, then computes:
 * - enOnly:  markers present in English but missing from Chinese
 * - zhOnly:  markers present in Chinese but missing from English
 * - balanced: markers present in both languages
 *
 * @param {object} options
 * @param {string} options.snapshotDir  Path to the snapshot directory.
 * @returns {Promise<ParityReport>}
 *
 * @typedef {object} ParityReport
 * @property {string[]} enOnly    Markers found only in README.md.
 * @property {string[]} zhOnly    Markers found only in README.zh-CN.md.
 * @property {string[]} balanced  Markers found in both README files.
 *
 * @throws {Error} With code 'LANG_MISSING' if README.zh-CN.md is absent.
 */
export async function checkBilingualParity({ snapshotDir }) {
  const enPath = path.join(snapshotDir, 'README.md');
  const zhPath = path.join(snapshotDir, 'README.zh-CN.md');

  const enContent = await safeRead(enPath);
  const zhContent = await safeRead(zhPath);

  if (!enContent) {
    const error = new Error('README.md not found in snapshot directory');
    error.code = 'README_MISSING';
    throw error;
  }

  if (!zhContent) {
    const error = new Error('README.zh-CN.md not found in snapshot directory');
    error.code = 'LANG_MISSING';
    throw error;
  }

  const enMarkers = extractMarkers(enContent);
  const zhMarkers = extractMarkers(zhContent);

  const enOnly = [...enMarkers]
    .filter((name) => !zhMarkers.has(name))
    .sort();
  const zhOnly = [...zhMarkers]
    .filter((name) => !enMarkers.has(name))
    .sort();
  const balanced = [...enMarkers]
    .filter((name) => zhMarkers.has(name))
    .sort();

  return { enOnly, zhOnly, balanced };
}
