/**
 * Bootstrap adoption engine and downstream closure.
 *
 * Provides:
 * - `planAdoption({ plan, policy, artifactId, currentEntries, generatedEntries, runProducer })`
 *   — compute multi-hunk protected diff, resolve adoption routes, run producer
 *     closure, and project downstream closure.
 * - `discardBootstrapHunk({ adoptionPlan, currentEntries, artifactId, hunkDigest, expectedPlanDigest, actor, reason, action?, replacementBytes? })`
 *   — record a per-hunk discard/replace decision with actor + reason,
 *     re-read currentEntries to verify bytes, and derive a new plan digest.
 *
 * Adoption routes are exact route objects: `{target, sourceArtifact, mode}`.
 * v1 supports mode `exact-copy`. String routes are rejected.
 *
 * Protected hunks: text files produce multiple hunks from line-level diff;
 * binary files produce one whole-file hunk. Each hunk carries:
 * `{artifactId, hunkDigest, baseDigest, currentDigest, candidateDigest, range}`.
 *
 * Convergence gate: all protected hunks must be either reproduced by the
 * producer closure (with matching candidateDigest) or explicitly decided
 * (discard/replace) before the plan can transition from `ADOPTION_REQUIRED`.
 *
 * Decision binding: `{artifactId, hunkDigest, baseDigest, currentDigest,
 * candidateDigest, action, actor, reason, decisionDigest}` — deterministic,
 * no timestamp or random fields.
 *
 * @module artifacts/adoption
 */

import {
  ReleaseError,
  ADOPTION_AMBIGUOUS,
  PLAN_STALE,
  MISSING_PARAMETERS,
} from '../core/errors.mjs';
import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import { buildProducerGraph } from './graph.mjs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute an adoption plan from the init/inspect plan and current worktree state.
 *
 * @param {object} options
 * @param {object} options.plan - The init/inspect artifact plan.
 * @param {object} options.policy - Validated artifact policy.
 * @param {string} [options.artifactId] - Specific artifact to adopt.
 * @param {Map<string, object>} options.currentEntries - Current worktree entries.
 * @param {Map<string, object>} options.generatedEntries - Producer-generated entries.
 * @param {Function} [options.runProducer] - Injected producer runner for closure.
 * @returns {Promise<AdoptionPlan>} Frozen adoption plan.
 * @throws {ReleaseError} ADOPTION_AMBIGUOUS if route resolution is ambiguous.
 */
