// Stable error codes and exit codes for the release-skill system.
// Error codes are grouped by phase; each maps to a unique stable exit code.

// Defect #3 choke-point dependency: the deep redaction authority lives in
// core/redact.mjs (pure, zero-dependency). It must load WITHOUT any top-level
// await: a TLA here made esbuild turn this module's bundled init block async,
// and the artifacts tree/entry import cycle then deadlocked during bundled
// command initialization, so `await import(bundlePath)` in
// bin/release-skill.mjs never settled and Node exited with code 13
// "Detected unsettled top-level await" instead of the real business exit code
// (AC-7). Two TLA-free mechanisms install the redactor instead:
//
// 1. Eager registration: real entries (bin/release-skill-cli.mjs, therefore
//    also the self-contained bundle and the Claude/Codex adapters built from
//    it) import errors.mjs and redact.mjs statically and call
//    registerPathRedactor() synchronously before any command code runs —
//    deterministic in source and bundled form, no microtask window.
// 2. Self-load fallback: the fire-and-forget dynamic import below covers
//    consumers that import errors.mjs alone (unit tests and the
//    artifacts-safe-fs production-loader subprocess fixtures). It is
//    deliberately NOT awaited: this module stays synchronously loadable (no
//    TLA in the module graph), and a missing redact.mjs (isolated fixtures
//    that copy errors.mjs alone) simply degrades to the identity function via
//    the rejection handler. In every real deployment redact.mjs ships
//    alongside errors.mjs (enforced by error-path-redaction.test.mjs and the
//    bundle/adapters --check gates), so the constructor below always redacts
//    in production.
let redactSensitivePaths = (value) => value;

/**
 * Install the path-redaction authority used by the ReleaseError choke point.
 * Idempotent; non-function arguments are ignored so a bad caller can never
 * disable redaction. Called eagerly by CLI entries (static import, before any
 * command runs) and by the self-load fallback below.
 *
 * @param {(value: unknown) => unknown} fn deep redaction from core/redact.mjs.
 */
export function registerPathRedactor(fn) {
  if (typeof fn === 'function') redactSensitivePaths = fn;
}

// Fire-and-forget self-load (never awaited → no top-level await). The
// rejection handler is attached synchronously in the same tick, so an absent
// redact.mjs degrades to identity without ever producing an unhandled
// rejection or keeping the event loop alive.
import('./redact.mjs').then(
  (mod) => registerPathRedactor(mod.redactSensitivePaths),
  () => { /* isolated copy without redact.mjs: keep identity redaction */ },
);

/** @type {Readonly<Record<string, number>>} */
const EXIT_CODE_MAP = Object.freeze({
  CONFIG_INVALID: 10,
  BASELINE_CHANGED: 11,
  DIRTY_SCOPE_CONFLICT: 12,
  GATE_FAILED: 13,
  AUTH_MISSING: 14,
  REMOTE_CONFLICT: 15,
  HOOK_TIMEOUT: 16,
  PARTIAL_RELEASE: 17,
  POST_PUBLISH_VERIFY_FAILED: 18,
  INVALID_STATE_TRANSITION: 19,
  PLAN_DIGEST_MISMATCH: 20,
  SECRET_DETECTED: 21,
  PUBLIC_PATH_FORBIDDEN: 22,
  STALE_BUILD_ARTIFACT: 23,
  MISSING_PARAMETERS: 24,
  PUBLIC_FILE_MISSING: 25,
  SNAPSHOT_FIDELITY_FAILED: 26,
  FORBIDDEN_CONTENT_DETECTED: 27,
  PATH_UNSAFE: 28,
  STRUCTURE_INVALID: 29,
  LOCK_MIGRATION_REQUIRED: 30,
  ARTIFACT_POLICY_INVALID: 31,
  BASE_UNAVAILABLE: 32,
  PRODUCER_NONDETERMINISTIC: 33,
  PRODUCER_SCOPE_VIOLATION: 34,
  ADOPTION_AMBIGUOUS: 35,
  PLAN_STALE: 36,
  SENSITIVE_CONFLICT: 37,
  TRANSACTION_INCOMPLETE: 38,
  SAFE_WRITE_UNAVAILABLE: 39,
  SETUP_DIGEST_MISMATCH: 40,
  CONFIG_EXISTS: 41,
  RELEASE_DOCS_INVALID: 42,
  RELEASE_DOCS_TRANSLATION_MISSING: 43,
  RELEASE_DOCS_CONFLICT: 44,
  RELEASE_DOCS_REFRESH_STALE: 45,
  RELEASE_DOCS_STALE: 46,
});

// ---- Error code constants ----

