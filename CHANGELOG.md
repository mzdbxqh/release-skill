# Changelog

All notable changes to the `release-skill` plugin will be documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.1.1] - 2026-07-18

### Fixed

- **Stable npm byte handoff on macOS and Linux**: production publishing no
  longer passes `/dev/fd/*` or a mutable named path to npm. The adapter opens
  the frozen tarball with `O_NOFOLLOW`, verifies file identity, SHA-256,
  SHA-512 SRI, and embedded package name/version, then gives the same in-memory
  `Buffer` to `libnpmpublish`.
- **Registry and publisher authority**: plans freeze an explicit HTTPS npm
  registry and publisher. Preflight, token-specific `whoami`, publish,
  observation, and consumer install all use that registry; bearer credentials
  are sent with `forceAuth` and never fall back to ambient identity.
- **Pre-write tarball identity gate**: prepare and publish global preflight
  reject a tarball whose manifest name/version or independently computed
  integrity differs from the frozen unit and distribution, before any Git or
  npm external action executes.
- **Digest-addressed plan and approval history**: production commands consume
  `plans/<planDigest>.json` and
  `approvals/<planDigest>/<approvalDigest>.json`. Renewing an expired approval
  preserves prior approval bytes, so a long-lived PARTIAL recovery remains
  auditable without reusing expired authority.
- **Reconcile succeeded checkpoint fail-closed**: when re-observing a
  succeeded checkpoint, if the remote returns empty/error/uncertain state,
  reconcile now fails closed with REMOTE_CONFLICT instead of adding to the
  retry list. This prevents blind re-execution of already-succeeded actions.
- **Production README blocking findings**: missing required markers and
  readability requirements (install command, minimal example, failure
  diagnosis) in production prepare are now blocking findings (GATE_FAILED),
  not warnings.

## [0.1.0] - 2026-07-15

### Added

- **release-help** skill: discoverable entry point with environment checks,
  capability overview, minimal examples, read-only diagnosis, dry-run
  guidance, and failure triage.
- **release-assess** skill: read-only project topology identification and
  gap evaluation for documentation, configuration, supply chain, and
  release workflow.
- **release-prepare** skill: gate execution and release plan freezing
  without any external writes.
- **release-publish** skill: external release checkpoint execution from
  an approved, non-expired release plan.
- **release-reconcile** skill: remote state querying, partial success
  handling, safe retries, and post-publish verification.
- Deterministic release state machine:
  DISCOVERED -> ASSESSED -> PREPARED -> APPROVED -> PUBLISHING -> PUBLISHED -> VERIFIED.
- Exception states: NEEDS_INPUT, BLOCKED, PARTIAL.
- Adapter layer for Git/GitHub, npm, Claude Code marketplace, and Codex
  marketplace.
- Project declaration via `.release-skill/project.yaml` configuration.
- Hook execution model with executable/argument arrays, relative cwd,
  timeout, and environment allowlist.
- Structured evidence output in JSON/JSONL format with per-step
  checkpointing.
- Read-only assess and prepare phases; publish requires explicit approval
  bound to a frozen release plan digest.
- 24-hour approval expiry with automatic invalidation on plan, tree hash,
  target version, or remote conflict changes.
- Reconcile with idempotent skip of already-consistent steps and safe
  retry of incomplete actions.
