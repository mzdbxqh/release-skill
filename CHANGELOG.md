# Changelog

<!-- release-skill:changelog:start version=0.1.7 locale=en baseline=sha256:e41fd6460f5bb63343547f04b08e2cfcdd8a64cb53806cbcf39870a2fe27b03e -->
## [0.1.7] - 2026-07-23

v0.1.7 is an organizational migration release. The public GitHub repository moves from `mzdbxqh/release-skill` to `ifoohoo/release-skill` (the repository name is unchanged and GitHub redirects the old URL), the project gains an explicit corporate maintainer and copyright holder (广州市风荷科技有限公司), and the forward-looking repository, maintainer, author, and copyright metadata across the npm package, plugin marketplace manifests, NOTICE, LICENSE, and release configuration are aligned with the new organization. The npm package name (`release-skill`) and the npm publishing identity (`publisher: mzdbxqh`) are unchanged, and the already-published v0.1.6 tag, GitHub Release, and npm version are not rewritten.

### Changed

- **Public repository migrated to the `ifoohoo` organization**: the public
  GitHub repository is transferred from `mzdbxqh/release-skill` to
  `ifoohoo/release-skill` with the repository name unchanged. The default branch
  remains `main`, the v0.1.6 tag, release, and history are preserved, and the old
  URL redirects (HTTP 301) to the new location. The release configuration
  (`publicRepo` and the bound `previousPublicBaseline`) now points at
  `ifoohoo/release-skill` with the public v0.1.6 commit
  `48fb2a258a2786c2e32136ad67bd51f3a280b3b8` as the previous public baseline.
- **Corporate maintainer and copyright**: the MIT LICENSE (root and public
  package) now carries a dual copyright line for the release-skill contributors
  and 广州市风荷科技有限公司, and the NOTICE states that the project is maintained
  by 广州市风荷科技有限公司 and clarifies that the GitHub repository transfer is an
  administrative hosting/identity change that does not by itself constitute a
  copyright assignment.
- **Forward-looking metadata aligned with the organization**: the npm
  `package.json` repository, homepage, and issue tracker URLs point at
  `ifoohoo/release-skill`, and the package adds a corporate author while
  preserving the release-skill contributors. The Claude Code plugin marketplace
  owner now identifies the `ifoohoo` organization. The npm package name
  (`release-skill`) and the npm publishing identity (`publisher: mzdbxqh`) are
  unchanged.
<!-- release-skill:changelog:end version=0.1.7 locale=en -->


<!-- release-skill:changelog:start version=0.1.6 locale=en baseline=sha256:6b45d1aa912b32c9c00a616661ae3e2a9536e5ff85a7c0cf82b846a3ffb6c1d3 -->
## [0.1.6] - 2026-07-22

v0.1.6 is a release-preparation snapshot that closes the release-docs automation loop. A single structured release-notes source drives deterministic, multilingual CHANGELOG and README refresh behind a two-phase, digest-bound write protocol and a prepare-time documentation freshness gate, while terminal transaction receipts are bounded and the CLI lifecycle, path safety, and error-output redaction are hardened.

### Added

- **Structured release-notes-driven document refresh (`docs refresh`)**: a single
  structured release-notes source (`release-notes/0.1.6.yaml`) now drives
  deterministic, multilingual refresh of the managed CHANGELOG and README
  regions. Refresh runs as a two-phase protocol: a read-only planning phase
  renders every candidate and freezes an `inputDigest` (binding the canonical
  notes and the notes-source bytes) plus a `refreshDigest` (binding the protocol
  version, unit, version, configuration projection, and per-file old/new
  digests), and a separate write phase commits the changed targets only when all
  three authorizations are present (`--write`, an exact `--confirm-refresh
  <refreshDigest>` match, and `--ack-local-document-write`). The write phase
  re-plans under the exclusive lock; a diverging digest converges to
  `RELEASE_DOCS_REFRESH_STALE` with zero writes, and a clean plan is a zero-write
  no-op. A prepare-time documentation freshness gate makes version drift between
  the package version and the public docs fail closed before a release plan is
  frozen.
