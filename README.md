# release-skill

[简体中文](README.zh-CN.md) · Installation: [English](INSTALL.md) / [简体中文](INSTALL.zh-CN.md)

<!-- release-skill:release-version: 0.1.7 -->
Release preparation for Claude Code and Codex, with human-edited files kept intact.

release-skill helps a maintainer answer three questions: what will be released,
which checks still fail, and which exact bytes will reach users. It freezes the
reviewed artifacts first and publishes those same artifacts later; it does not
regenerate a README or re-pack the live workspace at the last step.

<!-- release-skill:managed:start id=latest-release -->
**0.1.7** (2026-07-23)

v0.1.7 is an organizational migration release. The public GitHub repository moves from `mzdbxqh/release-skill` to `ifoohoo/release-skill` (the repository name is unchanged and GitHub redirects the old URL), the project gains an explicit corporate maintainer and copyright holder (广州市风荷科技有限公司), and the forward-looking repository, maintainer, author, and copyright metadata across the npm package, plugin marketplace manifests, NOTICE, LICENSE, and release configuration are aligned with the new organization. The npm package name (`release-skill`) and the npm publishing identity (`publisher: mzdbxqh`) are unchanged, and the already-published v0.1.6 tag, GitHub Release, and npm version are not rewritten.

**Changed**

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
<!-- release-skill:managed:end id=latest-release -->

<!-- release-skill:capability:external-write-boundary -->
> **Current boundary:** v0.1.7 is the current release (v0.1.6 previously held
> this status after completing real production verification).
> v0.1.1 completed a real production release to GitHub and npm — the first
> production-verified milestone — followed by
> exact npm installation and Claude/Codex consumer installation verification
> from the frozen Git ref; "current release" and "first production-verified
> milestone" are two distinct facts and must not be conflated. The same
> workflow also has a local production-equivalent protocol suite using the
> real release-skill CLI and frozen artifacts, local bare Git remotes, and
> protocol fakes for `gh`, `npm`, Claude, and Codex. The suite does not
> provide OS-level network isolation, and it does not prove that another
> project's credentials, permissions, rate limits, or eventual-consistency
> behavior will match this release. Treat each project's first production run
> as a monitored canary. `prepare --online` observes bound previous-public
> baselines and fails closed on drift; remote uniqueness checks run during
> publish global preflight.

<!-- release-skill:capability:safe-first-command -->
> **Production path verified since the v0.1.1 milestone; v0.1.7 is the current
> release.** The npm-installed CLI is the supported user entry. Source checkout
> is the development/contributor fallback.
>
> **Start here:**
> - npm install: `npm install -g release-skill` → `release-skill help`
> - source checkout: `node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs" help`

<!-- release-skill:maturity:v0.1-boundary -->
<!-- release-skill:maturity:boundary -->
> **Safe defaults:** the recommended path is `help → assess → prepare --offline →
> human review`. Production publishing adds `prepare --production → approve →
> publish --confirm-production <planDigest>`; a `bound` previous-public baseline
> specifically requires `prepare --online --production`. Without digest confirmation,
> no remote preflight or write starts.

## Why this is safe for a hand-edited README

release-skill does not regenerate or rewrite project source files. `prepare` copies
each configured public file from the current workspace into an isolated local
snapshot and verifies the copied bytes. That includes the complete README:
slogans, examples, prose, formatting, and later human edits.

- A later prepare reads the current file again; it does not rebuild it from a template.
- The snapshot must match the source bytes exactly.
- A changed plan gets a new digest, so an old approval cannot authorize it.
- A source edit after prepare makes publish stop before remote writes. Preserve
  the edit by preparing, reviewing, and approving a new plan.
- Tampering with a frozen snapshot, Git object, or tarball fails its digest gate.
- Existing remote branches, tags, releases, or npm versions require human
  intervention; the tool does not force or overwrite them.
- Only files listed in `publicFiles` are copied. Add translated READMEs, images,
  demos, and linked documents explicitly when they belong in the release.
- A release freezes only the current truth: `prepare` never refreshes or
  rewrites human docs. Maintainers update README, INSTALL, and CHANGELOG first
  — including the machine-readable `release-skill:release-version` markers,
  which must equal the `package.json` version, and the formal CHANGELOG
  heading for the current version — then prepare, review, and approve. A
  pre-release gate fails closed when any doc version marker or the CHANGELOG
  current-version entry drifts.

This is the preservation contract: **copy current truth, freeze reviewed
truth, and never rewrite human truth.**

## Quick start

Every read-only step below keeps potentially large reports in temporary files
and surfaces only the deterministic `compactSummary` review view; the summary
is a review aid, never a substitute for the bound digest authorization.

### Install / requirements

- Node.js 22+
- Git 2.30+
- A target Git repository with at least one commit

**Install from npm (recommended):**

```bash
npm install -g release-skill
```

Or run directly without installing:

```bash
npx release-skill help
```

**Verify the install:**

```bash
release-skill help
```

**Development install (contributor fallback, from source checkout):**

