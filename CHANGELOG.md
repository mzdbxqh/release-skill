# Changelog

All notable changes to the `release-skill` plugin will be documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