- **Bounded terminal transaction receipts with recovery safety**: terminal
  (committed / rolled-back) transactions now persist a summary-only receipt
  instead of full payload, capped at 256 KB per receipt
  (`TERMINAL_RECEIPT_SIZE_CAP`), under a retention cap of 50 terminal records
  (`DEFAULT_TRANSACTION_RETENTION_MAX`). Retention pruning only ever removes
  terminal records and never prunes `RECOVERY_CONFLICT` records or any
  non-terminal (recovery-relevant) record, so recovery evidence is preserved even
  when the count cap is reached; a retention failure never aborts an in-flight
  commit.
- **Strict `docs refresh` parameter validation (fail closed)**: the `docs`
  command validates every parameter before invoking the refresh service, so
  precise stable parameter errors surface even without project configuration or a
  safe-fs backend. The `--flag=value` equals form routes through exactly the same
  validation as the space-separated form; duplicated flags fail closed with
  `DUPLICATE_PARAMETER` before any service call, config read, lock, or
  transaction; and bare positional arguments and single-dash flags (such as `-w`)
  are rejected as unrecognized. Write-authorization flags supplied without
  `--write`, or `--write` without its full authorizations, fail closed with
  precise reasons rather than silently proceeding.

### Fixed

- **Bundle entry lifecycle settles with real exit codes**: the self-contained
  bundle now owns the command lifecycle. Its entry awaits command completion and
  exits with the real business exit code for success, business errors, handled
  async rejections, and unknown commands, so the launcher no longer leaves an
  unsettled top-level await (Node exit code 13). When the bundle is missing or
  cannot be evaluated, the launcher fails closed with static text only and never
  interpolates machine-specific paths, usernames, or host layout, because
  module-load failure messages carry absolute paths.
- **Fail-closed path canonicalization with stable diagnostics**: artifact path
  canonicalization requires POSIX separators and rejects absolute paths in POSIX
  (`/`), Windows drive-letter, and UNC spellings, along with traversal, Windows
  reserved device names, and colons, failing closed with `PATH_UNSAFE` rather
  than normalizing an unsafe spelling into a different public path. Error-output
  redaction now distinguishes real filesystem paths from strict RFC 6901 JSON
  Pointer diagnostic coordinates (such as `/units/0/version`): absolute
  POSIX/Windows/UNC paths collapse to a stable `<redacted-path>` placeholder
  while diagnostic pointers are preserved verbatim, keeping failures diagnosable
  without leaking host paths.
- **Self public-boundary redaction**: the centralized redaction authority
  (`core/redact.mjs`) now closes the self public boundary so runtime error
  outputs and detail structures never carry the release-skill workspace's own
  absolute path, nor the macOS `Users`, Linux home, macOS `private`/`var` alias,
  temp, or CI checkout realms. Redaction runs fail-closed through the
  `ReleaseError` choke point: any two-or-more-segment `/`-led token that is not a
  strict diagnostic JSON Pointer is replaced with `<redacted-path>`, so
  self-releasing never leaks private filesystem layout into public outputs.
<!-- release-skill:changelog:end version=0.1.6 locale=en -->


All notable changes to the `release-skill` plugin will be documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/).

<!-- release-skill:changelog:start version=0.1.5 locale=en baseline=sha256:72d222ff63008de63edcf20c89626fa18748e6cb39e54263e861b8f0c9669026 -->
## [0.1.5] - 2026-07-21

Claude and Codex marketplace installs now use an explicit, configurable timeout frozen into the release plan.

### Added

- **Explicit marketplace install timeout (`timeoutMs`)**: Claude and Codex
  plugin marketplace distributions now accept an optional `timeoutMs` integer
  field (range 30,000--900,000 ms; default 300,000 ms). The resolved value is
  frozen into each marketplace install action's `parameters.timeoutMs` during
  `prepare`, making it part of the plan digest, approval binding, and plan
  integrity. The `plugin-marketplace` adapter's marketplace add, plugin install,
  and plugin list commands all use the same frozen timeout, replacing the
  previous hardcoded 30-second limit that caused `PARTIAL` failures on real
  network installations requiring 40--105 seconds.
- **Old plan backward compatibility**: plans created before v0.1.5 that lack
  `parameters.timeoutMs` on marketplace install actions default to 300,000 ms,
  so existing `PARTIAL` runs can be reconciled without upgrading the plan.

### Fixed

- **Marketplace consumer install timeout**: v0.1.4 production releases hit
  `PARTIAL` because Claude Code and Codex plugin marketplace add commands
  required 40--105 seconds on real networks, while the adapter hardcoded a
  30-second subprocess timeout. The timeout is now explicitly configurable per
  distribution and verified through injected-executor tests. Invalid values
  (non-integer, non-finite, out-of-range) fail closed rather than being
  silently clamped.