Set the checkout location and install dependencies:

```bash
export RELEASE_SKILL_HOME=/absolute/path/to/release-skill
cd "$RELEASE_SKILL_HOME"
npm exec --yes pnpm@10.17.1 -- install --frozen-lockfile
```

Then use the CLI via `node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs"`.

First keep local plans, approvals, and frozen artifacts out of Git:

```gitignore
.release-skill/*
!.release-skill/project.yaml
```

### First use: deterministic setup without loading the full report

Setup is read-only by default. Keep its potentially large report in temporary
files; show the user or Agent only the deterministic `compactSummary` review
view. The summary does not replace authorization: `setupDigest` still binds the
complete facts, candidates, and answers.

```bash
PROJECT=/absolute/path/to/my-project
SETUP_SESSION="$(mktemp -d "${TMPDIR:-/tmp}/release-setup.XXXXXX")"
REPORT="$SETUP_SESSION/discovery.json"
ANSWERS="$SETUP_SESSION/answers.json"
BOUND_REPORT="$SETUP_SESSION/bound.json"
printf 'SETUP_SESSION=%s\nPROJECT=%s\n' "$SETUP_SESSION" "$PROJECT"

release-skill setup --root "$PROJECT" --json > "$REPORT" || test "$?" -eq 2
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.compactSummary){console.error("compactSummary missing");process.exit(2)}process.stdout.write(JSON.stringify(r.compactSummary,null,2)+"\n")' "$REPORT"
```

`NEEDS_INPUT` and `LOCAL_ONLY_DETECTED` intentionally exit with code 2. If
`proposalConflicts` is non-empty—including `PUBLIC_REPO_AUTHORITY_CONFLICT` or
a public-file mapping conflict—stop and let a human correct the conflicting
repository or mapping authority, then rerun setup. Do not guess a winner.

With no conflicts, copy the machine proposal mechanically. The Agent must not
rewrite or transcribe it:

```bash
SETUP_SESSION='/session-directory-absolute-path-printed-above'
PROJECT='/project-absolute-path-printed-above'
REPORT="$SETUP_SESSION/discovery.json"
ANSWERS="$SETUP_SESSION/answers.json"
BOUND_REPORT="$SETUP_SESSION/bound.json"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if((r.proposalConflicts??[]).length){console.error("proposal conflicts require human resolution");process.exit(2)}if(!r.recommendedAnswers){console.error("recommendedAnswers missing");process.exit(2)}fs.writeFileSync(process.argv[2],JSON.stringify(r.recommendedAnswers,null,2)+"\n",{flag:"wx",mode:0o600})' "$REPORT" "$ANSWERS"

release-skill setup --root "$PROJECT" --answers "$ANSWERS" --json > "$BOUND_REPORT"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.compactSummary||!r.setupDigest){console.error("bound setup report incomplete");process.exit(2)}process.stdout.write(JSON.stringify({compactSummary:r.compactSummary,setupDigest:r.setupDigest},null,2)+"\n")' "$BOUND_REPORT"
printf 'SETUP_SESSION=%s\nPROJECT=%s\n' "$SETUP_SESSION" "$PROJECT"
```

Review that bound summary and exact digest once. After explicit human
confirmation, use the confirmed digest literal to create the configuration:

```bash
SETUP_SESSION=<session-directory-absolute-path-printed-above>
PROJECT=<project-absolute-path-printed-above>
ANSWERS="$SETUP_SESSION/answers.json"
CREATED_REPORT="$SETUP_SESSION/created.json"
POST_REPORT="$SETUP_SESSION/post-setup.json"
ASSESS_REPORT="$SETUP_SESSION/assess.json"
release-skill setup --root "$PROJECT" --answers "$ANSWERS" \
  --write --confirm-setup <confirmed-setupDigest> --json > "$CREATED_REPORT"
release-skill setup --root "$PROJECT" --json > "$POST_REPORT"
set +e
release-skill assess --root "$PROJECT" --offline --json > "$ASSESS_REPORT"
ASSESS_EXIT=$?
set -e
[ "$ASSESS_EXIT" -eq 0 ] || [ "$ASSESS_EXIT" -eq 1 ] || exit "$ASSESS_EXIT"
node -e 'const fs=require("node:fs");const [c,p,a]=process.argv.slice(1).map(x=>JSON.parse(fs.readFileSync(x,"utf8")));if(c.status!=="CONFIG_CREATED"||p.status!=="ALREADY_CONFIGURED"||!["ASSESSED","NEEDS_INPUT","BLOCKED"].includes(a.status)){process.exit(2)}process.stdout.write(JSON.stringify({created:c.status,postSetup:p.status,assessment:{status:a.status,summary:a.summary,gapCount:(a.gaps??[]).length,blockingCodes:(a.gaps??[]).filter(g=>g.severity==="error").map(g=>g.code)}},null,2)+"\n")' "$CREATED_REPORT" "$POST_REPORT" "$ASSESS_REPORT"
node -e 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:false})' "$SETUP_SESSION"
```

