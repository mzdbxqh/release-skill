/**
 * Secure project configuration loader for the release-skill system.
 *
 * Design constraints:
 * - Reads `.release-skill/project.yaml` by default (path overridable).
 * - YAML parsing rejects aliases (including merge keys) and duplicate keys.
 * - Parsed content is validated against the release-project JSON Schema
 *   loaded from the formal `schemas/release-project.schema.json` file
 *   (single source of truth).
 * - A deterministic configDigest is computed via canonicalJson + sha256Hex.
 * - Paths are validated to remain within the project root.
 * - `unit.source`, `publicFiles.from/to`, and `requiredPublicFiles` are
 *   validated through the shared `canonicalPublicPath` helper.
 * - Target collisions use the shared `publicPathCollisionKey` helper.
 *
 * @module config
 */

import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute, relative, normalize } from 'node:path';
import YAML, { Alias } from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { canonicalJson, sha256Hex } from './digest.mjs';
import { ReleaseError, CONFIG_INVALID } from './errors.mjs';
import { canonicalPublicPath, publicPathCollisionKey } from '../snapshot/public-path.mjs';
import { isReservedReleaseControlPath } from './baseline.mjs';
import { readTrustedPackageResource } from './trusted-resource.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default configuration file path, relative to the project root. */
const DEFAULT_CONFIG_REL = '.release-skill/project.yaml';

// ---------------------------------------------------------------------------
// Load the formal release-project JSON Schema (single source of truth)
// ---------------------------------------------------------------------------

let RELEASE_PROJECT_SCHEMA;
try {
  const schemaRaw = (await readTrustedPackageResource(
    'schemas/release-project.schema.json',
  )).toString('utf8');
  RELEASE_PROJECT_SCHEMA = JSON.parse(schemaRaw);
} catch (err) {
  if (err instanceof ReleaseError) throw err;
  // Fail closed: if the formal schema cannot be loaded, refuse to operate.
  throw new ReleaseError(
    CONFIG_INVALID,
    'cannot parse formal release-project schema',
    { resource: 'schemas/release-project.schema.json', cause: err.code ?? 'PARSE_FAILED' },
  );
}

// ---------------------------------------------------------------------------
// Schema validator (compiled once, reused across calls)
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateConfig = ajv.compile(RELEASE_PROJECT_SCHEMA);

// ---------------------------------------------------------------------------
// YAML safety checks
// ---------------------------------------------------------------------------

/**
 * Recursively walk a YAML AST node and return true if any Alias node is found.
 *
 * An Alias node represents a YAML alias reference (`*name`) or a merge key
 * (`<<: *name`). Both are rejected for security and determinism reasons.
 *
 * @param {import('yaml').Node | null | undefined} node
 * @returns {boolean}
 */