export async function planAdoption({
  plan,
  policy,
  artifactId,
  currentEntries,
  generatedEntries,
  runProducer,
} = {}) {
  validateAdoptionRoutes(policy);
  const graph = buildProducerGraph(policy);
  let closure = [];
  let targetArtifactId = null;
  let sourceArtifactId = null;
  let route = null;
  let sourceCandidate = null;

  if (artifactId) {
    const target = policy.artifacts.find((a) => a.id === artifactId);
    if (!target || target.type !== 'generated') {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        `adoption target "${artifactId}" must be a generated artifact`,
        { artifactId },
      );
    }

    const rootRoutes = (target.adoptionRoutes ?? []).filter((candidate) => candidate.target === '/');
    if (rootRoutes.length !== 1) {
      throw new ReleaseError(
        ADOPTION_AMBIGUOUS,
        `generated artifact "${artifactId}" requires exactly one adoption route for target "/"`,
        { artifactId, candidates: rootRoutes },
      );
    }
    route = rootRoutes[0];
    sourceArtifactId = route.sourceArtifact;
    const source = policy.artifacts.find((candidate) => candidate.id === sourceArtifactId);
    if (!source || !target.sourceArtifacts?.includes(sourceArtifactId)) {
      throw new ReleaseError(
        ADOPTION_AMBIGUOUS,
        `route for "${artifactId}" does not identify one registered direct source`,
        { artifactId, sourceArtifactId },
      );
    }

    const currentTarget = currentEntries?.get(artifactId);
    const currentTargetBytes = extractEntryBytes(currentTarget);
    if (!currentTargetBytes || currentTarget?.kind !== 'regular') {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        `exact-copy adoption target "${artifactId}" must be a content-bearing regular entry`,
        { artifactId },
      );
    }
    sourceCandidate = Object.freeze({
      artifactId: sourceArtifactId,
      path: source.sourcePath,
      kind: 'regular',
      type: 'blob',
      mode: currentTarget.mode ?? '100644',
      sha256: sha256Hex(currentTargetBytes),
      size: currentTargetBytes.length,
      bytes: Buffer.from(currentTargetBytes),
      content: Buffer.from(currentTargetBytes),
    });

    closure = [artifactId, ...graph.downstreamClosure(artifactId)];
    targetArtifactId = artifactId;
  }

  const protectedHunks = [];
  for (const planArtifact of plan.artifacts ?? []) {
    if (artifactId && !closure.includes(planArtifact.id)) continue;
    const current = currentEntries?.get(planArtifact.id);
    const generated = generatedEntries?.get(planArtifact.id);
    const candidate = resolveCandidate(planArtifact, generated);
    const hunks = collectProtectedHunks(planArtifact.id, current, candidate);
    protectedHunks.push(...hunks);
  }

  let closureResults = null;
  if (runProducer && artifactId) {
    const inputSnapshot = new Map();
    for (const [id, entry] of currentEntries ?? []) {
      inputSnapshot.set(id, [entry]);
    }
    for (const [id, entry] of generatedEntries ?? []) {
      if (!inputSnapshot.has(id)) {
        inputSnapshot.set(id, [entry]);
      }
    }
    const targetPlanPath = (plan.artifacts ?? []).find((item) => item.id === artifactId)?.path;
    inputSnapshot.set(artifactId, [Object.freeze({
      ...sourceCandidate,
      path: projectionRelativePath(sourceCandidate.path, targetPlanPath),
    })]);

    closureResults = await runProducer({
      artifactIds: closure,
      inputSnapshot,
      graph,
      route,
      sourceCandidate,
      targetArtifactId,
    });
  }

  const enrichedHunks = protectedHunks.map((hunk) => {
    if (!closureResults) return Object.freeze({ ...hunk, reproduced: false });
    const candidateManifest = closureResults.byArtifact?.get(hunk.artifactId);
    if (!candidateManifest) return Object.freeze({ ...hunk, reproduced: false });
    const outputs = candidateManifest.outputs ?? candidateManifest.entries ?? [];
    const producedEntry = outputs.length === 1 ? outputs[0] : null;
    if (!producedEntry) return Object.freeze({ ...hunk, reproduced: false });
    const producedBytes = producedEntry.bytes ?? producedEntry.content;
    if (!producedBytes) return Object.freeze({ ...hunk, reproduced: false });
    const currentEntry = currentEntries?.get(hunk.artifactId);
    const currentBytes = currentEntry?.bytes ?? currentEntry?.content;
    if (!currentBytes) return Object.freeze({ ...hunk, reproduced: false });
    // Whole-entry equality is stricter than matching only one shifted range and
    // proves every protected hunk converged in the same producer run.
    const reproduced = sha256Hex(producedBytes) === sha256Hex(currentBytes);
    return Object.freeze({ ...hunk, reproduced });
  });

  const closureManifests = closureResults
    ? Object.freeze(Object.fromEntries(
      [...closureResults.byArtifact.entries()].map(([id, manifest]) => [
        id,
        Object.freeze({
          artifactId: id,
          implementationDigest: manifest.implementationDigest ?? closureResults.implementationDigest ?? null,
          inputManifestDigest: manifest.inputManifestDigest ?? null,
          outputManifestDigest: manifest.outputManifestDigest ?? null,
          outputDigest: digestManifestOutputs(manifest.outputs ?? manifest.entries ?? []),
        }),
      ]),
    ))
    : undefined;

  const hasTargetClosureEvidence = Boolean(
    artifactId && closure.length > 0 && closure.every((id) => closureResults?.byArtifact?.has(id)),
  );
  const allReproduced = enrichedHunks.every((h) => h.reproduced);
  const status = artifactId
    ? (hasTargetClosureEvidence && allReproduced ? 'CONVERGED' : 'ADOPTION_REQUIRED')
    : (enrichedHunks.length === 0 ? 'CLEAN' : 'ADOPTION_REQUIRED');
  const producerImplementationDigest = closureManifests
    ? `sha256:${sha256Hex(canonicalJson(Object.fromEntries(
      Object.entries(closureManifests).map(([id, manifest]) => [id, manifest.implementationDigest]),
    )))}`
    : undefined;

  const digestInput = {
    planDigest: plan.planDigest,
    targetArtifactId,
    sourceArtifactId,
    route,
    transactionClosure: closure,
    sourceCandidate,
    closureManifests,
    artifactPaths: Object.fromEntries(
      (plan.artifacts ?? []).filter((item) => item.path).map((item) => [item.id, item.path]),
    ),
  };
  return Object.freeze({
    planDigest: deriveAdoptionDigest(digestInput, [], enrichedHunks),
    status,
    protectedHunks: Object.freeze(enrichedHunks),
    hunkDecisions: Object.freeze([]),
    transactionClosure: Object.freeze(closure),
    targetArtifactId,
    sourceArtifactId,
    route,
    sourceCandidate,
    artifactPaths: Object.freeze(Object.fromEntries(
      (plan.artifacts ?? []).filter((item) => item.path).map((item) => [item.id, item.path]),
    )),
    safeToWrite: false,
    targetUnchanged: true,
    ...(producerImplementationDigest ? { producerImplementationDigest } : {}),
    ...(closureManifests ? { closureManifests } : {}),
  });
}