The write must return `CONFIG_CREATED`; the next setup must return
`ALREADY_CONFIGURED`. Existing configuration is never regenerated—make only
reviewed incremental edits. Discovered interpreter/package-manager scripts are
`SIDE_EFFECTS_UNPROVEN` and are not selected automatically. Add a project-specific
hook or gate only after human review: edit `projectConfig.hooks`, or edit
`verificationGates` and add the same id to `selectedGateIds`, then rerun the
bound dry-run. Keep human files at `mode: preserve`, and
use `sourceScope: workspace` only for explicit cross-unit shared sources.

#### Advanced schema reference—not the first-use path

The wrapper below illustrates the schema only. Do not hand-write it during the
normal setup path; mechanically extract `recommendedAnswers` as shown above.

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

This is a schema reference, not an onboarding template. Normal setup must use
the machine proposal. `mode: none` is valid only when no public version exists.

The following reference shows the exact relationship between a manually
reviewed gate and `selectedGateIds`. Apply that relationship only as an
incremental edit to the extracted machine proposal:

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
        { "from": "package.json", "to": "package.json", "mode": "preserve" }
      ],
      "requiredPublicFiles": ["package.json"],
      "previousPublicBaseline": { "mode": "none" },
      "production": {
        "branchTemplate": "release/{tag}",
        "branchStrategy": "create-release-branch"
      }
    }],
    "verificationGates": [{
      "id": "my-project-script-test",
      "phase": "snapshot-verify",
      "scope": { "unit": "my-project" },
      "command": ["node", "-e", "const p=require('./package.json');if(!p.name)process.exit(1)"],
      "cwd": ".",
      "timeoutMs": 30000,
      "envAllowlist": []
    }]
  },
  "selectedGateIds": ["my-project-script-test"]
}
```

The id must be copied from the current `gateCandidates`; do not invent one.
The example command is self-contained in the public snapshot. A project script
is valid only when the script and every dependency it needs are included in
`publicFiles`; a snapshot gate cannot see the parent workspace's tests,
development dependencies, or `node_modules` unless they are explicitly public.

```bash
release-skill setup --root /absolute/path/to/my-project \
  --answers /absolute/path/to/setup-answers.json --json
release-skill setup --root /absolute/path/to/my-project \
  --answers /absolute/path/to/setup-answers.json \
  --write --confirm-setup <setupDigest> --json
```

Setup atomically creates only an absent `.release-skill/project.yaml`.
That create-once step uses the digest-registered `darwin-arm64` native
prebuild shipped in v0.1.3; unsupported platforms fail closed with
`SAFE_WRITE_UNAVAILABLE` instead of falling back to path-based writes.
`ALREADY_CONFIGURED`/`CONFIG_EXISTS` means the existing file remains
human-owned and must be edited incrementally. README, slogans, CHANGELOG, and
business scripts are never generated or overwritten. A project with no remote
channel reports `LOCAL_ONLY_DETECTED` instead of inventing production support.

The following is a minimal human-authored configuration. npm visibility,
public-file boundaries, and remote targets must be explicit:

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
    requiredPublicFiles: [README.md, LICENSE, package.json]
    previousPublicBaseline:
      mode: none              # first release: no prior public version exists
    distributions:
      - type: npm
        package: my-project
        access: public       # or restricted; choose the real package policy
        provenance: false    # use true only after CI/OIDC is configured
        tag: latest
        registry: https://registry.npmjs.org
        publisher: my-npm-username
        # Optional: CLI smoke verification. When smokeBin is set, verify
        # installs the package in an isolated directory and runs the named
        # binary. Without smokeBin, verify only confirms install + name/version.
        # smokeBin: my-project
        # smokeArgs: [help, --json]
        # smokeExpectedJson:
        #   command: help
        #   status: READY
    production:
      branchTemplate: release/{tag}
      branchStrategy: create-release-branch
      releaseTitleTemplate: "{unit} {version}"
      releaseNotes: "Human-maintained release notes"
```

Every release unit must declare its previous public baseline. Use `mode: none`
only when you have verified that no earlier public version exists. For an
existing public repository, bind the exact immutable ref and commit instead:

```yaml
    previousPublicBaseline:
      mode: bound
      repo: owner/my-project
      ref: release/v0.9.0
      commit: 0123456789abcdef0123456789abcdef01234567
```

`none` is not a conflict-check bypass: publish still checks target branch,
tag, GitHub Release, and npm version uniqueness before any write. A bound
production prepare must run online so the ref-to-commit mapping can be observed.
The default observer does not download remote file contents, so it reports a
mapping diff and marks content diff unavailable. On drift, stop and choose
`merge`, `adopt`, or `reject` manually. First obtain and review the actual remote
commit; the tool does not download or merge its files. `merge` keeps both local
and remote edits in the human-owned source. `adopt` copies the reviewed remote
bytes into that source. `reject` stops the release while the remote/ref is
investigated or corrected; never switch to `mode: none` to bypass the drift.
After `merge` or `adopt`, rebind `previousPublicBaseline` to the accepted
immutable `repo`/`ref`/`commit`, then run a new `prepare --online --production`,
review, and approval.