function containsAlias(node) {
  if (!node || typeof node !== 'object') {
    return false;
  }

  // Direct alias node (from the yaml library's Alias class)
  if (node instanceof Alias) {
    return true;
  }

  // YAMLMap or YAMLSeq: walk children
  if (node.items && Array.isArray(node.items)) {
    for (const item of node.items) {
      // Pair (map entry) - check key and value
      if (item.key !== undefined && containsAlias(item.key)) {
        return true;
      }
      if (item.value !== undefined && containsAlias(item.value)) {
        return true;
      }
      // Bare node in a sequence
      if (item.key === undefined && containsAlias(item)) {
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Resolve and validate a configuration file path.
 *
 * The resolved path must be within (or equal to) the project root. Both
 * absolute and relative configPath values are accepted; if relative, they
 * are resolved against root.
 *
 * @param {string} root - Absolute project root path.
 * @param {string} configPath - Absolute or relative path to the config file.
 * @returns {string} The resolved, validated absolute path.
 * @throws {ReleaseError} CONFIG_INVALID if the path escapes root.
 */
function resolveConfigPath(root, configPath) {
  const rootNorm = normalize(root);

  // Resolve configPath against root if relative
  const resolved = isAbsolute(configPath)
    ? normalize(configPath)
    : resolve(rootNorm, configPath);

  // Ensure resolved path is inside root
  const rel = relative(rootNorm, resolved);
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `config path "${configPath}" resolves outside project root "${root}"`,
      { configPath, root, resolved },
    );
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load, parse, validate, and digest a project configuration file.
 *
 * Steps:
 * 1. Resolve and validate the config file path against root.
 * 2. Read the file content as UTF-8.
 * 3. Parse as YAML using `parseDocument` to access the AST.
 * 4. Reject YAML aliases (including merge keys) by walking the AST.
 * 5. Reject duplicate keys via the document's error list.
 * 6. Extract the parsed JavaScript value and validate against the schema.
 * 7. Validate paths using shared canonicalPublicPath helper.
 * 8. Compile forbiddenContentPatterns (fail closed on invalid regex).
 * 9. Compute a deterministic configDigest from the canonical JSON.
 *
 * @param {Object} options
 * @param {string} options.root - Absolute path to the project root directory.
 * @param {string} [options.configPath] - Path to the config file. If relative,
 *   resolved against root. Defaults to `.release-skill/project.yaml`.
 *
 * @returns {Promise<{ config: object, configPath: string, configDigest: string }>}
 *
 * @throws {ReleaseError} CONFIG_INVALID on any validation failure, including:
 *   - File not found or unreadable
 *   - YAML syntax errors
 *   - YAML aliases or merge keys detected
 *   - Duplicate YAML keys
 *   - Schema validation failure
 *   - Path escaping project root
 *   - Invalid path characters (backslash, NUL, traversal)
 *   - Target collisions (exact, case-fold, NFC)
 *   - Invalid regex in forbiddenContentPatterns
 */
export async function loadProjectConfig({ root, configPath } = {}) {
  // --- Validate root ---
  if (!root || typeof root !== 'string') {
    throw new ReleaseError(CONFIG_INVALID, 'root must be a non-empty string');
  }

  // --- Resolve config path ---
  const effectivePath = configPath ?? DEFAULT_CONFIG_REL;
  const absConfigPath = resolveConfigPath(root, effectivePath);

  // --- Read file ---
  let content;
  try {
    content = await readFile(absConfigPath, 'utf8');
  } catch (err) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `cannot read config file: ${err.message}`,
      { configPath: absConfigPath, cause: err.code },
    );
  }

  // --- Parse YAML with AST access ---
  let doc;
  try {
    doc = YAML.parseDocument(content);
  } catch (err) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `YAML parse error: ${err.message}`,
      { configPath: absConfigPath },
    );
  }

  // --- Reject YAML aliases (including merge keys) ---
  if (containsAlias(doc.contents)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      'YAML aliases and merge keys are not allowed in project configuration',
      { configPath: absConfigPath },
    );
  }

  // --- Reject duplicate keys ---
  const dupKeyErrors = doc.errors.filter(
    (e) => e.message && e.message.includes('unique'),
  );
  if (dupKeyErrors.length > 0) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `duplicate keys detected in YAML: ${dupKeyErrors[0].message}`,
      { configPath: absConfigPath, errors: dupKeyErrors.map((e) => e.message) },
    );
  }

  // --- Check for any other YAML errors ---
  if (doc.errors.length > 0) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `YAML parse errors: ${doc.errors.map((e) => e.message).join('; ')}`,
      { configPath: absConfigPath, errors: doc.errors.map((e) => e.message) },
    );
  }

  // --- Extract parsed value ---
  const config = doc.toJSON();
  if (config === null || config === undefined || typeof config !== 'object') {
    throw new ReleaseError(
      CONFIG_INVALID,
      'config file must contain a YAML mapping (object)',
      { configPath: absConfigPath },
    );
  }

  // Detect the removed policy-level field before generic schema validation so
  // existing projects receive one stable, actionable migration diagnostic.
  if (
    config.policy &&
    typeof config.policy === 'object' &&
    Object.hasOwn(config.policy, 'requiredPublicFiles')
  ) {
    throw new ReleaseError(
      CONFIG_INVALID,
      'policy.requiredPublicFiles is no longer supported; move it to releaseUnits[].requiredPublicFiles',
      {
        field: 'policy.requiredPublicFiles',
        migrationTarget: 'releaseUnits[].requiredPublicFiles',
      },
    );
  }

  // --- Contextual path prevalidation (BEFORE schema validation) ---
  // Validates known path fields using the shared canonicalPublicPath helper
  // to produce rich error details with unitId and field name. Structure
  // errors (missing fields, wrong types) are left to schema validation.
  // Contextual prevalidation: confirm releaseUnits is an array; each unit
  // must be a non-null object before reading properties.
  if (!Array.isArray(config.releaseUnits)) {
    // Schema validation will catch this with CONFIG_INVALID.
    // Skip prevalidation to avoid TypeError.
  } else {
  for (const unit of config.releaseUnits) {
    if (unit === null || unit === undefined || typeof unit !== 'object') continue;
    if (typeof unit.id !== 'string' || typeof unit.source !== 'string') continue;

    // Validate unit.source (allow standalone `.`)
    try {
      canonicalPublicPath(unit.source, { allowDot: true });
    } catch (err) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `unit "${unit.id}" has invalid source path: ${err.message}`,
        { unitId: unit.id, source: unit.source, field: 'source' },
      );
    }

    // Validate publicFiles[].from and .to
    if (Array.isArray(unit.publicFiles)) {
      for (const mapping of unit.publicFiles) {
        if (typeof mapping === 'object' && mapping !== null) {
          if (typeof mapping.from === 'string') {
            try {
              const canonicalFrom = canonicalPublicPath(mapping.from).path;
              if (isReservedReleaseControlPath(canonicalFrom)) {
                throw new Error('release-skill control-plane paths are reserved and cannot be public inputs');
              }
            } catch (err) {
              throw new ReleaseError(
                CONFIG_INVALID,
                `unit "${unit.id}" has invalid publicFiles[].from: ${err.message}`,
                { unitId: unit.id, from: mapping.from, field: 'publicFiles[].from' },
              );
            }
          }
          if (typeof mapping.to === 'string') {
            try {
              canonicalPublicPath(mapping.to);
            } catch (err) {
              throw new ReleaseError(
                CONFIG_INVALID,
                `unit "${unit.id}" has invalid publicFiles[].to: ${err.message}`,
                { unitId: unit.id, to: mapping.to, field: 'publicFiles[].to' },
              );
            }
          }
        }
      }
    }

    // Validate requiredPublicFiles
    if (Array.isArray(unit.requiredPublicFiles)) {
      for (const req of unit.requiredPublicFiles) {
        if (typeof req === 'string') {
          try {
            canonicalPublicPath(req);
          } catch (err) {
            throw new ReleaseError(
              CONFIG_INVALID,
              `unit "${unit.id}" has invalid requiredPublicFiles entry: ${err.message}`,
              { unitId: unit.id, required: req, field: 'requiredPublicFiles' },
            );
          }
        }
      }
    }
  }
  } // end of contextual prevalidation else block

  // --- Schema validation (using formal JSON schema) ---
  const valid = validateConfig(config);
  if (!valid) {
    const errors = validateConfig.errors ?? [];
    const summary = errors
      .map((e) => `${e.instancePath || '/'}: ${e.message}`)
      .join('; ');
    throw new ReleaseError(
      CONFIG_INVALID,
      `config schema validation failed: ${summary}`,
      { configPath: absConfigPath, validationErrors: errors },
    );
  }

  // --- Compile forbiddenContentPatterns (fail closed on invalid regex) ---
  const forbiddenContentPatterns = config.policy?.forbiddenContentPatterns ?? [];
  for (const pattern of forbiddenContentPatterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) continue;
    try {
      new RegExp(pattern);
    } catch (err) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `invalid regex in forbiddenContentPatterns: "${pattern}": ${err.message}`,
        { configPath: absConfigPath, pattern, cause: err.message },
      );
    }
  }

  // --- Cross-field validation (cannot be expressed in JSON Schema) ---
  // JSON Schema validates structure; these checks verify semantic constraints
  // across fields within each release unit.
  if (!Array.isArray(config.releaseUnits)) {
    // Schema validation will catch this with CONFIG_INVALID.
  } else
  for (const unit of config.releaseUnits) {
    if (unit === null || unit === undefined || typeof unit !== 'object') continue;
    // 1. Validate publicFiles[].to uniqueness using shared collision key
    const toTargets = unit.publicFiles ?? [];
    const exactSet = new Set();
    const collisionKeyMap = new Map();
    for (const mapping of toTargets) {
      const to = mapping.to;
      // Exact duplicate
      if (exactSet.has(to)) {
        throw new ReleaseError(
          CONFIG_INVALID,
          `unit "${unit.id}" has duplicate publicFiles[].to: "${to}"`,
          { unitId: unit.id, target: to },
        );
      }
      exactSet.add(to);

      // Collision key: NFC + case-fold (shared helper)
      const key = publicPathCollisionKey(to);
      if (collisionKeyMap.has(key)) {
        const existing = collisionKeyMap.get(key);
        if (existing !== to) {
          // Determine collision kind
          const nfc = to.normalize('NFC');
          const existingNfc = existing.normalize('NFC');
          const isNfc = nfc === existingNfc;
          const isCase = nfc.toLowerCase() === existingNfc.toLowerCase();
          let kind = 'case+NFC';
          if (isNfc && !isCase) kind = 'NFC';
          else if (!isNfc && isCase) kind = 'case-fold';

          throw new ReleaseError(
            CONFIG_INVALID,
            `unit "${unit.id}" has ${kind} collision in publicFiles[].to: "${to}" and "${existing}"`,
            { unitId: unit.id, target: to, existing },
          );
        }
      }
      collisionKeyMap.set(key, to);
    }

    // 2. Validate requiredPublicFiles coverage: every required file must
    //    be exactly covered by some publicFiles[].to.
    const required = unit.requiredPublicFiles ?? [];
    const toSet = new Set(toTargets.map((m) => m.to));
    const uncovered = required.filter((r) => !toSet.has(r));
    if (uncovered.length > 0) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `unit "${unit.id}" requiredPublicFiles not covered by publicFiles[].to: ${uncovered.join(', ')}`,
        { unitId: unit.id, uncovered },
      );
    }
  }

  // Verification gates are deliberately cross-referenced here instead of
  // inferred at execution time. A gate must name one existing unit and, for
  // consumer verification, one distribution that the unit actually ships.
  const unitsById = new Map(config.releaseUnits.map((unit) => [unit.id, unit]));
  const gateIds = new Set();
  for (const gate of config.verificationGates ?? []) {
    if (gateIds.has(gate.id)) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `duplicate verification gate id: "${gate.id}"`,
        { gateId: gate.id },
      );
    }
    gateIds.add(gate.id);
    const unit = unitsById.get(gate.scope.unit);
    if (!unit) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `verification gate "${gate.id}" references unknown unit "${gate.scope.unit}"`,
        { gateId: gate.id, unitId: gate.scope.unit },
      );
    }
    if (
      gate.phase === 'consumer-verify' &&
      !(unit.distributions ?? []).some((distribution) => distribution.type === gate.scope.distribution)
    ) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `verification gate "${gate.id}" references undeclared distribution "${gate.scope.distribution}"`,
        { gateId: gate.id, unitId: gate.scope.unit, distribution: gate.scope.distribution },
      );
    }
  }

  // --- Compute deterministic digest ---
  const configDigest = sha256Hex(canonicalJson(config));

  return {
    config,
    configPath: absConfigPath,
    configDigest,
  };
}
