# Installation Guide

[简体中文](INSTALL.zh-CN.md)

## Prerequisites

- Node.js 22.0.0 or later
- Git 2.30+

## Install from npm (recommended)

v0.1.1 is published and verified. For a newer source candidate such as v0.1.3,
use the npm path only after `npm view release-skill version` returns that exact
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

If `.release-skill/project.yaml` is absent, discover first-use facts and
candidates without writing files:

```bash
"${CLI[@]}" setup --root /path/to/your/project --json
```

`NEEDS_INPUT` and `LOCAL_ONLY_DETECTED` intentionally return exit code 2. They
are decision states, not an internal crash; automation should inspect the JSON
`status`.

Review release units, legacy `public-release.json` migration hints, tags,
branch strategies, previous-public-baseline decisions, and gate candidates.
Setup never executes a discovered script automatically. Provide a complete
answers JSON, dry-run again to obtain the digest that binds current facts and
answers, then create the configuration exactly once:

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

The wrapper is complete, but its values are examples. Replace every repository,
channel, baseline, and public-file decision with reviewed project facts; use
`mode: none` only when no public version exists.

When selecting a reported gate, add the complete gate definition to
`projectConfig.verificationGates` and copy its id into `selectedGateIds`. The
id must come from the current `gateCandidates`. A snapshot-gate command and all
of its dependencies must be present in `publicFiles`; it cannot see tests,
development dependencies, or `node_modules` that exist only in the parent
workspace. The full [README setup section](README.md#first-use-discover-then-let-a-human-finalize)
contains complete no-gate and one-gate answers examples.

```bash
"${CLI[@]}" setup --root /path/to/your/project \
  --answers /path/to/setup-answers.json --json
"${CLI[@]}" setup --root /path/to/your/project \
  --answers /path/to/setup-answers.json \
  --write --confirm-setup <setupDigest> --json
```

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
that must run from an exact isolated npm/Claude/Codex installation root. Gate
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