Choose a branch strategy that matches the real repository:

- `create-release-branch` creates an absent immutable release branch and stops
  if the name already exists.
- `advance-existing-branch` creates a single-parent commit on the exact
  `previousPublicBaseline` commit and permits only an ordinary fast-forward
  push; concurrent drift requires human intervention.
- `initialize-default-branch` creates an absent standard branch under control.
  Only explicit `setAsDefaultBranch` and `expectedCurrentDefaultBranch` values
  add a separately approved, observed, and reconcilable default-branch action.

Minimal configurations for the three strategies are:

```yaml
# New immutable release branch; the target must not exist.
previousPublicBaseline: { mode: none } # only for a true first public release
production:
  branchTemplate: release/{tag}
  branchStrategy: create-release-branch
```

```yaml
# Advance main; the bound ref must be exactly the target branch.
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
# One-time creation of an absent main and an explicit default-branch switch.
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

The latter two require `prepare --online --production`. If the observed branch,
commit, target absence, or current default branch differs, stop and update the
human-owned source/config only after reviewing the real remote state; never
force-push or weaken the baseline.

This is a mechanics-only local example, not a complete npm publication map.
Before a real release, enumerate every public runtime file, executable, type
declaration, image, and linked document. In a monorepo, set `source` to a path
such as `packages/my-plugin`, and keep each `from` path relative to the workspace
root, for example `packages/my-plugin/README.md`.

Before the first prepare, preferably commit `.gitignore`, `.release-skill/project.yaml`,
the README, version files, and all intended release content so the Git baseline
is easy to reproduce. Uncommitted edits that already exist at prepare time and
remain unchanged are included in the snapshot/baseline; only a later change
causes baseline validation to stop.

### Main workflow

Run these steps in order. Steps 1–4 are safe default (read-only or local-only);
steps 5–9 are production publishing with explicit human gates.

```bash
# npm-installed CLI (recommended):
CLI=(release-skill)
PROJECT=/absolute/path/to/my-project
ACTOR=your-name
# Development fallback (source checkout):
# CLI=(node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs")
```

The npm-installed CLI is the supported user entry after v0.1.1 production
publication. The source checkout remains the development/contributor fallback.

1. **Environment check:**
   ```bash
   "${CLI[@]}" help
   ```
2. **First-use setup (only when config is absent; read-only):**
   ```bash
   "${CLI[@]}" setup --root "$PROJECT" --json
   ```
   Follow the mechanical `compactSummary` and `recommendedAnswers` path above;
   confirm the bound `setupDigest` once, and skip this step when configuration exists.
3. **Readiness assessment (read-only):**
   ```bash
   "${CLI[@]}" assess --root "$PROJECT" --offline --json
   ```
4. **Local snapshot and plan freeze:**
   ```bash
   "${CLI[@]}" prepare --root "$PROJECT" --offline \
     --acknowledge-hook-side-effects \
     --acknowledge-gate-side-effects --json
   ```
   Omit an acknowledgement only when that project config has no corresponding
   hook or snapshot gate. Never grant either acknowledgement before reviewing
   the configured executable, arguments, working directory, and side effects.
5. **Human review:** inspect the returned `planPath`, `externalActions`,
   `units[].targetVersion`, and `planDigest`. Each unit's snapshot is under
   `<evidenceDir>/snapshots/<unit-id>/`. The release-skill pipeline writes its
   own data under `.release-skill/`; acknowledged project hooks and gates are
   arbitrary project processes without an operating-system sandbox and may
   write elsewhere, access the network, and read any credentials, tokens,
   keys, and environment variables accessible to the current account.
6. **Production plan freeze:**
   ```bash
   PRODUCTION_JSON=$("${CLI[@]}" prepare --root "$PROJECT" --online --production \
     --acknowledge-hook-side-effects \
     --acknowledge-gate-side-effects --json)
   printf '%s\n' "$PRODUCTION_JSON" | jq .
   PLAN_PATH=$(printf '%s\n' "$PRODUCTION_JSON" | jq -r '.planPath')
   PLAN_DIGEST=$(printf '%s\n' "$PRODUCTION_JSON" | jq -r '.planDigest')
   ```
   As above, omit only acknowledgements that are not required by the project
   config, and review every configured process before granting them.
   Review the new plan's externalActions, npm policy, branch/tag, and frozen
   digests. `prepare --json` returns the immutable production authority as
   `<project>/.release-skill/plans/<planDigest>.json`; always carry that returned
   `planPath` forward. `.release-skill/release-plan.json` is only a mutable
   convenience alias and must not be passed to production approve/publish/reconcile.
7. **Approval:**
   ```bash
   APPROVAL_JSON=$("${CLI[@]}" approve --plan "$PLAN_PATH" \
     --digest "$PLAN_DIGEST" --actor "$ACTOR" --json)
   printf '%s\n' "$APPROVAL_JSON" | jq .
   APPROVAL_PATH=$(printf '%s\n' "$APPROVAL_JSON" | jq -r '.approvalPath')
   ```
   Returns the immutable production authority as `approvalPath` at
   `<project>/.release-skill/approvals/<planDigest>/<approvalDigest>.json`.
   `latestApprovalPath` points to `.release-skill/approval-record.json`, which is
   only a mutable convenience alias and must not be passed to production
   publish/reconcile. Approval expires after 24
   hours; a PARTIAL recovery may create a new approval for the same plan while
   preserving every earlier approval byte-for-byte. Use the returned
   `approvalPath` and `expiresAt` as authority. `--actor` is only an
   unauthenticated local audit label: release-skill performs no identity
   authentication and provides no digital signature, so it cannot prove that
   a real human actually approved — it only records the identity the operator
   self-reports.
8. **Publish (remote writes start here):**
   ```bash
   PUBLISH_JSON=$("${CLI[@]}" publish --root "$PROJECT" \
     --plan "$PLAN_PATH" --approval "$APPROVAL_PATH" \
     --confirm-production "$PLAN_DIGEST" --json)
   printf '%s\n' "$PUBLISH_JSON" | jq .
   PUBLISH_RUN_PATH=$(printf '%s\n' "$PUBLISH_JSON" | jq -r '.runPath')
   ```
   Save the returned `runPath`. `PUBLISHED` is **not** the terminal state.
9. **Verify (consumer install check):**
   ```bash
   "${CLI[@]}" verify --root "$PROJECT" \
     --plan "$PLAN_PATH" --run "$PUBLISH_RUN_PATH" \
     --acknowledge-gate-side-effects --json
   ```
   Omit the acknowledgement only when the plan has neither consumer gates nor
   a configured npm `smokeBin`. Both execute installed project code without an
   OS or network sandbox.

The handoff example requires `jq`. Without it, copy the same four returned JSON
fields exactly; do not pass the angle-bracket labels shown elsewhere as shell
syntax.

Production prepare seals a standalone Git commit/tree for every public snapshot
and creates a fixed tarball for every npm unit. Publish globally preflights all
actions, then executes and observes public branch, tag, npm, GitHub Release,
and configured Claude/Codex marketplace installation checkpoints. `verify`
installs every exact npm `package@version` in an isolated directory; when
`smokeBin` is configured it also runs the CLI and validates output. Only when
all evidence matches does the run reach `VERIFIED`.
Before a real release run `gh auth login`, `gh auth setup-git`, and
`npm login`, and confirm Git HTTPS credentials can access the target repository.
Version branches default to `release/<tag>` and can be configured per unit with
`production.branchTemplate`; any existing remote object stops for human review.

### Release-document refresh (optional)

A release unit can declare `releaseDocuments` so one structured, bilingual
notes source deterministically refreshes the managed README regions and the
current CHANGELOG entry. The core CLI runs entirely offline: it does not use
the network, does not call any large language model, and does not
auto-translate. It only rewrites the declared managed regions, the unique
version marker's machine value, and the current CHANGELOG managed entry;
every byte outside those regions is preserved verbatim. `prepare` only
checks freshness and never writes the working tree.

```yaml
# .release-skill/project.yaml (release unit fragment)
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