/**
 * Record a discard or replace decision for a single protected hunk.
 *
 * Re-reads currentEntries to verify bytes have not changed since the plan
 * was created. If bytes changed, the operation is rejected with PLAN_STALE.
 *
 * @param {object} options
 * @param {object} options.adoptionPlan - The current adoption plan.
 * @param {Map<string, object>} options.currentEntries - Current worktree entries.
 * @param {string} options.artifactId - Artifact containing the hunk.
 * @param {string} options.hunkDigest - Digest of the hunk to decide.
 * @param {string} options.expectedPlanDigest - Expected plan digest (stale guard).
 * @param {string} options.actor - Who made this decision.
 * @param {string} options.reason - Why this decision was made.
 * @param {'discard'|'replace'} [options.action='discard'] - Decision type.
 * @param {Buffer} [options.replacementBytes] - New content for 'replace' action.
 * @returns {Promise<AdoptionPlan>} Updated adoption plan with new digest.
 * @throws {ReleaseError} PLAN_STALE if plan or hunk bytes changed.
 */
export async function discardBootstrapHunk({
  adoptionPlan,
  currentEntries,
  artifactId,
  hunkDigest,
  expectedPlanDigest,
  actor,
  reason,
  action = 'discard',
  replacementBytes,
} = {}) {
  if (!['discard', 'replace'].includes(action) || !actor?.trim() || !reason?.trim()) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'hunk decision requires discard|replace, actor, and reason',
      { action },
    );
  }
  // Stale guard: plan digest must match
  if (adoptionPlan.planDigest !== expectedPlanDigest) {
    throw new ReleaseError(
      PLAN_STALE,
      'plan has changed since this adoption plan was created',
      { expectedPlanDigest, actualPlanDigest: adoptionPlan.planDigest },
    );
  }

  // Locate the hunk by hunkDigest
  const hunk = adoptionPlan.protectedHunks.find(
    (h) => h.artifactId === artifactId && h.hunkDigest === hunkDigest,
  );

  if (!hunk) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      `protected hunk not found: artifact="${artifactId}", digest="${hunkDigest}"`,
      { artifactId, hunkDigest },
    );
  }

  // Re-read currentEntries and verify bytes at the hunk range
  const currentEntry = currentEntries?.get(artifactId);
  const currentBytes = currentEntry?.bytes ?? currentEntry?.content;
  if (!currentBytes || currentEntry?.kind !== 'regular' || !hunk.range) {
    throw new ReleaseError(
      PLAN_STALE,
      `current bytes are unavailable for hunk revalidation: artifact="${artifactId}"`,
      { artifactId, hunkDigest },
    );
  }
  const slice = currentBytes.slice(hunk.range.start, hunk.range.start + hunk.range.length);
  const sliceDigest = sha256Hex(slice);
  if (hunk.currentDigest && sliceDigest !== hunk.currentDigest) {
    throw new ReleaseError(
      PLAN_STALE,
      `current bytes changed for hunk at artifact="${artifactId}" range=${hunk.range.start}+${hunk.range.length}`,
      {
        expectedCurrentDigest: hunk.currentDigest,
        actualCurrentDigest: sliceDigest,
        artifactId,
        hunkDigest,
      },
    );
  }

  // Already decided
  const alreadyDecided = adoptionPlan.hunkDecisions.find(
    (d) => d.artifactId === artifactId && d.hunkDigest === hunkDigest,
  );
  if (alreadyDecided) {
    throw new ReleaseError(
      PLAN_STALE,
      `hunk already decided: artifact="${artifactId}", digest="${hunkDigest}"`,
      { artifactId, hunkDigest, existingDecision: alreadyDecided },
    );
  }

  // Build decision record — deterministic, no timestamp/random
  const candidateDigest = replacementBytes == null
    ? (hunk.candidateDigest ?? null)
    : sha256Hex(Buffer.from(replacementBytes));

  const decision = Object.freeze({
    artifactId,
    hunkDigest,
    baseDigest: hunk.baseDigest ?? null,
    currentDigest: hunk.currentDigest ?? null,
    candidateDigest,
    action,
    actor,
    reason,
    decisionDigest: computeDecisionDigest({
      artifactId,
      hunkDigest,
      baseDigest: hunk.baseDigest,
      currentDigest: hunk.currentDigest,
      candidateDigest,
      action,
      actor,
      reason,
    }),
  });

  // Update decisions
  const updatedDecisions = [...adoptionPlan.hunkDecisions, decision];

  // Derive new plan digest
  const newPlanDigest = deriveAdoptionDigest(
    adoptionPlan,
    updatedDecisions,
    adoptionPlan.protectedHunks,
  );

  // Determine if all hunks are now decided
  const allDecided = adoptionPlan.protectedHunks.every(
    (h) => updatedDecisions.some(
      (d) => d.artifactId === h.artifactId && d.hunkDigest === h.hunkDigest,
    ),
  );

  return Object.freeze({
    ...adoptionPlan,
    planDigest: newPlanDigest,
    hunkDecisions: Object.freeze(updatedDecisions),
    // A human decision resolves protection, but does not fabricate producer
    // convergence. Phase 3 must apply/re-produce before CONVERGED is possible.
    status: allDecided ? 'DECISIONS_COMPLETE' : 'ADOPTION_REQUIRED',
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate that all adoption routes are exact route objects, not strings.
 *
 * @param {object} policy
 * @throws {ReleaseError} ARTIFACT_POLICY_INVALID if string routes found.
 */
function validateAdoptionRoutes(policy) {
  for (const artifact of policy.artifacts) {
    if (artifact.type !== 'generated') continue;
    const routes = artifact.adoptionRoutes ?? [];
    for (const route of routes) {
      if (typeof route === 'string') {
        throw new ReleaseError(
          'ARTIFACT_POLICY_INVALID',
          `artifact "${artifact.id}": adoptionRoutes must be objects {target, sourceArtifact, mode}, got string "${route}"`,
          { artifactId: artifact.id, route },
        );
      }
      if (!route.target || !route.sourceArtifact || !route.mode) {
        throw new ReleaseError(
          'ARTIFACT_POLICY_INVALID',
          `artifact "${artifact.id}": adoptionRoute must have {target, sourceArtifact, mode}`,
          { artifactId: artifact.id, route },
        );
      }
      if (!(artifact.sourceArtifacts ?? []).includes(route.sourceArtifact)) {
        throw new ReleaseError(
          'ARTIFACT_POLICY_INVALID',
          `artifact "${artifact.id}": adoption route source must be a direct sourceArtifact`,
          { artifactId: artifact.id, route },
        );
      }
    }
  }
}

function digestManifestOutputs(outputs) {
  return `sha256:${sha256Hex(canonicalJson(outputs.map((entry) => ({
    path: entry.path ?? null,
    type: entry.type ?? entry.kind ?? null,
    mode: entry.mode ?? null,
    sha256: entry.sha256 ?? sha256Hex(entry.bytes ?? entry.content ?? Buffer.alloc(0)),
    size: entry.size ?? (entry.bytes ?? entry.content ?? Buffer.alloc(0)).length,
  }))))}`;
}

function projectionRelativePath(sourcePath, targetPath) {
  const sourceParts = String(sourcePath ?? '').split('/').filter(Boolean);
  const targetParts = String(targetPath ?? '').split('/').filter(Boolean);
  let common = 0;
  while (common < sourceParts.length && common < targetParts.length &&
         sourceParts[sourceParts.length - 1 - common] === targetParts[targetParts.length - 1 - common]) {
    common += 1;
  }
  return common > 0
    ? sourceParts.slice(sourceParts.length - common).join('/')
    : sourceParts.at(-1);
}

/**
 * Resolve the candidate content for an artifact.
 * Prefers firstCandidate from the plan, falls back to generated entry.
 */
function resolveCandidate(planArtifact, generatedEntry) {
  if (planArtifact.firstCandidate) {
    const fc = planArtifact.firstCandidate;
    const bytes = decodePlanBytes(fc);
    if (bytes) {
      return {
        kind: 'regular',
        bytes,
        content: bytes,
        sha256: fc.sha256 ?? sha256Hex(bytes),
      };
    }
  }
  return generatedEntry;
}

function decodePlanBytes(value) {
  if (Buffer.isBuffer(value.bytes)) return Buffer.from(value.bytes);
  if (typeof value.bytesBase64 === 'string') return Buffer.from(value.bytesBase64, 'base64');
  if (value.bytes?.type === 'Buffer' && Array.isArray(value.bytes.data)) {
    return Buffer.from(value.bytes.data);
  }
  return null;
}

/**
 * Extract bytes from an entry for hunk comparison.
 */
function extractEntryBytes(entry) {
  if (!entry || entry.kind === 'absent') return null;
  if (entry.bytes) return entry.bytes;
  if (entry.content) return entry.content;
  return null;
}

/**
 * Compute protected hunks from current vs candidate comparison.
 *
 * For text files: produces multiple hunks from line-level diff.
 * For binary files: produces one whole-file hunk.
 *
 * Each hunk: {artifactId, hunkDigest, baseDigest, currentDigest, candidateDigest, range}
 */
function collectProtectedHunks(artifactId, current, candidate) {
  const currentBytes = extractEntryBytes(current);
  const candidateBytes = extractEntryBytes(candidate);

  const currentSha = currentBytes ? sha256Hex(currentBytes) : (current?.sha256 ?? null);
  const candidateSha = candidateBytes ? sha256Hex(candidateBytes) : (candidate?.sha256 ?? null);

  // Both absent → no hunk
  if (!currentSha && !candidateSha) return [];

  // Same content → no protected hunk
  if (currentSha && candidateSha && currentSha === candidateSha) return [];

  // If current is absent, no protected hunks (new artifact)
  if (!currentBytes) return [];

  // Determine if content is text or binary
  const isText = currentBytes && isTextContent(currentBytes)
    && (!candidateBytes || isTextContent(candidateBytes));

  if (isText && currentBytes && candidateBytes) {
    return computeTextHunks(artifactId, currentBytes, candidateBytes);
  }

  // Binary or single-side: one whole-file hunk
  return [computeWholeFileHunk(artifactId, currentBytes, candidateBytes)];
}

/**
 * Check if content is likely text.
 * Binary if: contains null byte, or >30% non-printable/non-whitespace bytes.
 */
function isTextContent(bytes) {
  if (bytes.length === 0) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const check = bytes.length > 8192 ? bytes.subarray(0, 8192) : bytes;
  let nonPrintable = 0;
  for (let i = 0; i < check.length; i++) {
    const b = check[i];
    if (b === 0) return false; // null byte → definitely binary
    // Count non-printable (except common whitespace: tab, LF, CR)
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      nonPrintable++;
    }
    if (b === 0x7f) nonPrintable++;
  }
  // If >30% non-printable, treat as binary
  return nonPrintable / check.length <= 0.30;
}

/**
 * Compute text hunks from line-level diff between current and candidate.
 */
function computeTextHunks(artifactId, currentBytes, candidateBytes) {
  const currentStr = currentBytes.toString('utf8');
  const candidateStr = candidateBytes.toString('utf8');

  const currentLines = currentStr.split('\n');
  const candidateLines = candidateStr.split('\n');

  // Find changed line indices
  const changedLines = computeChangedLines(candidateLines, currentLines);

  if (changedLines.length === 0) return [];

  // Group into contiguous hunks
  const hunkRanges = groupContiguousLines(changedLines, currentLines);
  const candidateDigest = sha256Hex(candidateBytes);

  return hunkRanges.map((hunkRange) => {
    const { startByte, length } = hunkRange;
    const hunkBytes = currentBytes.slice(startByte, startByte + length);
    const hunkDigest = `sha256:${sha256Hex(`${artifactId}:hunk:${startByte}:${length}:${sha256Hex(hunkBytes)}`)}`;

    return Object.freeze({
      artifactId,
      hunkDigest,
      baseDigest: null, // bootstrap: no base
      currentDigest: sha256Hex(hunkBytes),
      candidateDigest,
      range: Object.freeze({ start: startByte, length }),
    });
  });
}

/**
 * Compute which line indices differ between produced and current.
 * Returns array of 0-based line indices in current that are changed.
 */
function computeChangedLines(producedLines, currentLines) {
  // Find longest common prefix/suffix for each line position
  const maxLen = Math.max(producedLines.length, currentLines.length);
  const changed = [];

  // Use simple LCS-based approach: find matching lines
  const matched = new Set();
  let pi = 0;

  for (let ci = 0; ci < currentLines.length; ci++) {
    let found = false;
    for (let pj = pi; pj < producedLines.length; pj++) {
      if (producedLines[pj] === currentLines[ci]) {
        matched.add(ci);
        pi = pj + 1;
        found = true;
        break;
      }
    }
    if (!found && ci < producedLines.length) {
      // Check if this line exists later in produced (not a pure add)
      const existsLater = producedLines.includes(currentLines[ci]);
      if (!existsLater) {
        changed.push(ci);
      }
    } else if (!found) {
      // Extra lines in current (beyond produced length)
      changed.push(ci);
    }
  }

  // Also check for lines that changed content (same position, different content)
  for (let i = 0; i < Math.min(producedLines.length, currentLines.length); i++) {
    if (!matched.has(i) && producedLines[i] !== currentLines[i]) {
      if (!changed.includes(i)) {
        changed.push(i);
      }
    }
  }

  changed.sort((a, b) => a - b);
  return changed;
}

/**
 * Group changed line indices into contiguous hunk ranges with byte offsets.
 */
function groupContiguousLines(changedLines, lines) {
  if (changedLines.length === 0) return [];

  // Pre-compute line byte offsets
  const lineOffsets = [];
  let offset = 0;
  const lastLine = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(offset);
    const lineBytes = Buffer.byteLength(lines[i], 'utf8');
    // Last empty line (from split on trailing \n) has no actual bytes
    offset += (i === lastLine && lines[i] === '') ? 0 : lineBytes + 1;
  }

  function endOffset(lineIdx) {
    const lineBytes = Buffer.byteLength(lines[lineIdx], 'utf8');
    // Last empty line: ends at the previous line's end
    if (lineIdx === lastLine && lines[lineIdx] === '') {
      return lineOffsets[lineIdx];
    }
    return lineOffsets[lineIdx] + lineBytes + 1;
  }

  const ranges = [];
  let groupStart = changedLines[0];
  let groupEnd = changedLines[0];

  for (let i = 1; i < changedLines.length; i++) {
    if (changedLines[i] === groupEnd + 1) {
      groupEnd = changedLines[i];
    } else {
      ranges.push({
        startByte: lineOffsets[groupStart],
        length: endOffset(groupEnd) - lineOffsets[groupStart],
      });
      groupStart = changedLines[i];
      groupEnd = changedLines[i];
    }
  }

  // Emit last group
  ranges.push({
    startByte: lineOffsets[groupStart],
    length: endOffset(groupEnd) - lineOffsets[groupStart],
  });

  return ranges;
}

