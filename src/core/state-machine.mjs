// Release state machine: guards and enforces valid state transitions.

import { ReleaseError, INVALID_STATE_TRANSITION } from './errors.mjs';

// ---- State constants ----

export const DISCOVERED = 'DISCOVERED';
export const ASSESSED = 'ASSESSED';
export const PREPARED = 'PREPARED';
export const APPROVED = 'APPROVED';
export const PUBLISHING = 'PUBLISHING';
export const PUBLISHED = 'PUBLISHED';
export const VERIFIED = 'VERIFIED';

export const NEEDS_INPUT = 'NEEDS_INPUT';
export const BLOCKED = 'BLOCKED';
export const PARTIAL = 'PARTIAL';

/** Normal lifecycle states in order. */
export const NORMAL_STATES = Object.freeze([
  DISCOVERED, ASSESSED, PREPARED, APPROVED, PUBLISHING, PUBLISHED, VERIFIED,
]);

/** Exception states. */
export const EXCEPTION_STATES = Object.freeze([
  NEEDS_INPUT, BLOCKED, PARTIAL,
]);

/** All valid states. */
export const ALL_STATES = Object.freeze([...NORMAL_STATES, ...EXCEPTION_STATES]);

// ---- Allowed transitions ----

/**
 * Explicit transition map.
 *
 * Design rules:
 * - Normal path only moves forward (single step).
 * - NEEDS_INPUT and BLOCKED can be entered from any normal state except VERIFIED.
 * - NEEDS_INPUT and BLOCKED can return to any normal state except VERIFIED.
 * - PARTIAL can only be entered from PUBLISHING.
 * - PARTIAL can return to PUBLISHING/PUBLISHED or escalate to NEEDS_INPUT / BLOCKED.
 * - APPROVED cannot skip directly to VERIFIED.
 * - NEEDS_INPUT and BLOCKED cannot transition to VERIFIED.
 * - VERIFIED is terminal with no outbound transitions.
 */
const TRANSITIONS = Object.freeze({
  [DISCOVERED]: Object.freeze([ASSESSED, NEEDS_INPUT, BLOCKED]),
  [ASSESSED]: Object.freeze([PREPARED, NEEDS_INPUT, BLOCKED]),
  [PREPARED]: Object.freeze([APPROVED, NEEDS_INPUT, BLOCKED]),
  [APPROVED]: Object.freeze([PUBLISHING, NEEDS_INPUT, BLOCKED]),
  [PUBLISHING]: Object.freeze([PUBLISHED, PARTIAL, NEEDS_INPUT, BLOCKED]),
  [PUBLISHED]: Object.freeze([VERIFIED, NEEDS_INPUT, BLOCKED]),
  [VERIFIED]: Object.freeze([]),
  [NEEDS_INPUT]: Object.freeze([ASSESSED, PREPARED, APPROVED, BLOCKED]),
  [BLOCKED]: Object.freeze([ASSESSED, PREPARED, APPROVED, NEEDS_INPUT]),
  [PARTIAL]: Object.freeze([PUBLISHING, PUBLISHED, NEEDS_INPUT, BLOCKED]),
});

/**
 * Assert that a transition from `from` to `to` is allowed.
 *
 * @param {string} from  Current state.
 * @param {string} to    Target state.
 * @throws {ReleaseError} with code INVALID_STATE_TRANSITION if the transition is not allowed.
 */
export function assertTransition(from, to) {
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new ReleaseError(
      INVALID_STATE_TRANSITION,
      `Invalid state transition: ${from} -> ${to}`,
      { from, to },
    );
  }
}