`notesSource` and every target path are relative to the release unit root.
`versionMarkers[].pattern` must match the README's existing unique version
marker exactly, with `{version}` standing in for the machine value; the
refresh replaces only that value (zero or multiple matches fail closed).

```yaml
# release-notes/0.1.6.yaml (structured notes source)
version: 0.1.6
date: 2026-07-21
locales:
  en:
    summary: Deterministic multilingual release-document refresh.
    changes:
      added:
        - Refresh managed README regions and changelogs from one source.
    upgradeNotes: Review and commit refreshed documents before prepare.
  zh-CN:
    summary: 从同一说明源确定性刷新多语种发布文档。
    changes:
      added:
        - 自动刷新 README 受管区域和 CHANGELOG。
    upgradeNotes: prepare 前审阅并提交刷新结果。
```

`version` must exactly equal the resolved unit version; every configured
locale appears exactly once with a non-empty `summary` and at least one
change under `security`, `breaking`, `added`, `changed`, `deprecated`,
`removed`, or `fixed`. YAML aliases, duplicate keys, unknown fields, and
locale fallback all fail closed.

1. **Read-only drill:**
   ```bash
   "${CLI[@]}" docs refresh --root "$PROJECT" --unit my-project --json
   ```
   Prints `status` (`changes` or `clean`), per-file relative `path`,
   `locale`, `kind`, old/new digests, the unit `version`, `locales`,
   `inputDigest`, and `refreshDigest` — a binding over the protocol
   version, the unit, the canonical notes object, the configuration
   projection, and the sorted per-file old/new digests. It never binds
   time, absolute paths, or display text. `nextCommand.argv` carries the
   exact write command.
