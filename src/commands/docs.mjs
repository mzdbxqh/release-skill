/**
 * `release-skill docs` command module
 * (2026-07-21-release-docs-command-and-prepare-gate §4,
 * 2026-07-21-release-docs-refresh-protocol).
 *
 * `runDocsCommand({ subcommand, args, root })` is the single entry point used
 * by the CLI router (bin/release-skill-cli.mjs). The docs command accepts
 * exactly one subcommand — `refresh` — and validates every parameter BEFORE
 * invoking the refresh service, so precise stable parameter errors surface
 * even when no project configuration or safe-fs backend is available:
 *
 * - unknown/missing subcommand            → MISSING_PARAMETERS {subcommand, valid}
 * - bare positional (beyond the command
 *   and subcommand tokens) or single-dash
 *   flag (-w, -x)                         → MISSING_PARAMETERS UNRECOGNIZED_PARAMETER
 * - missing --unit                        → MISSING_PARAMETERS {field:'--unit'}
 * - flag without a value (or with a
 *   flag-like/-prefixed value)            → MISSING_PARAMETERS MISSING_VALUE
 * - --unit value outside the unit-id
 *   charset                               → MISSING_PARAMETERS INVALID_VALUE
 * - duplicated flag                       → MISSING_PARAMETERS DUPLICATE_PARAMETER
 * - malformed --confirm-refresh digest    → MISSING_PARAMETERS INVALID_VALUE
 * - write flags without --write           → MISSING_PARAMETERS CONFLICTING_PARAMETERS
 * - --write without both authorizations   → MISSING_PARAMETERS MISSING_WRITE_PARAMETERS
 * - any flag outside the recognized set   → MISSING_PARAMETERS UNRECOGNIZED_PARAMETER
 *
 * The `--flag=value` equals form routes through exactly the same validation
 * as the space-separated form: a valued flag's value is validated identically
 * (errors name the flag part precisely, never the whole token), and boolean
 * or router flags reject the equals form as INVALID_VALUE.
 *
 * The recognized flag set is exactly: --root --json --unit --write
 * --confirm-refresh --ack-local-document-write. --root and --json are
 * consumed by the CLI router (project root, output shape); the rest drive
 * `runReleaseDocsRefresh`, which re-validates the three-way write
 * authorization (write + exact confirmRefresh + ackLocalDocumentWrite) as
 * defense in depth. Although the router owns --json's semantics, the
 * space-separated form is duplicate-detected here: a repeated --json fails
 * closed with DUPLICATE_PARAMETER BEFORE any service call, project config
 * read, lock, or transaction — exactly like --unit, --write,
 * --confirm-refresh, and --ack-local-document-write. The --json=value equals
 * form stays rejected as INVALID_VALUE.
 *
 * The dry-run result is re-projected here so the authoritative version —
 * deliberately kept off the service result's enumerable surface — becomes a
 * regular JSON field of the CLI success shape. Write/clean results are
 * returned verbatim. Every user-visible value carries canonical relative
 * paths only: never absolute paths, note/old body text, credentials, full
 * diffs, or serialized buffers.
 *
 * The write authorization granted by --write + --confirm-refresh +
 * --ack-local-document-write covers ONLY the declared local release-document
 * targets; it never authorizes committing, pushing, tagging, publishing, or
 * installing.
 *
 * @module src/commands/docs
 */

import {
  ReleaseError,
  MISSING_PARAMETERS,
} from '../core/errors.mjs';
import { runReleaseDocsRefresh } from '../docs/refresh-service.mjs';

const VALID_SUBCOMMANDS = Object.freeze(['refresh']);
const CONFIRM_REFRESH_PATTERN = /^sha256:[0-9a-f]{64}$/;

// Unit identifier charset — the same shape as the transaction journal's
// module-private DOCS_REFRESH_UNIT_ID_RE, deliberately re-declared locally
// (no cross-module import): start with an alphanumeric character, then
// alphanumerics, ".", "_" or "-".
const UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parse and validate `docs refresh` parameters from the raw argv slice.
 * All validation errors are MISSING_PARAMETERS with a machine-readable
 * details.reason; validation completes before any service call.
 *
 * @param {string[]} args — Raw argv slice (includes the command and
 *   subcommand tokens; exactly those first two bare positionals are exempt,
 *   any further bare positional or single-dash flag is rejected).
 * @returns {{ unitId: string, write: boolean, confirmRefresh: string|undefined,
 *   ackLocalDocumentWrite: boolean }}
 * @throws {ReleaseError} MISSING_PARAMETERS on any parameter violation.
 */
