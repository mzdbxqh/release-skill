/**
 * Artifact state algebra: four-dimensional classification of artifact entries.
 *
 * Classifies an artifact by comparing its base (accepted), current (working
 * tree or commit), and generated (producer output) entries across four
 * dimensions: existence, type, mode, and content.
 *
 * @module artifacts/state
 */

import { ReleaseError, PATH_UNSAFE, STRUCTURE_INVALID } from '../core/errors.mjs';

// ---------------------------------------------------------------------------
// Status priority (lower index = higher priority = shown first)
// ---------------------------------------------------------------------------

const PRIORITY = Object.freeze([
  'BASE_UNAVAILABLE',
  'POLICY_INVALID',
  'POLICY_CHANGE_PENDING',
  'ISOLATION_UNAVAILABLE',
  'PATH_UNSAFE',
  'PRODUCER_SCOPE_VIOLATION',
  'PRODUCER_NONDETERMINISTIC',
  'STRUCTURE_INVALID',
  'CONFLICT',
  'ADOPTION_REQUIRED',
  'MERGEABLE',
  'GENERATOR_CHANGED',
  'HUMAN_CHANGED',
  'NEW',
  'CLEAN',
]);

const PRIORITY_MAP = new Map(PRIORITY.map((s, i) => [s, i]));

/**
 * Get the numeric priority index for a status (lower = higher priority).
 *
 * @param {string} status
 * @returns {number}
 */
export function statusPriority(status) {
  return PRIORITY_MAP.get(status) ?? PRIORITY.length;
}

// ---------------------------------------------------------------------------
// Entry equality
// ---------------------------------------------------------------------------

/**
 * Check if two artifact entries are equal across all four dimensions:
 * existence, type, mode, and content.
 *
 * Absent entries are compared by identity (both absent = equal).
 * Regular entries are compared by type, mode, path, and sha256.
 * Tree entries are compared by manifestDigest.
 *
 * @param {object|null} a
 * @param {object|null} b
 * @returns {boolean}
 */