2. **Digest-confirmed local write (only after explicit human authorization
   of the local release-document write):**
   ```bash
   "${CLI[@]}" docs refresh --root "$PROJECT" --unit my-project \
     --write --confirm-refresh <refreshDigest> \
     --ack-local-document-write --json
   ```
   All three bindings are required; a mismatched digest fails closed with
   `RELEASE_DOCS_REFRESH_STALE` and writes nothing. When the candidate is
   unchanged the drill reports `clean` and the write performs zero writes.
   All targets commit as one transaction; a successful write is followed
   by a re-drill that must return `clean`.

This authorization covers only the declared local document targets. It is
not authorization for hooks, Git commits, pushes, publishes, or installs:
a maintainer must review the refreshed documents, commit them, and rerun
`prepare` — the new bytes change the snapshot, workspace digest, and plan
digest, so an earlier approval cannot authorize the refreshed plan.

When configured documents drift, `prepare` fails closed with
`RELEASE_DOCS_STALE` before hooks, baseline, snapshot, remote checks, and
plan freeze. Recovery: run the drill, review the shown files/locales/
version/digest, authorize and perform the local write, review and commit
the result, then rerun `prepare`. `RELEASE_DOCS_INVALID` (bad
configuration or notes data), `RELEASE_DOCS_TRANSLATION_MISSING` (a
configured locale absent), and `RELEASE_DOCS_CONFLICT` (unmanaged
same-version content or marker damage) each require fixing the source or
target first; never widen the write scope to resolve them.

### Parent workspace with npm + plugin sub-units

When a monorepo produces both an npm package and a Claude/Codex plugin from
different directories, define separate release units. Only add a plugin
distribution when the unit actually ships a plugin with manifest, marketplace,
and entry Skill:

Here `project` is the parent workspace's orchestration container, not a public
release unit. If the workspace root also publishes its own repository or
package, add another release unit with `source: .`.
`version.source` is resolved relative to that release unit's `source` directory
(`version.source` 相对于该发布单元的 `source` 目录解析): a unit with
`source: packages/app` therefore writes plain `package.json`, not
`packages/app/package.json`.

```yaml
apiVersion: release-skill/v1
kind: ReleaseProject
project:
  name: my-workspace
  defaultBranch: main

releaseUnits:
  - id: my-app
    source: packages/app
    publicRepo: owner/my-app
    version:
      source: package.json
      tagTemplate: my-app-v{version}
    distributions:
      - type: npm
        package: my-app
        access: public
        provenance: false
        tag: latest
        registry: https://registry.npmjs.org
        publisher: my-npm-username
        smokeBin: my-app
        smokeArgs: [help, --json]
        smokeExpectedJson:
          command: help
          status: READY
    publicFiles:
      - from: packages/app/README.md
        to: README.md
        mode: preserve
      - from: packages/app/package.json
        to: package.json
        mode: preserve
      - from: packages/app/LICENSE
        to: LICENSE
        mode: preserve
    requiredPublicFiles: [README.md, package.json, LICENSE]
    previousPublicBaseline:
      mode: none
    production:
      branchTemplate: release/{tag}
      releaseTitleTemplate: "{unit} {version}"

  - id: my-plugin
    source: packages/plugin
    publicRepo: owner/my-plugin
    version:
      source: package.json
      tagTemplate: my-plugin-v{version}
    distributions:
      # Declare plugin consumers only when the unit ships a plugin.
      # The CLI smoke is independent; only declare smokeBin when the plugin
      # package also exposes a CLI binary.
      - type: claude-plugin
        plugin: my-plugin
        marketplace: my-plugin
        entrySkill: my-plugin-help
        timeoutMs: 300000     # optional; range 30000-900000; default 300000
      - type: codex-plugin
        plugin: my-plugin
        marketplace: my-plugin
        entrySkill: my-plugin-help
        timeoutMs: 300000     # optional; range 30000-900000; default 300000
    publicFiles:
      - from: packages/plugin/.claude-plugin/plugin.json
        to: .claude-plugin/plugin.json
        mode: preserve
      - from: packages/plugin/.claude-plugin/marketplace.json
        to: .claude-plugin/marketplace.json
        mode: preserve
      - from: packages/plugin/.codex-plugin/plugin.json
        to: .codex-plugin/plugin.json
        mode: preserve
      - from: packages/plugin/.agents/plugins/marketplace.json
        to: .agents/plugins/marketplace.json
        mode: preserve
      - from: packages/plugin/skills/my-plugin-help/SKILL.md
        to: skills/my-plugin-help/SKILL.md
        mode: preserve
      - from: packages/plugin/README.md
        to: README.md
        mode: preserve
      - from: packages/plugin/package.json
        to: package.json
        mode: preserve
      - from: packages/plugin/LICENSE
        to: LICENSE
        mode: preserve
    requiredPublicFiles:
      - .claude-plugin/plugin.json
      - .claude-plugin/marketplace.json
      - .codex-plugin/plugin.json
      - .agents/plugins/marketplace.json
      - skills/my-plugin-help/SKILL.md
      - README.md
      - package.json
      - LICENSE
    previousPublicBaseline:
      mode: none
    production:
      branchTemplate: release/{tag}
      releaseTitleTemplate: "{unit} {version}"
```

