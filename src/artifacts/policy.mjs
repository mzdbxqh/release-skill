/**
 * Artifact policy loader and validator.
 *
 * Provides:
 * - `validateArtifactPolicy(policy)` — schema validation
 * - `loadArtifactPolicy({ root, policyPath, previousLock })` — safe YAML
 *   parse, schema validation, digest computation, and protection comparison
 *
 * @module artifacts/policy
 */

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import Ajv from 'ajv';
import {
  ReleaseError,
  ARTIFACT_POLICY_INVALID,
  PATH_UNSAFE,
} from '../core/errors.mjs';
import { canonicalArtifactPath } from './path-key.mjs';

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const POLICY_SCHEMA_PATH = new URL(
  '../../schemas/artifact-policy.schema.json',
  import.meta.url,
);

const ajv = new Ajv({ allErrors: true, strict: false });

// Compile schema once at module load (synchronous).
const _validate = ajv.compile(JSON.parse(readFileSync(POLICY_SCHEMA_PATH, 'utf8')));

/**
 * Validate a policy object against the artifact-policy JSON Schema.
 *
 * @param {object} policy - Parsed policy object.
 * @returns {{ valid: boolean, errors?: object[], summary?: string, graphInput?: object[] }}
 */
export function validateArtifactPolicy(policy) {
  const ok = _validate(policy);
  if (!ok) {
    return {
      valid: false,
      errors: _validate.errors.map((e) => ({
        instancePath: e.instancePath,
        message: e.message,
        params: e.params,
      })),
      summary: _validate.errors
        .map((e) => `${e.instancePath || '/'} ${e.message}`)
        .join('; '),
    };
  }

  // Runtime conditional: generated artifacts require producer, sourceArtifacts, adoptionRoutes
  const runtimeErrors = [];
  const artifactIds = new Set((policy.artifacts ?? []).map((artifact) => artifact.id));
  for (const [i, artifact] of (policy.artifacts ?? []).entries()) {
    if (artifact.type === 'generated') {
      if (!artifact.producer) {
        runtimeErrors.push({
          instancePath: `/artifacts/${i}`,
          message: 'generated artifact requires "producer"',
          params: { missingProperty: 'producer' },
        });
      }
      if (!Array.isArray(artifact.sourceArtifacts) || artifact.sourceArtifacts.length === 0) {
        runtimeErrors.push({
          instancePath: `/artifacts/${i}`,
          message: 'generated artifact requires non-empty "sourceArtifacts"',
          params: { missingProperty: 'sourceArtifacts' },
        });
      }
      if (!Array.isArray(artifact.adoptionRoutes) || artifact.adoptionRoutes.length === 0) {
        runtimeErrors.push({
          instancePath: `/artifacts/${i}`,
          message: 'generated artifact requires non-empty "adoptionRoutes"',
          params: { missingProperty: 'adoptionRoutes' },
        });
      } else {
        // Validate each route is an object with required fields
        for (const [ri, route] of artifact.adoptionRoutes.entries()) {
          if (typeof route === 'string') {
            runtimeErrors.push({
              instancePath: `/artifacts/${i}/adoptionRoutes/${ri}`,
              message: `adoptionRoutes must be objects {target, sourceArtifact, mode}, got string "${route}"`,
            });
          } else if (!route.target || !route.sourceArtifact || !route.mode) {
            runtimeErrors.push({
              instancePath: `/artifacts/${i}/adoptionRoutes/${ri}`,
              message: 'adoptionRoute must have {target, sourceArtifact, mode}',
            });
          } else if (!artifactIds.has(route.sourceArtifact) ||
                     !artifact.sourceArtifacts?.includes(route.sourceArtifact)) {
            runtimeErrors.push({
              instancePath: `/artifacts/${i}/adoptionRoutes/${ri}/sourceArtifact`,
              message: 'adoptionRoute sourceArtifact must be a registered direct sourceArtifact',
            });
          }
        }
      }
    }
  }

  if (runtimeErrors.length > 0) {
    return {
      valid: false,
      errors: runtimeErrors,
      summary: runtimeErrors.map((e) => `${e.instancePath} ${e.message}`).join('; '),
    };
  }

  // Extract graphInput: generated artifacts
  const graphInput = (policy.artifacts ?? []).filter((a) => a.type === 'generated');
  return { valid: true, graphInput, policyPath: null };
}

// ---------------------------------------------------------------------------
// Safe YAML parsing (rejects aliases, merge keys, duplicate keys)
// ---------------------------------------------------------------------------

/**
 * Recursively walk a YAML AST node and return true if any Alias node is found.
 *
 * @param {import('yaml').Node | null | undefined} node
 * @returns {boolean}
 */
function containsAlias(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.constructor?.name === 'Alias') return true;
  if (node.items) {
    for (const item of node.items) {
      if (containsAlias(item)) return true;
      if (item.value && containsAlias(item.value)) return true;
    }
  }
  if (node.value && containsAlias(node.value)) return true;
  return false;
}

