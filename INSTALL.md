# Installation Guide

[简体中文](INSTALL.zh-CN.md)

<!-- release-skill:release-version: 0.1.10 -->
## Prerequisites

- Node.js 22.0.0 or later
- Git 2.30+

## Install from npm (recommended)

A public version is complete only after its immutable production plan has been
approved, published, and reached `VERIFIED`. For a newer source checkout, use
the npm path only after `npm view release-skill version` returns that exact
version; before then, use the source checkout instructions below.

```bash
npm install -g release-skill
CLI=(release-skill)
```

Or run directly without installing:

```bash
npx release-skill help
```

Verify:

```bash
release-skill --version
release-skill help
```

You should see the version number and the list of available commands.

## Install as a Kimi Code plugin

Kimi Code is a supported plugin host alongside Claude Code and Codex. The
Kimi Code plugin manifest lives at `.kimi-plugin/plugin.json`, mirroring
`.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, and the package
ships `adapters/kimi/` next to `adapters/claude/` and `adapters/codex/`.

Kimi Code has an interactive plugin marketplace but **no scriptable,
non-interactive install API**. release-skill therefore models Kimi installation
as a version-pinned **manual** install plus trusted observation/attestation:
`publish`/`verify` never auto-install Kimi plugins. The closed loop is:

1. `publish` performs the automated writes (Git branch/tag, npm, GitHub
   Release), then reaches the `kimi-marketplace-install` checkpoint. Because
   there is no scriptable install, that checkpoint **fails closed** and the run
   lands in `PARTIAL` — the successful automated writes are NOT undone. The
   checkpoint observation (and the requirement file below) gives the isolated
   `KIMI_CODE_HOME`, the pinned install URL, and the attestation path.
2. Read the requirement at
   `<root>/.release-skill/kimi-attestations/<planDigest>/<plugin>/release-skill-kimi-manual-install.json`.
3. Launch Kimi Code with that **isolated** home so the managed copy lands inside
   it (do not use your ordinary `~/.kimi-code`):

   ```
   HOME=<kimiCodeHome> KIMI_CODE_HOME=<kimiCodeHome> kimi
   ```

   The plugin installs to `<kimiCodeHome>/plugins/managed/<plugin>/`.
4. In that isolated session, install from the release tag pinned to the exact
   version (never the bare repository URL, which installs the latest release or
   default branch), confirm the trust prompt, then reload:

   ```
   /plugins install https://github.com/ifoohoo/release-skill/releases/tag/release-skill-v0.1.10
   /plugins reload
   ```

5. Write the attestation JSON to
   `<root>/.release-skill/kimi-attestations/<planDigest>/<plugin>/release-skill-kimi-attestation.json`.
   `planDigest` MUST be the frozen **plan** digest; `payloadDigest` MUST be the
   frozen snapshot **payload** digest; `installPath` MUST be the isolated
   managed directory above; `attestedAt` must not be in the future and
   `expiresAt` must be within 24 hours of `attestedAt`. Example:

```json
{
  "consumer": "kimi",
  "plugin": "release-skill",
  "version": "0.1.10",
  "entrySkill": "release-help",
  "repo": "ifoohoo/release-skill",
  "ref": "release-skill-v0.1.10",
  "installPath": "<kimiCodeHome>/plugins/managed/release-skill",
  "planDigest": "<64-hex frozen plan digest>",
  "payloadDigest": "<64-hex frozen snapshot payload digest>",
  "attestedBy": "<person responsible>",
  "attestedAt": "2026-07-23T00:00:00.000Z",
  "expiresAt": "2026-07-23T12:00:00.000Z"
}
```

6. Run `release-skill reconcile --run <publish-run>` (promotes `PARTIAL` →
   `PUBLISHED`) and then `release-skill verify --run <reconcile-run>` (→
   `VERIFIED`). Both read the attestation from the same plan-digest-keyed
   directory, so their fresh run directories do not lose the proof.

Installing into the ordinary `~/.kimi-code` is **not** acceptable proof: the
attested `installPath` must resolve inside the requirement's isolated
`KIMI_CODE_HOME` managed root, otherwise verification fails closed and the Kimi
unit never reaches `VERIFIED`.

## Development Install (Local Checkout)

For development or when working from source:

```bash
export RELEASE_SKILL_HOME=/absolute/path/to/release-skill
cd "$RELEASE_SKILL_HOME"
npm exec --yes pnpm@10.17.1 -- install --frozen-lockfile
```

Then use the CLI via:

```bash
CLI=(node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs")
"${CLI[@]}" help
```

After `npm view release-skill version` confirms the supported version is
published and installed, the equivalent npm entry is `CLI=(release-skill)`.

## First Run

The safest first command is always `help`. It runs entirely locally and
performs no writes. Use the `CLI` array selected by the npm or source-checkout
instructions above; do not mix the two entry paths in one run.

```bash
"${CLI[@]}" help
```

If `.release-skill/project.yaml` is absent, keep the full read-only report in a
temporary file and inspect only its deterministic `compactSummary`:

```bash
PROJECT=/path/to/your/project
SETUP_SESSION="$(mktemp -d "${TMPDIR:-/tmp}/release-setup.XXXXXX")"
REPORT="$SETUP_SESSION/discovery.json"
ANSWERS="$SETUP_SESSION/answers.json"
BOUND_REPORT="$SETUP_SESSION/bound.json"
printf 'SETUP_SESSION=%s\nPROJECT=%s\n' "$SETUP_SESSION" "$PROJECT"

"${CLI[@]}" setup --root "$PROJECT" --json > "$REPORT" || test "$?" -eq 2
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.compactSummary){console.error("compactSummary missing");process.exit(2)}process.stdout.write(JSON.stringify(r.compactSummary,null,2)+"\n")' "$REPORT"
```

The summary is a review view, not authorization; `setupDigest` binds the full
facts, candidates, and answers. If `proposalConflicts` is non-empty, a human
must correct the conflicting repository/mapping authority and rerun setup.
Do not guess. With no conflicts, mechanically extract the proposal:

```bash
SETUP_SESSION='/session-directory-absolute-path-printed-above'
PROJECT='/project-absolute-path-printed-above'
REPORT="$SETUP_SESSION/discovery.json"
ANSWERS="$SETUP_SESSION/answers.json"
BOUND_REPORT="$SETUP_SESSION/bound.json"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if((r.proposalConflicts??[]).length){console.error("proposal conflicts require human resolution");process.exit(2)}if(!r.recommendedAnswers){console.error("recommendedAnswers missing");process.exit(2)}fs.writeFileSync(process.argv[2],JSON.stringify(r.recommendedAnswers,null,2)+"\n",{flag:"wx",mode:0o600})' "$REPORT" "$ANSWERS"
"${CLI[@]}" setup --root "$PROJECT" --answers "$ANSWERS" --json > "$BOUND_REPORT"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.compactSummary||!r.setupDigest){console.error("bound setup report incomplete");process.exit(2)}process.stdout.write(JSON.stringify({compactSummary:r.compactSummary,setupDigest:r.setupDigest},null,2)+"\n")' "$BOUND_REPORT"
printf 'SETUP_SESSION=%s\nPROJECT=%s\n' "$SETUP_SESSION" "$PROJECT"
```

After one explicit human confirmation of the bound summary and exact digest,
create once with that confirmed digest literal. The result must be
`CONFIG_CREATED`; a second setup must be `ALREADY_CONFIGURED`, then run assess.

```bash
SETUP_SESSION=<session-directory-absolute-path-printed-above>
PROJECT=<project-absolute-path-printed-above>
ANSWERS="$SETUP_SESSION/answers.json"
CREATED_REPORT="$SETUP_SESSION/created.json"
POST_REPORT="$SETUP_SESSION/post-setup.json"
ASSESS_REPORT="$SETUP_SESSION/assess.json"
"${CLI[@]}" setup --root "$PROJECT" --answers "$ANSWERS" \
  --write --confirm-setup <confirmed-setupDigest> --json > "$CREATED_REPORT"