Each plugin unit **must** list its Claude/Codex `plugin.json`, `marketplace.json`,
the entry Skill, and all required public files. A CLI smoke (`smokeBin`) is
optional for plugin units and only applies when the published npm package
exposes a CLI binary.

Plugin distributions may declare `timeoutMs` (range 30,000--900,000 ms; default
300,000 ms). This sets the subprocess timeout for the marketplace add, plugin
install, and plugin list commands. On real networks these commands can take
40--105 seconds; the default 300-second timeout avoids false `PARTIAL` failures.
The resolved value is frozen into the plan and approved along with all other
action parameters. Old plans without `timeoutMs` default to 300,000 ms at
execution time for backward compatibility.

### PARTIAL recovery and reconcile

When `publish` succeeds at some checkpoints but fails at others, the run enters
`PARTIAL` status. **Do not restart from scratch and do not delete remote state**
(e.g., do not delete a tag that was already pushed, or unpublish a package).

Instead, use `reconcile` to inspect actual remote state, skip already-consistent
steps, and safely retry incomplete actions:

```bash
RECONCILE_JSON=$("${CLI[@]}" reconcile --root "$PROJECT" \
  --run "$PUBLISH_RUN_PATH" \
  --plan "$PLAN_PATH" \
  --approval "$APPROVAL_PATH" \
  --confirm-production "$PLAN_DIGEST" --json)
printf '%s\n' "$RECONCILE_JSON" | jq .
RECONCILE_RUN_PATH=$(printf '%s\n' "$RECONCILE_JSON" | jq -r '.runPath')
# Save reconcile's new runPath, then perform the fresh install verification.
"${CLI[@]}" verify --root "$PROJECT" \
  --plan "$PLAN_PATH" --run "$RECONCILE_RUN_PATH" \
  --acknowledge-gate-side-effects --json
```

Omit the verify acknowledgement only when the frozen plan has neither consumer
gates nor an npm `smokeBin`. The variables above are the exact values captured
by the main flow; if approval expired during recovery, create a fresh approval
for the same immutable plan and replace `APPROVAL_PATH` before reconcile.

`reconcile` queries the actual remote state (Git refs, npm version, GitHub
Release, marketplace install), skips any step whose evidence already matches
the frozen plan, and retries only safe and incomplete steps. Remote conflicts
(e.g., an unexpected tag or npm version) require human decision and cannot be
auto-resolved.
Successful reconcile returns `PUBLISHED`, not `VERIFIED`; only the fresh
`verify` run may produce the terminal `VERIFIED` state.

## Accepted capabilities

- validates project configuration and release units;
- reports readiness without changing the project during `assess`;
- copies configured public files into an isolated snapshot;
- discovers first-use candidates read-only and creates a config only once after
  exact `setupDigest` confirmation;
- runs human-selected project gates in frozen-snapshot copies and exact
  consumer installation roots;
- checks required files, path safety, exact bytes/modes, and obvious leaks;
- records Git/workspace identity and freezes a digest-bound release plan;
- binds approval to the plan digest, expiry, and explicit action allowlist;
- publishes only frozen Git objects and npm tarballs, then checks remote
  commit/tree/tag/integrity;
- installs configured Claude/Codex plugins from the frozen Git ref and proves
  the entry Skill and payload digest in fresh isolated consumer homes;
- distinguishes `PUBLISHED` (writes completed) from `VERIFIED` (remote and
  consumer installation evidence completed);
- stops subsequent checkpoints on failure and writes a separate run record
  without mutating the frozen plan or undoing successful remote actions.

## Project-specific verification: hooks and gates

`hooks.docs/build/test/typecheck/lint` run before the snapshot is frozen. Use
them only for work that genuinely needs the parent workspace or generates
source files. They can modify files or access the network, so prepare requires
`--acknowledge-hook-side-effects`.

Each hook is an object, never a bare command list.
`command` is an executable/argument array, not a shell string
(`command` 是可执行文件/参数数组，不是 shell 字符串). Each hook also declares
`cwd`, `timeoutMs`, and `envAllowlist`:

```yaml
hooks:
  build:
    command: [node, scripts/build.mjs]
    cwd: .
    timeoutMs: 120000
    envAllowlist: [CI]
  test:
    command: [node, --test, test/]
    cwd: .
    timeoutMs: 300000
    envAllowlist: []
```

Hooks still run only after human review of every configured executable,
argument, working directory, and side effect, and only with
`prepare --acknowledge-hook-side-effects`.

`verificationGates` are the controlled extension point for release calibration:

```yaml
verificationGates:
  - id: package-contract
    phase: snapshot-verify
    scope: { unit: my-project }
    command:
      - node
      - -e
      - "const p=require('./package.json'); if (!p.name) process.exit(1)"
    cwd: .
    timeoutMs: 120000
    envAllowlist: [CI]
  - id: installed-help
    phase: consumer-verify
    scope: { unit: my-project, distribution: npm }
    command: [node, scripts/check-installed-help.mjs]
    cwd: .
    timeoutMs: 30000
    envAllowlist: []
    expectedJson: { status: READY }
```

The snapshot example is deliberately self-contained and reads only a mapped
public file. Any replacement script and every dependency it needs must exist
in the frozen public snapshot. The consumer script must likewise be present in
the exact installed distribution; gates cannot borrow tests, development
dependencies, or `node_modules` from the parent workspace.

`snapshot-verify` runs in a disposable writable copy of the frozen public
snapshot. `consumer-verify` runs from an exact isolated npm/Claude/Codex install
root. Both use executable arrays instead of shell strings; definitions and
results enter digest-bound evidence, and prepare/verify require
`--acknowledge-gate-side-effects`. Gates are still project processes without a
network sandbox, so release-skill cannot promise that they will not write files
or access the network. Push, tag, default-branch changes, GitHub Releases, and
npm publish may never be hooks/gates; they remain controlled plan actions.

## What it does not do yet

<!-- release-skill:capability:unsupported-scope -->
- no automatic README generation or source-file overwrite;
- no automatic conflict merge or rollback workflow;
- no claim that a real production canary has run for marketplace verification;
- `prepare --online` observes previous public baselines (bound mode) and defers
  remote uniqueness checks to publish global preflight;
- no overwrite of branches/tags/releases or npm unpublish; create-only refs use
  `--force-with-lease=<ref>:` solely as an atomic compare-and-set assertion that
  the ref is absent, while existing branches use an ordinary non-force push;
- no promise of Windows or broad multi-platform native write support;
- no hidden commit, push, tag, release, or package publication.

### Write Safety

`setup` is read-only by default and may create a config only once after exact
digest confirmation. `assess` is read-only unless an explicit report output is requested. `prepare`
writes local files under `.release-skill/`; it does not write project source
files or remote services. If hooks are configured, they are arbitrary local
processes and require `--acknowledge-hook-side-effects`; hooks may have their
own filesystem or network side effects. Gates are also project processes and
require `--acknowledge-gate-side-effects`; they may have the same side effects.
`publish` is the production write entry
and requires both approval and the current plan digest. Omit hooks and use local
sandbox targets for the smallest safe rehearsal.

### If something fails

| Result | What to do |
|---|---|
| `NEEDS_INPUT` | Complete setup's repository, tag, channel, baseline, and gate decisions. |
| `LOCAL_ONLY_DETECTED` | Establish a remote channel or keep only a local configuration design; do not claim production readiness. |
| `SETUP_DIGEST_MISMATCH` | Facts or answers changed; rerun dry-run, review, and confirm the new digest. |
| `CONFIG_EXISTS` | Setup never overwrites the existing config; assess it and edit incrementally. |
| `SAFE_WRITE_UNAVAILABLE` | Automatic create-once setup is unsupported on this platform; keep the dry-run report and create the reviewed config manually without overwriting an existing file. |
| `CONFIG_INVALID` | Correct `.release-skill/project.yaml`, then rerun `assess`. |
| `PUBLIC_FILE_MISSING` | Add or correct the configured public file. |
| `FORBIDDEN_CONTENT_DETECTED` | Remove the leaked/private content, then prepare again. |
| `SNAPSHOT_FIDELITY_FAILED` | Inspect the source/snapshot path and rerun `prepare`. |
| `BASELINE_CHANGED` | Keep the human edit, then prepare, review, and approve again. |
| `GATE_FAILED` during `prepare` | Fix the snapshot gate or frozen public artifact, then run a new `prepare`; the failed plan cannot be approved. |
| `GATE_FAILED` during `verify` | If the consumer environment failed, repair it and rerun `verify` from the same `PUBLISHED` run. If the published artifact is defective, release a new patch version; never overwrite it. |
| `PARTIAL` | Do not restart or delete remote state; review the returned `runPath` and run `reconcile` (see above). |
| `PUBLISHED` | Run `verify --plan <planPath> --run <publishRunPath>`; this is not terminal success. |
| `VERIFIED` | Remote state, exact npm install, and configured plugin consumer installs all matched the frozen plan. |

## Skills

- `release-help`: environment check and next-step guidance.
- `release-setup`: read-only discovery, human calibration, and create-once first-use configuration.
- `release-assess`: read-only release readiness report.
- `release-prepare`: local snapshot and reviewable release plan.
- `release-publish`: approved, digest-confirmed frozen GitHub+npm publishing.
- `release-reconcile`: evidence-based PARTIAL recovery with human intervention on conflicts.
- `release-verify`: post-publish verification; only `VERIFIED` is the happy end.

Conflicts still default to human intervention. The npm-installed `release-skill`
CLI is the supported user entry after v0.1.1 production publication; source
checkout remains the development/contributor fallback.

## License

MIT. See [LICENSE](LICENSE).