/**
 * Compute a single whole-file hunk (for binary or non-text content).
 */
function computeWholeFileHunk(artifactId, currentBytes, candidateBytes) {
  const currentSha = currentBytes ? sha256Hex(currentBytes) : null;
  const candidateSha = candidateBytes ? sha256Hex(candidateBytes) : null;
  const length = currentBytes ? currentBytes.length : 0;

  const hunkDigest = `sha256:${sha256Hex(`${artifactId}:whole:${currentSha ?? 'absent'}:${candidateSha ?? 'absent'}`)}`;

  return Object.freeze({
    artifactId,
    hunkDigest,
    baseDigest: null,
    currentDigest: currentSha,
    candidateDigest: candidateSha,
    range: Object.freeze({ start: 0, length }),
  });
}

/**
 * Compute a deterministic digest for a hunk decision.
 * No timestamp or random fields — pure deterministic.
 */
function computeDecisionDigest(decision) {
  return `sha256:${sha256Hex(canonicalJson({
    artifactId: decision.artifactId,
    hunkDigest: decision.hunkDigest,
    baseDigest: decision.baseDigest ?? null,
    currentDigest: decision.currentDigest ?? null,
    candidateDigest: decision.candidateDigest ?? null,
    action: decision.action,
    actor: decision.actor,
    reason: decision.reason,
  }))}`;
}

/**
 * Derive a new adoption plan digest from decisions and protected hunks.
 */
function deriveAdoptionDigest(plan, decisions, hunks) {
  const canonical = canonicalJson({
    basePlanDigest: plan.planDigest ?? plan.plan?.planDigest,
    targetArtifactId: plan.targetArtifactId ?? null,
    sourceArtifactId: plan.sourceArtifactId ?? null,
    route: plan.route ?? null,
    transactionClosure: plan.transactionClosure ?? [],
    sourceCandidateDigest: plan.sourceCandidate?.sha256 ?? null,
    closureManifests: plan.closureManifests ?? null,
    artifactPaths: plan.artifactPaths ?? null,
    decisions: decisions.map((d) => d.decisionDigest ?? d),
    hunkDigests: hunks.map((h) => h.hunkDigest ?? h.digest),
  });
  return `sha256:${sha256Hex(canonical)}`;
}