export const CONFIG_INVALID = 'CONFIG_INVALID';
export const BASELINE_CHANGED = 'BASELINE_CHANGED';
export const DIRTY_SCOPE_CONFLICT = 'DIRTY_SCOPE_CONFLICT';
export const GATE_FAILED = 'GATE_FAILED';
export const AUTH_MISSING = 'AUTH_MISSING';
export const REMOTE_CONFLICT = 'REMOTE_CONFLICT';
export const HOOK_TIMEOUT = 'HOOK_TIMEOUT';
export const PARTIAL_RELEASE = 'PARTIAL_RELEASE';
export const POST_PUBLISH_VERIFY_FAILED = 'POST_PUBLISH_VERIFY_FAILED';
export const INVALID_STATE_TRANSITION = 'INVALID_STATE_TRANSITION';
export const PLAN_DIGEST_MISMATCH = 'PLAN_DIGEST_MISMATCH';
export const SECRET_DETECTED = 'SECRET_DETECTED';
export const PUBLIC_PATH_FORBIDDEN = 'PUBLIC_PATH_FORBIDDEN';
export const STALE_BUILD_ARTIFACT = 'STALE_BUILD_ARTIFACT';
export const MISSING_PARAMETERS = 'MISSING_PARAMETERS';
export const PUBLIC_FILE_MISSING = 'PUBLIC_FILE_MISSING';
export const SNAPSHOT_FIDELITY_FAILED = 'SNAPSHOT_FIDELITY_FAILED';
export const FORBIDDEN_CONTENT_DETECTED = 'FORBIDDEN_CONTENT_DETECTED';
export const PATH_UNSAFE = 'PATH_UNSAFE';
export const STRUCTURE_INVALID = 'STRUCTURE_INVALID';
export const LOCK_MIGRATION_REQUIRED = 'LOCK_MIGRATION_REQUIRED';
export const ARTIFACT_POLICY_INVALID = 'ARTIFACT_POLICY_INVALID';
export const BASE_UNAVAILABLE = 'BASE_UNAVAILABLE';
export const PRODUCER_NONDETERMINISTIC = 'PRODUCER_NONDETERMINISTIC';
export const PRODUCER_SCOPE_VIOLATION = 'PRODUCER_SCOPE_VIOLATION';
export const ADOPTION_AMBIGUOUS = 'ADOPTION_AMBIGUOUS';
export const PLAN_STALE = 'PLAN_STALE';
export const SENSITIVE_CONFLICT = 'SENSITIVE_CONFLICT';
export const TRANSACTION_INCOMPLETE = 'TRANSACTION_INCOMPLETE';
export const SAFE_WRITE_UNAVAILABLE = 'SAFE_WRITE_UNAVAILABLE';
export const SETUP_DIGEST_MISMATCH = 'SETUP_DIGEST_MISMATCH';
export const CONFIG_EXISTS = 'CONFIG_EXISTS';
export const RELEASE_DOCS_INVALID = 'RELEASE_DOCS_INVALID';
export const RELEASE_DOCS_TRANSLATION_MISSING = 'RELEASE_DOCS_TRANSLATION_MISSING';
export const RELEASE_DOCS_CONFLICT = 'RELEASE_DOCS_CONFLICT';
export const RELEASE_DOCS_REFRESH_STALE = 'RELEASE_DOCS_REFRESH_STALE';
export const RELEASE_DOCS_STALE = 'RELEASE_DOCS_STALE';

/**
 * Typed error for release-skill operations.
 *
 * @param {string} code   One of the exported error-code constants.
 * @param {string} message  Human-readable description.
 * @param {Record<string, unknown>} [details]  Machine-readable context (must not contain secrets).
 * @param {number} [exitCode]  Override exit code; defaults to the stable mapping for `code`.
 */
export class ReleaseError extends Error {
  constructor(code, message, details = {}, exitCode) {
    // Defect #3 choke point: redact absolute filesystem paths from the
    // message and details before assignment so every consumer (all CLI
    // catches in text and JSON modes, recoverable-error propagation chains,
    // and toJSON) can only observe redacted values. Error codes, exit codes,
    // and the envelope key set are unchanged; redaction is value-level only.
    super(redactSensitivePaths(message));
    this.name = 'ReleaseError';
    this.code = code;
    this.details = redactSensitivePaths(details);
    this.exitCode = exitCode ?? EXIT_CODE_MAP[code] ?? 1;

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ReleaseError);
    }
  }

  /**
   * Serialise the error to a plain JSON-safe object.
   * Intentionally omits the stack trace and any raw secret values.
   *
   * @returns {{ code: string, message: string, details: Record<string, unknown>, exitCode: number }}
   */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      exitCode: this.exitCode,
    };
  }
}

/** All known error codes as a frozen array. */
export const ALL_ERROR_CODES = Object.freeze(Object.keys(EXIT_CODE_MAP));

/** The stable exit-code map, keyed by error code. */
export { EXIT_CODE_MAP };