function parseDocsRefreshArgs(args) {
  const argv = Array.isArray(args) ? args : [];
  const seen = new Set();
  let unitId;
  let confirmRefresh;
  let write = false;
  let ackLocalDocumentWrite = false;
  let barePositionals = 0;

  const claimOnce = (flag) => {
    if (seen.has(flag)) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        `docs refresh received ${flag} more than once`,
        { reason: 'DUPLICATE_PARAMETER', field: flag },
      );
    }
    seen.add(flag);
  };

  // A flag value must be a non-empty token that is not itself flag-like
  // (neither `--flag` nor `-x`); shared by the space-separated and the
  // --flag=value forms.
  const assertPlainValue = (flag, value) => {
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        `docs refresh ${flag} requires a value`,
        { reason: 'MISSING_VALUE', field: flag },
      );
    }
    return value;
  };

  const claimValue = (flag, index) => assertPlainValue(flag, argv[index + 1]);

  const assertUnitId = (value) => {
    if (!UNIT_ID_PATTERN.test(value)) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        'docs refresh --unit must be a unit identifier (start with an alphanumeric character; then alphanumerics, "." , "_" or "-" only)',
        { reason: 'INVALID_VALUE', field: '--unit' },
      );
    }
    return value;
  };

  const assertConfirmRefreshDigest = (value) => {
    if (!CONFIRM_REFRESH_PATTERN.test(value)) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        'docs refresh --confirm-refresh must be exactly sha256:<64 lowercase hex characters>',
        { reason: 'INVALID_VALUE', field: '--confirm-refresh' },
      );
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== 'string') continue;

    if (token.startsWith('--')) {
      // The --flag=value equals form routes through exactly the same
      // validation as the space-separated form; errors name the flag part.
      const eq = token.indexOf('=');
      if (eq !== -1) {
        const flag = token.slice(0, eq);
        const inlineValue = token.slice(eq + 1);
        if (flag === '--unit') {
          claimOnce(flag);
          unitId = assertUnitId(assertPlainValue(flag, inlineValue));
        } else if (flag === '--confirm-refresh') {
          claimOnce(flag);
          confirmRefresh = assertConfirmRefreshDigest(assertPlainValue(flag, inlineValue));
        } else if (
          flag === '--write'
          || flag === '--ack-local-document-write'
          || flag === '--root'
          || flag === '--json'
        ) {
          throw new ReleaseError(
            MISSING_PARAMETERS,
            `docs refresh ${flag} does not accept the --flag=value form`,
            { reason: 'INVALID_VALUE', field: flag },
          );
        } else {
          throw new ReleaseError(
            MISSING_PARAMETERS,
            `docs refresh does not accept ${flag}`,
            { reason: 'UNRECOGNIZED_PARAMETER', parameter: flag },
          );
        }
        continue;
      }

      if (token === '--unit') {
        claimOnce(token);
        unitId = assertUnitId(claimValue(token, i));
        i += 1;
      } else if (token === '--confirm-refresh') {
        claimOnce(token);
        confirmRefresh = assertConfirmRefreshDigest(claimValue(token, i));
        i += 1;
      } else if (token === '--write') {
        claimOnce(token);
        write = true;
      } else if (token === '--ack-local-document-write') {
        claimOnce(token);
        ackLocalDocumentWrite = true;
      } else if (token === '--json') {
        // Consumed by the CLI router (output shape); no docs-command
        // semantics, but the router-owned flag is still duplicate-detected
        // here so a repeated space-separated --json fails closed with
        // DUPLICATE_PARAMETER BEFORE any service call, config read, lock, or
        // transaction — exactly like --unit/--write/--confirm-refresh/
        // --ack-local-document-write.
        claimOnce(token);
      } else if (token === '--root') {
        // Consumed by the CLI router (project root). Skip its value so the
        // path is never mistaken for a bare positional; the router validates
        // the --root value shape before calling runDocsCommand.
        i += 1;
      } else {
        throw new ReleaseError(
          MISSING_PARAMETERS,
          `docs refresh does not accept ${token}`,
          { reason: 'UNRECOGNIZED_PARAMETER', parameter: token },
        );
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      // Single-dash flags (e.g. -w, -x) were previously skipped silently.
      throw new ReleaseError(
        MISSING_PARAMETERS,
        `docs refresh does not accept ${token}`,
        { reason: 'UNRECOGNIZED_PARAMETER', parameter: token },
      );
    }

    // The raw argv slice carries the `docs` command token and the subcommand
    // token themselves; exempt exactly those first two bare positionals and
    // reject any other positional (e.g. `docs refresh foo`).
    barePositionals += 1;
    if (barePositionals > 2) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        `docs refresh does not accept positional argument ${token}`,
        { reason: 'UNRECOGNIZED_PARAMETER', parameter: token },
      );
    }
  }

  if (typeof unitId !== 'string' || unitId.length === 0) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'docs refresh requires --unit <id>',
      { field: '--unit' },
    );
  }

  if ((confirmRefresh !== undefined || ackLocalDocumentWrite) && !write) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'docs refresh --confirm-refresh and --ack-local-document-write are only valid together with --write',
      {
        reason: 'CONFLICTING_PARAMETERS',
        flags: ['--confirm-refresh', '--ack-local-document-write', '--write'],
      },
    );
  }

  if (write) {
    const missing = [];
    if (confirmRefresh === undefined) missing.push('confirmRefresh');
    if (!ackLocalDocumentWrite) missing.push('ackLocalDocumentWrite');
    if (missing.length > 0) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        'docs refresh --write requires --confirm-refresh <sha256:...> and --ack-local-document-write',
        { reason: 'MISSING_WRITE_PARAMETERS', missing },
      );
    }
  }

  return { unitId, write, confirmRefresh, ackLocalDocumentWrite };
}