function entriesEqual(a, b) {
  // Both absent
  if (!a && !b) return true;
  // One absent, one present
  if (!a || !b) return false;
  // Both present
  if (a.type !== b.type) return false;
  if (a.mode !== b.mode) return false;
  if (a.path !== b.path) return false;
  // Tree comparison: use manifestDigest for full tree equality
  if (a.type === 'tree' && b.type === 'tree') {
    return a.manifestDigest === b.manifestDigest;
  }
  if (a.sha256 !== b.sha256) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Entry validation
// ---------------------------------------------------------------------------

/**
 * Validate that an entry does not use a dangerous filesystem type
 * (symlink, hardlink, special file).
 *
 * @param {object|null} entry
 * @param {string} label - Label for error messages (e.g. 'current', 'generated').
 * @throws {ReleaseError} PATH_UNSAFE on dangerous types.
 */
function validateEntry(entry, label) {
  if (!entry || entry.kind === 'absent') return;
  if (entry.kind === 'symlink' || entry.kind === 'special') {
    throw new ReleaseError(
      PATH_UNSAFE,
      `dangerous entry type "${entry.kind}" in ${label}`,
      { path: entry.path, label },
    );
  }
  // Reject symlink mode
  if (entry.mode === '120000') {
    throw new ReleaseError(
      PATH_UNSAFE,
      `symlink mode 120000 rejected in ${label}`,
      { path: entry.path, label },
    );
  }
}

// ---------------------------------------------------------------------------
// Conflict analysis
// ---------------------------------------------------------------------------

/**
 * Analyze differences between two entries relative to a base entry.
 *
 * @param {object|null} base - Base entry (may be null if absent).
 * @param {object} compare - The entry being analyzed.
 * @param {string} label - Label for the change list.
 * @returns {string[]} Array of human-readable change descriptions.
 */
function diffAgainstBase(base, compare, label) {
  const changes = [];

  if (!base) {
    changes.push(`${label}: new ${compare.kind ?? compare.type} "${compare.path ?? '(unknown)'}"`);
    return changes;
  }

  if (!compare) {
    changes.push(`${label}: removed "${base.path ?? '(unknown)'}"`);
    return changes;
  }

  if (base.type !== compare.type) {
    changes.push(`${label}: type ${base.type} → ${compare.type}`);
  }
  if (base.mode !== compare.mode) {
    changes.push(`${label}: mode ${base.mode} → ${compare.mode}`);
  }
  if (base.sha256 !== compare.sha256) {
    changes.push(`${label}: content changed`);
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Allowed actions
// ---------------------------------------------------------------------------

/**
 * Compute allowed actions for an artifact decision.
 *
 * @param {string} status - Decision status.
 * @param {object|null} current - Current entry.
 * @param {string} ownership - 'human' | 'generator' | 'system'.
 * @returns {string[]}
 */
function computeAllowedActions(status, current, ownership) {
  switch (status) {
    case 'CLEAN':
      return ['skip', 'inspect'];

    case 'NEW':
      return ownership === 'generator' ? ['adopt', 'inspect'] : ['skip', 'inspect'];

    case 'GENERATOR_CHANGED':
      return ['accept', 'inspect'];

    case 'HUMAN_CHANGED':
      return ['skip', 'inspect'];

    case 'MERGEABLE':
      return ['merge', 'accept', 'skip', 'inspect'];

    case 'ADOPTION_REQUIRED':
      return ['adopt', 'skip'];

    case 'CONFLICT':
      return ['merge', 'skip'];

    default:
      return ['skip', 'inspect'];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify an artifact by comparing base, current, and generated entries.
 *
 * The four dimensions of comparison are:
 * 1. **Existence** — absent vs present
 * 2. **Type** — blob vs tree
 * 3. **Mode** — 100644 vs 100755
 * 4. **Content** — sha256 digest (or manifestDigest for trees)
 *
 * When `producerRelation` is provided, the producer's implementation and
 * input drift are factored into the classification:
 * - `implementationChanged: true` → at least GENERATOR_CHANGED
 * - `inputChanged: true` → at least GENERATOR_CHANGED
 *
 * For generator-owned areas (`ownership='generator'` with `projection='write'`),
 * any human delta not reproduced by the exact generated projection requires
 * ADOPTION_REQUIRED (Design §10.1).
 *
 * @param {object} options
 * @param {object|null} options.base - Base (accepted) entry, or `{ kind: 'absent' }`.
 * @param {object|null} options.current - Current (worktree) entry, or `{ kind: 'absent' }`.
 * @param {object|null} options.generated - Generated (producer) entry, or `{ kind: 'absent' }`.
 * @param {'human'|'generator'|'system'} [options.ownership='human'] - Path ownership.
 * @param {'read'|'write'} [options.projection='read'] - Projection scope.
 * @param {object} [options.producerRelation] - Producer drift flags.
 * @param {boolean} [options.producerRelation.implementationChanged=false]
 * @param {boolean} [options.producerRelation.inputChanged=false]
 * @param {Array<object>} [options.projections] - Required for mixed ownership.
 * @returns {{ status: string, priority: number, safeToWrite: boolean, allowedActions: string[], humanChanges?: string[], generatorChanges?: string[] }}
 */
export function classifyArtifact({
  base,
  current,
  generated,
  ownership = 'human',
  projection = 'read',
  producerRelation,
  projections,
} = {}) {
  if (ownership === 'mixed') {
    if (!Array.isArray(projections) || projections.length === 0) {
      throw new ReleaseError(
        STRUCTURE_INVALID,
        'mixed artifact requires non-empty projections',
        { field: 'projections' },
      );
    }

    const ids = new Set();
    const decisions = [];
    for (const item of projections) {
      if (!item || typeof item.id !== 'string' || item.id.length === 0 || ids.has(item.id)) {
        throw new ReleaseError(
          STRUCTURE_INVALID,
          'mixed projection ids must be non-empty and unique',
          { field: 'projections.id', projectionId: item?.id },
        );
      }
      if (item.ownership !== 'human' && item.ownership !== 'generator') {
        throw new ReleaseError(
          STRUCTURE_INVALID,
          'mixed projection ownership must be human or generator',
          { field: 'projections.ownership', projectionId: item.id },
        );
      }
      ids.add(item.id);
      decisions.push(Object.freeze({
        id: item.id,
        decision: classifyArtifact({
          base: item.base,
          current: item.current,
          generated: item.generated,
          ownership: item.ownership,
          projection: item.ownership === 'generator' ? 'write' : 'read',
          producerRelation: item.producerRelation,
        }),
      }));
    }

    const winner = decisions.reduce((best, item) =>
      item.decision.priority < best.decision.priority ? item : best);
    const actionSets = decisions.map((item) => new Set(item.decision.allowedActions));
    const allowedActions = [...actionSets[0]].filter((action) =>
      actionSets.every((set) => set.has(action)));
    if (!allowedActions.includes('inspect')) allowedActions.push('inspect');

    return Object.freeze({
      status: winner.decision.status,
      priority: winner.decision.priority,
      safeToWrite: decisions.every((item) => item.decision.safeToWrite),
      allowedActions: Object.freeze(allowedActions),
      projectionDecisions: Object.freeze(decisions),
    });
  }

  // Validate entries for dangerous types
  validateEntry(current, 'current');
  validateEntry(generated, 'generated');

  // Normalize: extract "has content" from kind
  const hasBase = base && base.kind !== 'absent';
  const hasCurrent = current && current.kind !== 'absent';
  const hasGenerated = generated && generated.kind !== 'absent';

  // Extract actual entries for comparison (null when absent)
  const baseEntry = hasBase ? base : null;
  const currentEntry = hasCurrent ? current : null;
  const generatedEntry = hasGenerated ? generated : null;

  // Compare across dimensions
  const baseEqCurrent = entriesEqual(baseEntry, currentEntry);
  const baseEqGenerated = entriesEqual(baseEntry, generatedEntry);

  /** Helper: apply ADOPTION_REQUIRED when generator owns the area and human changed */
  function applyAdoptionCheck(status, decision) {
    // ADOPTION_REQUIRED when generator owns the area (projection=write) and
    // the human side has a delta that the generated projection does not reproduce.
    if (projection === 'write' && ownership === 'generator') {
      // Any human delta in a generator-owned area requires adoption
      if (!baseEqCurrent) {
        return makeDecision({ status: 'ADOPTION_REQUIRED', current, generated, ownership });
      }
      // No base but current was added by human
      if (!hasBase && hasCurrent) {
        return makeDecision({ status: 'ADOPTION_REQUIRED', current, generated, ownership });
      }
    }
    return decision;
  }

  // --- Base absent (no prior accepted state) ---
  if (!hasBase) {
    if (!hasCurrent && !hasGenerated) {
      // All absent
      if (ownership === 'generator') {
        return applyAdoptionCheck('NEW', makeDecision({ status: 'NEW', current, generated, ownership }));
      }
      return makeDecision({ status: 'CLEAN', current, generated, ownership });
    }

    if (hasCurrent && !hasGenerated) {
      // Design 10.1: absent/present/absent → HUMAN_CHANGED for human area,
      // but ADOPTION_REQUIRED for generator-owned area
      if (projection === 'write' && ownership === 'generator') {
        return makeDecision({ status: 'ADOPTION_REQUIRED', current, generated, ownership });
      }
      return makeDecision({ status: 'HUMAN_CHANGED', current, generated, ownership });
    }

    if (!hasCurrent && hasGenerated) {
      // New file from generator — projection=write requires explicit adoption
      if (ownership === 'human' && projection === 'write') {
        return makeDecision({ status: 'ADOPTION_REQUIRED', current, generated, ownership });
      }
      return makeDecision({ status: 'GENERATOR_CHANGED', current, generated, ownership });
    }

    if (!entriesEqual(currentEntry, generatedEntry)) {
      // Both exist but differ — generator owns it if it's the source
      if (ownership === 'generator') {
        return makeDecision({ status: 'NEW', current, generated, ownership });
      }
      return makeDecision({
        status: 'CONFLICT',
        base: baseEntry,
        current,
        generated,
        ownership,
      });
    }

    // Both exist and are identical → mergeable
    return makeDecision({ status: 'MERGEABLE', current, generated, ownership });
  }

  // --- Base exists ---
  // Both current and generated agree the entry was removed (or both absent)
  if (!hasCurrent && !hasGenerated) {
    if (ownership === 'human') {
      return makeDecision({ status: 'CLEAN', current, generated, ownership });
    }
    return makeDecision({ status: 'MERGEABLE', current, generated, ownership });
  }

  if (baseEqCurrent && baseEqGenerated) {
    // Everything matches — but check producerRelation for drift
    const withDrift = applyProducerDrift('CLEAN', { current, generated, ownership, producerRelation });
    return withDrift;
  }

  if (baseEqCurrent && !baseEqGenerated) {
    // Generator changed the file while human left it alone
    return makeDecision({ status: 'GENERATOR_CHANGED', current, generated, ownership });
  }

  if (!baseEqCurrent && baseEqGenerated) {
    // Human changed the file while generator left it alone
    // In generator-owned write area → ADOPTION_REQUIRED
    if (projection === 'write' && ownership === 'generator') {
      return makeDecision({ status: 'ADOPTION_REQUIRED', current, generated, ownership });
    }
    return makeDecision({ status: 'HUMAN_CHANGED', current, generated, ownership });
  }

  // Both differ from base
  if (entriesEqual(currentEntry, generatedEntry)) {
    return makeDecision({ status: 'MERGEABLE', current, generated, ownership });
  }

  // Both differ from base AND differ from each other → conflict
  return makeDecision({
    status: 'CONFLICT',
    base: baseEntry,
    current,
    generated,
    ownership,
  });
}

// ---------------------------------------------------------------------------
// Internal: Producer drift escalation
// ---------------------------------------------------------------------------

/**
 * Apply producer relation drift to a status. If the producer implementation
 * or input changed, the status must be at least GENERATOR_CHANGED.
 *
 * @param {string} baseStatus - The status before drift check.
 * @param {object} ctx - Classification context.
 * @returns {object} Frozen ArtifactDecision.
 */
function applyProducerDrift(baseStatus, { current, generated, ownership, producerRelation }) {
  if (!producerRelation) {
    return makeDecision({ status: baseStatus, current, generated, ownership });
  }

  const implChanged = producerRelation.implementationChanged === true;
  const inputChanged = producerRelation.inputChanged === true;

  if (implChanged || inputChanged) {
    // Escalate to at least GENERATOR_CHANGED
    const baseP = PRIORITY_MAP.get(baseStatus) ?? PRIORITY.length;
    const genP = PRIORITY_MAP.get('GENERATOR_CHANGED') ?? PRIORITY.length;
    if (baseP > genP) {
      // baseStatus is lower priority than GENERATOR_CHANGED — escalate
      return makeDecision({ status: 'GENERATOR_CHANGED', current, generated, ownership });
    }
  }

  return makeDecision({ status: baseStatus, current, generated, ownership });
}

// ---------------------------------------------------------------------------
// Internal: Decision construction
// ---------------------------------------------------------------------------

/**
 * Construct a frozen ArtifactDecision object.
 *
 * @param {object} options
 * @param {string} options.status - Decision status.
 * @param {object|null} [options.base] - Base entry (for conflict analysis).
 * @param {object} options.current - Current entry.
 * @param {object} options.generated - Generated entry.
 * @param {string} options.ownership - Path ownership.
 * @returns {object} Frozen ArtifactDecision.
 */
function makeDecision({ status, base = null, current, generated, ownership }) {
  const priority = PRIORITY_MAP.get(status) ?? PRIORITY.length;
  const allowedActions = computeAllowedActions(status, current, ownership);
  const safeToWrite = !BLOCKING_STATUSES.has(status);

  const decision = {
    status,
    priority,
    safeToWrite,
    allowedActions,
  };

  // Add conflict details for CONFLICT status
  if (status === 'CONFLICT') {
    decision.humanChanges = diffAgainstBase(base, current, 'current');
    decision.generatorChanges = diffAgainstBase(base, generated, 'generated');
  }

  return Object.freeze(decision);
}

/**
 * Statuses that block writes (safeToWrite = false).
 */
const BLOCKING_STATUSES = Object.freeze(new Set([
  'BASE_UNAVAILABLE',
  'POLICY_INVALID',
  'POLICY_CHANGE_PENDING',
  'ISOLATION_UNAVAILABLE',
  'PATH_UNSAFE',
  'PRODUCER_SCOPE_VIOLATION',
  'PRODUCER_NONDETERMINISTIC',
  'STRUCTURE_INVALID',
  'CONFLICT',
  'ADOPTION_REQUIRED',
]));