"${CLI[@]}" setup --root "$PROJECT" --json > "$POST_REPORT"
set +e
"${CLI[@]}" assess --root "$PROJECT" --offline --json > "$ASSESS_REPORT"
ASSESS_EXIT=$?
set -e
[ "$ASSESS_EXIT" -eq 0 ] || [ "$ASSESS_EXIT" -eq 1 ] || exit "$ASSESS_EXIT"
node -e 'const fs=require("node:fs");const [c,p,a]=process.argv.slice(1).map(x=>JSON.parse(fs.readFileSync(x,"utf8")));if(c.status!=="CONFIG_CREATED"||p.status!=="ALREADY_CONFIGURED"||!["ASSESSED","NEEDS_INPUT","BLOCKED"].includes(a.status)){process.exit(2)}process.stdout.write(JSON.stringify({created:c.status,postSetup:p.status,assessment:{status:a.status,summary:a.summary,gapCount:(a.gaps??[]).length,blockingCodes:(a.gaps??[]).filter(g=>g.severity==="error").map(g=>g.code)}},null,2)+"\n")' "$CREATED_REPORT" "$POST_REPORT" "$ASSESS_REPORT"
node -e 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:false})' "$SETUP_SESSION"
```

Indirect interpreter/package-manager scripts are `SIDE_EFFECTS_UNPROVEN` and
remain unselected. Register a project-specific hook/gate only through a reviewed
incremental edit: edit `projectConfig.hooks`, or edit `verificationGates` and
add the same id to `selectedGateIds`, then rerun the bound dry-run. Human files use `mode: preserve`; explicit cross-unit shared
sources use `sourceScope: workspace`.

### Advanced schema reference—not the first-run path

The following wrapper documents the schema. Do not hand-write it during normal
setup; use the mechanically extracted `recommendedAnswers`.

```json
{
  "projectConfig": {
    "apiVersion": "release-skill/v1",
    "kind": "ReleaseProject",
    "project": { "name": "my-project", "defaultBranch": "main" },
    "releaseUnits": [{
      "id": "my-project",
      "source": ".",
      "publicRepo": "owner/my-project",
      "version": { "source": "package.json", "tagTemplate": "v{version}" },
      "distributions": [{
        "type": "npm",
        "package": "my-project",
        "access": "public",
        "provenance": false,
        "tag": "latest",
        "registry": "https://registry.npmjs.org",
        "publisher": "my-npm-username"
      }],
      "publicFiles": [
        { "from": "README.md", "to": "README.md", "mode": "preserve" },
        { "from": "package.json", "to": "package.json", "mode": "preserve" }
      ],
      "requiredPublicFiles": ["README.md", "package.json"],
      "previousPublicBaseline": { "mode": "none" },
      "production": {
        "branchTemplate": "release/{tag}",
        "branchStrategy": "create-release-branch"
      }
    }]
  },
  "selectedGateIds": []
}
```

This wrapper is reference data only. Normal setup uses the machine proposal;
`mode: none` is valid only when no public version exists. When a reviewed gate
is added incrementally, its id must exactly match `selectedGateIds`, and a
snapshot gate plus its dependencies must be present in `publicFiles`. See the
[README setup section](README.md#first-use-deterministic-setup-without-loading-the-full-report).

An existing config is never regenerated or overwritten. A project with no
discoverable GitHub/npm channel reports `LOCAL_ONLY_DETECTED` rather than
claiming production readiness.

The automatic create-once write uses the digest-registered `darwin-arm64`
native prebuild shipped in v0.1.3. Other platforms fail closed with
`SAFE_WRITE_UNAVAILABLE`; keep the dry-run report and create the reviewed file
manually instead of enabling an unsafe pathname fallback.

After the config exists, check release readiness:

```bash
"${CLI[@]}" assess --root /path/to/your/project --offline --json
```

This command is read-only. It examines your project structure, configuration,
documentation, and supply chain, then outputs a gap report. Without an explicit
`--output`, `assess` writes no report file and never runs project hooks.

`prepare` is different: it writes release artifacts under the target project's
`.release-skill/` directory and may run configured hooks. Hooks are unsandboxed
arbitrary processes. They may write outside the project, access credentials,
use the network, or perform remote writes. Review the displayed executable,
arguments, and working directory before granting
`--acknowledge-hook-side-effects`.

For a Git repository, keep the human-owned project configuration while ignoring
generated authority and evidence:

```gitignore
.release-skill/*
!.release-skill/project.yaml
```

## Project Configuration

Create `.release-skill/project.yaml` in your project root. Here is a minimal
example for a single-package project:

```yaml
apiVersion: release-skill/v1
kind: ReleaseProject

project:
  name: my-project
  defaultBranch: main

releaseUnits:
  - id: my-project
    source: .
    publicRepo: owner/my-project
    version:
      source: package.json
      tagTemplate: v{version}
    distributions:
      - type: npm
        package: my-project
        access: public
        provenance: false
        tag: latest
        registry: https://registry.npmjs.org
        publisher: my-npm-username
    publicFiles:
      - from: README.md
        to: README.md
        mode: preserve
      - from: package.json
        to: package.json
        mode: preserve
      - from: LICENSE
        to: LICENSE
        mode: preserve
    requiredPublicFiles: [README.md, package.json, LICENSE]
    previousPublicBaseline:
      mode: none # only after confirming that no previous public version exists
```

### Advanced: hooks (optional)

Hooks are optional and run arbitrary local processes. They require explicit
`--acknowledge-hook-side-effects` authorization when used with `prepare`.

```yaml
hooks:
  build:
    command: [npm, run, build]
  test:
    command:
      - node
      - -e
      - "const p=require('./package.json'); if (!p.name) process.exit(1)"
```

See the [full README](README.md) for hook parameter constraints and safety
requirements.

### Advanced: verification gates (optional)

Use a `snapshot-verify` gate for checks that should run against a disposable
writable copy of the frozen public snapshot. Use `consumer-verify` for commands
that must run from an exact isolated npm/Claude/Codex/Kimi Code installation root. Gate
commands are executable arrays, not shell strings, and must declare unit,
distribution when applicable, cwd, timeout, and environment allowlist.

```yaml
verificationGates:
  - id: package-contract
    phase: snapshot-verify
    scope: { unit: my-project }
    command: [node, -e, "const p=require('./package.json');if(!p.name)process.exit(1)"]
    cwd: .
    timeoutMs: 30000
    envAllowlist: []
```

This self-contained example reads only a mapped public file. A replacement
script and every dependency it needs must exist in the frozen public snapshot;
the gate cannot borrow tests, development dependencies, or `node_modules` from
the parent workspace.

Prepare and verify require `--acknowledge-gate-side-effects` whenever their
planned phase contains gates. Hooks and gates are project processes without a
network sandbox; release-skill limits their inputs and evidence but cannot
guarantee that a custom command will not modify files or access the network.
Never register Git push, tag, default-branch changes, GitHub Releases, or npm
publish as a hook/gate; those are controlled plan actions.

### Advanced: release-document refresh (optional)

A release unit can declare `releaseDocuments` so one structured notes source
deterministically refreshes its managed README regions and the current
CHANGELOG entry. The command runs offline: it does not use the network, does
not call any large language model, and does not auto-translate. It only
rewrites declared managed regions, the unique version marker's machine
value, and the current CHANGELOG managed entry; every other byte is
preserved. `prepare` only checks freshness and never writes the working
tree.

```yaml
# Release unit fragment in .release-skill/project.yaml
releaseUnits:
  - id: my-project
    source: .
    releaseDocuments:
      notesSource: release-notes/{version}.yaml
      locales: [en, zh-CN]
      changelogs:
        - path: CHANGELOG.md
          locale: en
      readmes:
        - path: README.md
          locale: en
          regions: [latest-release]
          versionMarkers:
            - id: current-version
              pattern: '<!-- release-skill:version -->v{version}<!-- /release-skill:version -->'
        - path: README.zh-CN.md
          locale: zh-CN
          regions: [latest-release]
```

`notesSource` and every target path are relative to the release unit root;
`versionMarkers[].pattern` must match the README's existing unique version
marker exactly, and the refresh replaces only the machine version value.
The notes source lives under the release unit root; its `version` must
equal the resolved unit version, every configured locale appears exactly
once with a non-empty summary and at least one change category, and YAML
aliases, duplicate keys, unknown fields, and locale fallback all fail
closed:

```yaml
# release-notes/0.1.6.yaml
version: 0.1.6
date: 2026-07-21
locales:
  en:
    summary: Deterministic multilingual release-document refresh.
    changes:
      added:
        - Refresh managed README regions and changelogs from one source.
  zh-CN:
    summary: 从同一说明源确定性刷新多语种发布文档。
    changes:
      added:
        - 自动刷新 README 受管区域和 CHANGELOG。
```

Drill first (read-only), then write only with all three bindings:

```bash
"${CLI[@]}" docs refresh --root <your-project> --unit my-project --json
"${CLI[@]}" docs refresh --root <your-project> --unit my-project \
  --write --confirm-refresh <refreshDigest> --ack-local-document-write --json
```

`refreshDigest` binds the canonical notes object, the configuration
projection, and the sorted per-file old/new digests — never time, absolute
paths, or display text. A mismatched digest fails closed with
`RELEASE_DOCS_REFRESH_STALE` and writes nothing; an unchanged candidate
reports `clean` and writes nothing either. This authorization covers only
the declared local document targets; it does not authorize hooks, commits,
pushes, publishes, or installs. When `prepare` reports `RELEASE_DOCS_STALE`,
recover by running the drill, reviewing the listed files and locales,
performing the confirmed local write, reviewing and committing the result,
and rerunning `prepare`. See the README release-document refresh section
for the full contract.

### Production branch strategy

Every production unit selects one explicit strategy:

- `create-release-branch` creates an absent immutable release branch;
- `advance-existing-branch` fast-forwards an existing branch from the exact
  bound public baseline using an ordinary non-force push;
- `initialize-default-branch` creates an absent standard branch and may add an
  explicit default-branch action only when `setAsDefaultBranch` and
  `expectedCurrentDefaultBranch` are both reviewed.

Remote drift, a non-fast-forward update, or an unexpected default branch stops
for human intervention. No strategy overwrites remote history. Create-only refs
use `--force-with-lease=<ref>:` solely as an atomic absence assertion; advancing
an existing branch uses an ordinary non-force push.

```yaml
# create-release-branch: target must be absent
previousPublicBaseline: { mode: none } # true first public release only
production:
  branchTemplate: release/{tag}
  branchStrategy: create-release-branch
```

```yaml
# advance-existing-branch: ref must exactly equal refs/heads/<target>
previousPublicBaseline:
  mode: bound
  repo: owner/my-project
  ref: refs/heads/main
  commit: 0123456789abcdef0123456789abcdef01234567
production:
  branchTemplate: main
  branchStrategy: advance-existing-branch
```

```yaml
# initialize-default-branch: main must be absent; current default must match
previousPublicBaseline:
  mode: bound
  repo: owner/my-project
  ref: refs/heads/old-public-branch
  commit: 0123456789abcdef0123456789abcdef01234567
production:
  branchTemplate: main
  branchStrategy: initialize-default-branch
  setAsDefaultBranch: true
  expectedCurrentDefaultBranch: old-public-branch
```

The last two strategies require online production prepare. Any mismatch stops
for review; update the human-owned config only after inspecting real remote
state, and never force-push or weaken the baseline.

## Protect Human-Owned Content

README text, slogans, examples, layout, and other manually curated source files
remain authoritative. release-skill snapshots them according to each
`publicFiles` mapping; it does not regenerate or overwrite the source README.
After any manual edit, run `prepare` again and approve the new immutable plan.
Never edit a frozen snapshot or reuse an old approval to make later steps pass.

When an existing public copy has drifted, choose explicitly:

- **merge** — compare the actual remote content, merge accepted changes back
  into the human-owned source, then bind `previousPublicBaseline` to that exact
  immutable `repo`/`ref`/`commit` and prepare again;
- **adopt** — accept the remote copy as the new source of truth, first bring it
  into the human-owned source, then update the same immutable baseline binding
  and prepare again;
- **reject** — stop and investigate. Do not switch to `mode: none` to bypass a
  drift or uniqueness check.

## Next Steps

- Read the [full README](README.md) for the complete workflow guide.
- Run `"${CLI[@]}" setup --root <your-project> --json` when the project has no
  configuration; keep its default dry-run behavior until human decisions are complete.
- Run `"${CLI[@]}" assess --root <your-project> --offline` to evaluate your project's release readiness.
- Run `"${CLI[@]}" prepare --root <your-project> --offline` (release-skill pipeline writes
  locally only; user-configured hooks may perform remote operations) to generate
  a release plan.
- Before production, configure every unit's `previousPublicBaseline`. Use
  `mode: bound` with the exact `repo`, `ref`, and `commit` for an existing
  public version, then run `"${CLI[@]}" prepare --root <your-project> --online --production`.
  The default observer proves only the ref-to-commit mapping; remote content is
  not downloaded. Target branch/tag/Release/npm uniqueness is checked by the
  publish global preflight before any execute.
- For production commands, use only the immutable `planPath` returned by
  `prepare --json` and immutable `approvalPath` returned by `approve --json`.
  Mutable latest aliases are for convenience and are not production authority.
