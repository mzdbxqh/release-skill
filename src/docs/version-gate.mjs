/**
 * Release docs version consistency gate.
 *
 * README, INSTALL, and CHANGELOG are human-maintained content. A release
 * freezes only the current truth: prepare/publish never rewrite or refresh
 * these docs. Maintainers must update the docs first, then prepare, review,
 * and approve. This gate makes version drift fail closed before release:
 *
 *   - the English README, Chinese README, English INSTALL, and Chinese
 *     INSTALL each carry a machine-readable current release version marker
 *     whose value equals package.json.version exactly;
 *   - CHANGELOG.md carries a formal `## [<version>]` heading for the current
 *     package version (a body mention or an internal candidate note does not
 *     substitute for the heading).
 *
 * The gate is a pure read-only check; it never edits files. It is wired into
 * the package test suite so `pnpm test:release` blocks a prepare when docs
 * have drifted from the package version.
 *
 * @module src/docs/version-gate
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The machine-readable marker tag carried by every public doc file. */
export const RELEASE_VERSION_MARKER_TAG = 'release-skill:release-version';

/**
 * Marker pattern. The value is captured; e.g.
 *   <!-- release-skill:release-version: 0.1.4 -->
 * Global: every occurrence is validated so a stale duplicate cannot hide.
 */
const MARKER_PATTERN = new RegExp(
  `<!--\\s*${RELEASE_VERSION_MARKER_TAG}:\\s*([^\\s>]+)\\s*-->`,
  'g',
);

/** Public docs that must carry the marker, in both languages. */
export const VERSIONED_DOC_FILES = [
  'README.md',
  'README.zh-CN.md',
  'INSTALL.md',
  'INSTALL.zh-CN.md',
];

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Escape a string for literal use inside a RegExp.
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract every release-version marker value from doc content.
 * @param {string} content
 * @returns {string[]}
 */
export function extractReleaseVersionMarkers(content) {
  return [...String(content ?? '').matchAll(MARKER_PATTERN)].map((match) => match[1]);
}

/**
 * Render the canonical marker line for a version.
 * @param {string} version
 * @returns {string}
 */
export function renderReleaseVersionMarker(version) {
  return `<!-- ${RELEASE_VERSION_MARKER_TAG}: ${version} -->`;
}

/**
 * Validate that the human-maintained release docs in `packageDir` agree with
 * package.json.version. Read-only; never writes.
 *
 * @param {object} options
 * @param {string} options.packageDir Directory containing package.json and
 *   the public docs.
 * @returns {Promise<{
 *   passed: boolean,
 *   version: string | null,
 *   markers: Record<string, string[]>,
 *   changelogHeading: boolean,
 *   failures: string[],
 * }>}
 */
export async function validateDocsVersionConsistency({ packageDir }) {
  const failures = [];
  const markers = {};
  let changelogHeading = false;
  let version = null;

  try {
    const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      version = pkg.version;
    }
  } catch (error) {
    failures.push(`package.json: cannot read package version (${error?.code ?? error?.message ?? 'unknown error'})`);
  }
  if (version === null) {
    failures.push('package.json: version is missing; docs version gate fails closed');
  } else if (!SEMVER_PATTERN.test(version)) {
    failures.push(`package.json: version "${version}" is not a valid semver value`);
  }

  if (version !== null) {
    for (const file of VERSIONED_DOC_FILES) {
      let content;
      try {
        content = await readFile(join(packageDir, file), 'utf8');
      } catch {
        failures.push(`${file}: missing; release docs must ship in both languages`);
        continue;
      }
      const found = extractReleaseVersionMarkers(content);
      markers[file] = found;
      if (found.length === 0) {
        failures.push(
          `${file}: missing machine-readable release version marker "${renderReleaseVersionMarker(version)}"`,
        );
      }
      for (const value of found) {
        if (value !== version) {
          failures.push(
            `${file}: release version marker "${value}" does not match package version "${version}"; ` +
            'update the docs first, then prepare, review, and approve',
          );
        }
      }
    }

    let changelog;
    try {
      changelog = await readFile(join(packageDir, 'CHANGELOG.md'), 'utf8');
    } catch {
      failures.push('CHANGELOG.md: missing');
    }
    if (changelog !== undefined) {
      // A formal heading starts a line: "## [0.1.4]" optionally followed by a
      // date. A body mention ("0.1.4 was an internal candidate...") does not
      // substitute for the heading.
      changelogHeading = new RegExp(`^##\\s*\\[${escapeRegExp(version)}\\](?:\\s|$)`, 'm').test(changelog);
      if (!changelogHeading) {
        failures.push(
          `CHANGELOG.md: missing formal "## [${version}]" heading for the current package version; ` +
          'internal unreleased candidates may be explained in the body but cannot replace the entry',
        );
      }
    }
  }

  return {
    passed: failures.length === 0,
    version,
    markers,
    changelogHeading,
    failures,
  };
}
