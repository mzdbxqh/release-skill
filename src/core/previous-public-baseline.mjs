import { ReleaseError, GATE_FAILED } from './errors.mjs';

/**
 * Observe whether the previous public baseline is still consistent with the
 * expected state recorded in the release plan.
 *
 * This gate runs early in the release lifecycle to ensure that the upstream
 * public artifact has not drifted since the plan was prepared.
 *
 * @param {object} opts
 * @param {{ mode: 'none' } | { mode: 'bound', repo: string, ref: string, commit: string, tree?: string, manifestDigest?: string }} opts.baseline
 *   The previous-public-baseline specification from the release plan.
 * @param {(repo: string, ref: string, commit: string) => Promise<{ status: 'consistent' | 'drifted' | 'unknown', actual?: string, diff?: string, error?: string }>} opts.observeFn
 *   Async function that queries the actual remote state.
 * @param {{ append: (record: Record<string, unknown>) => void }} opts.evidence
 *   Evidence collector for audit trail.
 * @returns {Promise<{ consistent: true, observed?: Record<string, unknown> }>}
 * @throws {ReleaseError} When the baseline has drifted or the mode is invalid.
 */
export async function observePreviousPublicBaseline({ baseline, observeFn, evidence }) {
  if (!baseline || typeof baseline !== 'object') {
    throw new ReleaseError(
      GATE_FAILED,
      'previousPublicBaseline.mode must be "none" or "bound"',
    );
  }

  const { mode } = baseline;

  if (mode === 'none') {
    evidence?.append({
      phase: 'previous-public-baseline',
      status: 'skipped',
      reason: 'fresh repository',
    });
    return { consistent: true };
  }

  if (mode === 'bound') {
    const { githubHost, repo, ref, commit } = baseline;
    const result = await observeFn(repo, ref, commit, { githubHost });

    if (result.status === 'consistent') {
      evidence?.append({
        phase: 'previous-public-baseline',
        status: 'consistent',
        repo,
        ref,
        commit,
      });
      return { consistent: true, observed: { ...result } };
    }

    if (result.status === 'drifted') {
      throw new ReleaseError(
        GATE_FAILED,
        `previous public baseline drifted: expected commit ${commit} got ${result.actual ?? 'unknown'}`,
        { expected: commit, actual: result.actual, diff: result.diff },
      );
    }

    // 'unknown' or any other unexpected status
    throw new ReleaseError(
      GATE_FAILED,
      `previous public baseline unknown: ${result.error ?? 'unrecognised status'}`,
      { error: result.error, status: result.status },
    );
  }

  // Invalid or missing mode
  throw new ReleaseError(
    GATE_FAILED,
    'previousPublicBaseline.mode must be "none" or "bound"',
  );
}

/**
 * Re-observe the previous public baseline during reconcile. Unlike the
 * primary observe, this returns a soft result instead of throwing so the
 * caller can decide how to surface the inconsistency.
 *
 * @param {object} opts
 * @param {{ mode: string, repo?: string, ref?: string, commit?: string } | undefined | null} opts.baseline
 *   The per-unit previous-public-baseline from the frozen plan.
 * @param {(repo: string, ref: string, commit: string) => Promise<{ status: 'consistent' | 'drifted' | 'unknown', actual?: string, diff?: string, error?: string }>} opts.observeFn
 *   Async function that queries the actual remote state.
 * @param {{ append: (record: Record<string, unknown>) => void }} opts.evidence
 *   Evidence collector for audit trail.
 * @returns {Promise<{ consistent: true } | { consistent: false, error: string, detail?: Record<string, unknown> }>}
 */
export async function reObservePreviousPublicBaseline({ baseline, observeFn, evidence }) {
  if (!baseline || typeof baseline !== 'object') {
    return { consistent: true };
  }

  const { mode } = baseline;

  if (mode === 'none') {
    return { consistent: true };
  }

  if (mode === 'bound') {
    const { githubHost, repo, ref, commit } = baseline;
    const result = await observeFn(repo, ref, commit, { githubHost });

    if (result.status === 'consistent') {
      evidence?.append({
        phase: 're-observe-previous-public-baseline',
        status: 'consistent',
        repo,
        ref,
        commit,
      });
      return { consistent: true };
    }

    // Drifted or unknown -- return soft failure for reconcile to handle
    return {
      consistent: false,
      error: 'previous public baseline changed since plan freeze',
      detail: {
        expected: commit,
        actual: result.actual,
        diff: result.diff,
        error: result.error,
        status: result.status,
      },
    };
  }

  // Unknown mode -- treat as soft failure during reconcile
  return {
    consistent: false,
    error: 'previous public baseline changed since plan freeze',
    detail: { reason: `unrecognised mode: ${mode}` },
  };
}

/**
 * Validate the shape of a previous-public-baseline configuration object
 * without executing any observation.
 *
 * @param {unknown} baseline - The baseline configuration to validate.
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
export function validatePreviousPublicBaselineConfig(baseline) {
  const errors = [];

  if (baseline == null || typeof baseline !== 'object') {
    return { valid: false, errors: ['baseline must be a non-null object'] };
  }

  if (baseline.mode !== 'none' && baseline.mode !== 'bound') {
    errors.push('mode must be "none" or "bound"');
  }

  if (baseline.mode === 'none') {
    const forbidden = ['githubHost', 'repo', 'ref', 'commit', 'tree', 'manifestDigest'];
    for (const field of forbidden) {
      if (baseline[field] !== undefined) {
        errors.push(`mode "none" must not include "${field}"`);
      }
    }
  }

  if (baseline.mode === 'bound') {
    if (baseline.githubHost !== undefined && (typeof baseline.githubHost !== 'string' || baseline.githubHost.length === 0)) {
      errors.push('"githubHost" must be a non-empty string when provided');
    }
    if (typeof baseline.repo !== 'string' || baseline.repo.length === 0) {
      errors.push('bound mode requires a non-empty string "repo"');
    }
    if (typeof baseline.ref !== 'string' || baseline.ref.length === 0) {
      errors.push('bound mode requires a non-empty string "ref"');
    }
    if (typeof baseline.commit !== 'string' || baseline.commit.length === 0) {
      errors.push('bound mode requires a non-empty string "commit"');
    }
    if (baseline.tree !== undefined && typeof baseline.tree !== 'string') {
      errors.push('"tree" must be a string when provided');
    }
    if (baseline.manifestDigest !== undefined && typeof baseline.manifestDigest !== 'string') {
      errors.push('"manifestDigest" must be a string when provided');
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true };
}

export function assertPreviousPublicBaselineTarget({ baseline, githubHost, publicRepo, requireHost = false }) {
  if (!baseline || baseline.mode !== 'bound') return;
  if (baseline.repo !== publicRepo) {
    throw new ReleaseError(GATE_FAILED, 'previous public baseline repo does not match the production repository');
  }
  if (requireHost && !baseline.githubHost) {
    throw new ReleaseError(GATE_FAILED, 'production previous public baseline must freeze githubHost');
  }
  if (baseline.githubHost && baseline.githubHost !== githubHost) {
    throw new ReleaseError(GATE_FAILED, 'previous public baseline host does not match the production GitHub host');
  }
}