/**
 * Run the `docs` command.
 *
 * @param {object} [options]
 * @param {string} [options.subcommand] — Must be exactly 'refresh'.
 * @param {string[]} [options.args] — Raw argv slice for parameter parsing.
 * @param {string} [options.root] — Absolute project root (CLI resolves cwd).
 * @returns {Promise<object>} Frozen docs-refresh result (CLI success shape):
 *   dry-run {command, mode, status, unitId, version, locales, inputDigest,
 *   refreshDigest, files, nextCommand}; write {command, mode, status,
 *   refreshed, unitId, version, refreshDigest, transactionId, refreshedPaths};
 *   clean write {command, mode, status, refreshed, unitId, version,
 *   refreshDigest}.
 * @throws {ReleaseError} MISSING_PARAMETERS (24) on any parameter violation;
 *   all service error codes propagate unchanged (RELEASE_DOCS_INVALID 42,
 *   RELEASE_DOCS_REFRESH_STALE 45, GATE_FAILED 13, PATH_UNSAFE 28,
 *   SAFE_WRITE_UNAVAILABLE 39, PLAN_STALE 36, TRANSACTION_INCOMPLETE 38).
 */
export async function runDocsCommand({ subcommand, args, root } = {}) {
  if (subcommand !== 'refresh') {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      `unknown docs subcommand: "${typeof subcommand === 'string' ? subcommand : ''}"; valid: ${VALID_SUBCOMMANDS.join(', ')}`,
      { subcommand, valid: [...VALID_SUBCOMMANDS] },
    );
  }

  const options = parseDocsRefreshArgs(args);

  const result = await runReleaseDocsRefresh({
    root,
    unitId: options.unitId,
    write: options.write,
    confirmRefresh: options.confirmRefresh,
    ackLocalDocumentWrite: options.ackLocalDocumentWrite,
  });

  if (result.mode === 'dry-run') {
    // The service keeps the authoritative version off the enumerable
    // projection surface; the CLI success shape re-adds it as a regular
    // field (contract §4.3 dry-run shape).
    return Object.freeze({
      command: result.command,
      mode: result.mode,
      status: result.status,
      unitId: result.unitId,
      version: result.version,
      locales: result.locales,
      inputDigest: result.inputDigest,
      refreshDigest: result.refreshDigest,
      files: result.files,
      nextCommand: result.nextCommand,
    });
  }

  return result;
}