<!-- release-skill:changelog:end version=0.1.5 locale=en -->

## [0.1.4] - 2026-07-19

### Added

- **Docs version hard gate**: the English and Chinese README and INSTALL each
  carry a machine-readable `release-skill:release-version` marker that must
  equal the `package.json` version, and the CHANGELOG must carry a formal
  heading for the current version. Any drift fails closed in
  `pnpm test:release` before prepare. A release freezes only the current
  truth: human docs are never auto-refreshed and must be updated, reviewed,
  and approved first.
- **Auditable frozen commit timestamps**: production `prepare` samples the
  plan freeze time once, validates it before any Git write, and binds it to
  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` and each unit's
  `frozenSnapshot.commitTimestamp` (schema-required); plans missing the field
  are rejected instead of silently rebuilt.

### Fixed

- **Self-contained installed CLI smoke**: the v0.1.3 self-release selected
  `help --json`, which correctly treats Git as a required environment
  dependency, while npm smoke intentionally exposes only the Node runtime.
  The CLI now supports `--version --json`, and self-release verification uses
  that dependency-free entry to bind the installed CLI name and exact version
  without widening the isolated process `PATH`.
- Added a real subprocess regression that runs the installed-style version
  entry with the Node-only `PATH` and proves an unrelated injected path is not
  inherited.

## [0.1.3] - 2026-07-19

> `0.1.2` was an internal release candidate and was never published to npm or
> GitHub Releases. Its fixes are included here; `0.1.3` is the next public
> release after `0.1.1`.

### Added

- **Create-once first-use setup**: `release-skill setup` performs deterministic,
  read-only discovery of packages, plugin manifests, Git remotes, legacy
  `public-release.json`, public-file hints, and project quality scripts. It
  reports `NEEDS_INPUT` or `LOCAL_ONLY_DETECTED` honestly and writes only an
  absent `.release-skill/project.yaml` after answers and the exact
  `setupDigest` are confirmed.
- **Discoverable `release-setup` skill**: Claude and Codex adapters now guide
  users through candidate review, explicit gate selection, fact-drift handling,
  and the safe handoff to `release-assess` without regenerating human content.
- **Project verification gates**: `snapshot-verify` runs selected commands in a
  disposable writable copy of the frozen public snapshot;
  `consumer-verify` runs after an exact isolated npm/Claude/Codex installation.
  Gate definitions, exact execution-input digests, and bounded output digests
  are frozen into plan/run evidence.
- **Identity-bound create-once setup**: the final facts/answers digest and
  config bytes are bound immediately before a directory-handle-relative,
  no-follow create. v0.1.3 ships a digest-registered `darwin-arm64` prebuild;
  unsupported platforms fail closed instead of using pathname writes.
- **Explicit production branch strategies**: projects can create an immutable
  release branch, fast-forward an existing branch from an exact bound baseline,
  or initialize an absent standard branch and make a separately approved,
  observable, reconcilable default-branch change.

### Changed

- Existing `public-release.json` snapshot commands are surfaced only as
  migration candidates. Discovery never grants execution authority; gate and
  legacy-hook side effects still require separate explicit acknowledgements.
- Compatibility configurations for artifact-graph, flow-architect, loop-agent,
  and agent-method-registry now bind real tag/channel/baseline semantics and
  project-owned verification behavior. glaf4-test is represented as local-only
  instead of receiving an invented remote channel.
- README and installation guidance now begin with safe setup, explain the three
  branch strategies, and distinguish pre-freeze hooks from frozen-snapshot and
  installed-consumer gates.

### Fixed

- **GitHub CLI Release-missing plain text compatibility**: `gh release view`
  returns plain text `release not found` when the target release does not
  exist; the previous implementation only recognized an HTTP 404 exit code.
  The adapter now maps that specific plain text to a missing-release
  decision without misclassifying `repository not found` or permission
  errors as a target release absence.
- **Plugin consumer install verification transport semantics**: frozen
  snapshots are sealed as read-only, but Git and plugin installation
  transport restores owner write permission on extraction. Verification
  now normalizes ordinary write permission from transport semantics and
  continues to strictly verify path, type, content, size, and executable
  intent. The frozen source digest is still compared against the plan and
  must not be back-filled from observed results.

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