/**
 * Parse a YAML file safely within a root directory.
 *
 * Rejects YAML aliases (including merge keys), duplicate keys, and
 * paths that escape root.
 *
 * @param {string} root - Repository root (absolute).
 * @param {string} policyPath - Relative path to policy YAML.
 * @returns {Promise<object>} Parsed policy object.
 * @throws {ReleaseError} PATH_UNSAFE if path escapes root.
 * @throws {ReleaseError} ARTIFACT_POLICY_INVALID on YAML errors.
 */
async function parseSafeYamlWithinRoot(root, policyPath) {
  // Validate path doesn't escape root using canonicalArtifactPath.
  // The policyPath is a relative POSIX path; validate its segments.
  try {
    canonicalArtifactPath(policyPath);
  } catch (err) {
    if (err.code === PATH_UNSAFE) {
      throw new ReleaseError(
        ARTIFACT_POLICY_INVALID,
        `invalid policy path: ${err.message}`,
        { policyPath, root },
      );
    }
    throw err;
  }

  const fullPath = join(root, policyPath);

  let content;
  try {
    content = await readFile(fullPath, 'utf8');
  } catch (err) {
    throw new ReleaseError(
      ARTIFACT_POLICY_INVALID,
      `cannot read policy file: ${err.message}`,
      { policyPath, fullPath, cause: err.code },
    );
  }

  // Parse with AST access for alias detection
  let doc;
  try {
    doc = YAML.parseDocument(content);
  } catch (err) {
    throw new ReleaseError(
      ARTIFACT_POLICY_INVALID,
      `YAML parse error: ${err.message}`,
      { policyPath },
    );
  }

  // Reject YAML aliases (including merge keys)
  if (containsAlias(doc.contents)) {
    throw new ReleaseError(
      ARTIFACT_POLICY_INVALID,
      'YAML aliases are not allowed',
      { policyPath },
    );
  }

  // Reject duplicate keys
  const errors = doc.errors ?? [];
  const warnings = doc.warnings ?? [];
  const allIssues = [...errors, ...warnings];
  for (const issue of allIssues) {
    if (issue.code === 'YAML_MAP_KEY' || /duplicate key/i.test(issue.message ?? '')) {
      throw new ReleaseError(
        ARTIFACT_POLICY_INVALID,
        `duplicate YAML key: ${issue.message}`,
        { policyPath, line: issue.linePos },
      );
    }
  }

  // Convert to plain object
  const policy = doc.toJSON();
  if (!policy || typeof policy !== 'object') {
    throw new ReleaseError(
      ARTIFACT_POLICY_INVALID,
      'policy YAML must be an object',
      { policyPath },
    );
  }

  return policy;
}

// ---------------------------------------------------------------------------
// Digest helpers
// ---------------------------------------------------------------------------

/**
 * Canonical JSON for stable hashing (sorted keys).
 */
function canonicalJson(obj) {
  return JSON.stringify(obj, Object.keys(obj ?? {}).sort());
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Protection comparison
// ---------------------------------------------------------------------------

/**
 * Compare previous lock's artifact inventory against current policy.
 *
 * Returns `UNCHANGED` if no artifacts were removed, or
 * `POLICY_CHANGE_PENDING` if the prior inventory shrank.
 *
 * @param {object | undefined} previousLock - Previous artifact-lock object.
 * @param {object} policy - Current validated policy.
 * @returns {{ status: string, removedArtifactIds?: string[] }}
 */
function compareProtection(previousLock, policy) {
  if (!previousLock || !Array.isArray(previousLock.artifactIds)) {
    return { status: 'UNCHANGED' };
  }

  const currentIds = new Set((policy.artifacts ?? []).map((a) => a.id));
  const removed = previousLock.artifactIds.filter((id) => !currentIds.has(id));

  if (removed.length > 0) {
    return { status: 'POLICY_CHANGE_PENDING', removedArtifactIds: removed };
  }

  return { status: 'UNCHANGED' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate an artifact policy from YAML.
 *
 * @param {object} options
 * @param {string} options.root - Repository root (absolute).
 * @param {string} [options.policyPath='.release-skill/artifact-policy.yaml'] - Relative policy path.
 * @param {object} [options.previousLock] - Previous artifact-lock for protection comparison.
 * @returns {Promise<{ policy: object, policyPath: string, policyDigest: string, graphInput: object[], protectionChange: object }>}
 * @throws {ReleaseError} ARTIFACT_POLICY_INVALID on validation failure.
 */
export async function loadArtifactPolicy({
  root,
  policyPath = '.release-skill/artifact-policy.yaml',
  previousLock,
} = {}) {
  const policy = await parseSafeYamlWithinRoot(root, policyPath);

  const result = validateArtifactPolicy(policy);
  if (!result.valid) {
    throw new ReleaseError(
      ARTIFACT_POLICY_INVALID,
      result.summary ?? 'artifact policy validation failed',
      { errors: result.errors },
    );
  }

  return Object.freeze({
    policy: Object.freeze(policy),
    policyPath,
    policyDigest: `sha256:${sha256Hex(canonicalJson(policy))}`,
    graphInput: Object.freeze(result.graphInput ?? []),
    protectionChange: compareProtection(previousLock, policy),
  });
}
