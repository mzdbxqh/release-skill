/**
 * Producer DAG for artifact generation.
 *
 * Builds a directed acyclic graph from the artifact policy's generated
 * artifacts and their sourceArtifacts dependencies. Provides topological
 * ordering and downstream closure queries.
 *
 * @module artifacts/graph
 */

import { ReleaseError, ARTIFACT_POLICY_INVALID } from '../core/errors.mjs';

/**
 * Build a producer graph from the artifact policy.
 *
 * Validates that:
 * - All generated artifacts have known producers (if a registry is provided)
 * - All sourceArtifacts references point to existing artifacts
 * - The dependency graph has no cycles
 *
 * @param {object} policy - Validated artifact policy.
 * @param {object} [registry] - Optional producer registry for validation.
 * @returns {{ topologicalOrder: string[], downstreamClosure: (id: string) => string[] }}
 * @throws {ReleaseError} ARTIFACT_POLICY_INVALID on cycle or unknown reference.
 */
export function buildProducerGraph(policy, registry) {
  const allArtifacts = new Map();
  for (const a of policy.artifacts) allArtifacts.set(a.id, a);

  const errors = [];

  // Validate generated artifacts
  for (const a of policy.artifacts) {
    if (a.type !== 'generated') continue;

    if (registry && !registry.get(a.producer)) {
      errors.push(`artifact "${a.id}": unknown producer "${a.producer}"`);
    }

    for (const src of (a.sourceArtifacts ?? [])) {
      if (!allArtifacts.has(src)) {
        errors.push(`artifact "${a.id}": unknown sourceArtifact "${src}"`);
      }
    }
  }

  if (errors.length > 0) {
    throw new ReleaseError(
      ARTIFACT_POLICY_INVALID,
      `producer graph validation failed: ${errors.join('; ')}`,
      { errors },
    );
  }

  // Build edges: generated artifact → its sourceArtifacts
  const edges = new Map();
  for (const a of policy.artifacts) {
    if (a.type !== 'generated') continue;
    edges.set(a.id, [...(a.sourceArtifacts ?? [])]);
  }

  const topologicalOrder = topologicalSort(edges);

  // Build artifact ID → producer name mapping
  const producerMap = new Map();
  for (const a of policy.artifacts) {
    if (a.type === 'generated' && a.producer) {
      producerMap.set(a.id, a.producer);
    }
  }

  // Cycle detection is implicit in topologicalSort
  return Object.freeze({
    topologicalOrder: Object.freeze(topologicalOrder),
    downstreamClosure(id) {
      return Object.freeze(downstreamOf(id, edges));
    },
    /**
     * Get the producer name for an artifact ID.
     * @param {string} id - Artifact ID.
     * @returns {string|undefined} Producer name.
     */
    producerOf(id) {
      return producerMap.get(id);
    },
    /**
     * Get the direct upstream artifact IDs (sourceArtifacts) for a generated artifact.
     * @param {string} id - Artifact ID.
     * @returns {string[]} Direct upstream artifact IDs.
     */
    upstreamOf(id) {
      return edges.get(id) ?? [];
    },
  });
}

/**
 * Topological sort of generated artifacts using Kahn's algorithm.
 *
 * @param {Map<string, string[]>} edges - Dependency map (artifact → sourceArtifacts).
 * @returns {string[]} Topologically sorted artifact IDs.
 * @throws {ReleaseError} ARTIFACT_POLICY_INVALID if a cycle is detected.
 */
function topologicalSort(edges) {
  // Build adjacency and in-degree for generated artifacts only
  const nodes = new Set(edges.keys());
  const inDegree = new Map();
  const adj = new Map();

  for (const id of nodes) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }

  for (const [id, deps] of edges) {
    for (const dep of deps) {
      if (nodes.has(dep)) {
        adj.get(dep).push(id);
        inDegree.set(id, inDegree.get(id) + 1);
      }
    }
  }

  // Kahn's algorithm
  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  queue.sort();

  const order = [];
  while (queue.length > 0) {
    const node = queue.shift();
    order.push(node);
    for (const neighbor of adj.get(node)) {
      const newDeg = inDegree.get(neighbor) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) {
        queue.push(neighbor);
        queue.sort();
      }
    }
  }

  if (order.length !== nodes.size) {
    const inCycle = [...nodes].filter((id) => !order.includes(id));
    throw new ReleaseError(
      ARTIFACT_POLICY_INVALID,
      `dependency cycle detected among: ${inCycle.join(', ')}`,
      { cycle: inCycle },
    );
  }

  return order;
}

/**
 * Compute the downstream closure of an artifact (all transitive dependents).
 *
 * @param {string} id - Artifact ID.
 * @param {Map<string, string[]>} edges - Dependency map.
 * @returns {string[]} All downstream artifact IDs (not including `id` itself).
 */
function downstreamOf(id, edges) {
  // Build reverse adjacency: source → [consumers]
  const reverseAdj = new Map();
  for (const [artifact, deps] of edges) {
    for (const dep of deps) {
      if (!reverseAdj.has(dep)) reverseAdj.set(dep, []);
      reverseAdj.get(dep).push(artifact);
    }
  }

  const visited = new Set();
  const result = [];

  function dfs(node) {
    for (const consumer of (reverseAdj.get(node) ?? [])) {
      if (!visited.has(consumer)) {
        visited.add(consumer);
        result.push(consumer);
        dfs(consumer);
      }
    }
  }

  dfs(id);
  return result;
}
