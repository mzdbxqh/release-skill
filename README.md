# release-skill

[简体中文](README.zh-CN.md)

Release preparation for Claude Code and Codex, with human-edited files kept intact.

release-skill helps a maintainer answer three questions: what will be released,
which checks still fail, and which exact bytes will reach users. It freezes the
reviewed artifacts first and publishes those same artifacts later; it does not
regenerate a README or re-pack the live workspace at the last step.

<!-- release-skill:capability:external-write-boundary -->
> **Current boundary:** read-only `assess`, offline `prepare`, frozen Git
> branch/tag, GitHub Release, npm tarball, and Claude/Codex marketplace consumer
> installation verification have passed a local production-equivalent protocol
> sandbox using the real release-skill CLI and frozen artifacts, local bare Git
> remotes, and protocol fakes for `gh`, `npm`, Claude, and Codex. Separate
> isolated local probes have exercised the installed Claude/Codex CLIs; no real
> marketplace or production API was contacted. The tests do not provide
> OS-level network isolation. We
> have not run a real production canary for you; treat the first real release as
> a monitored canary. Real APIs, auth, permissions, rate limits, and eventual
> consistency are outside this sandbox claim. `prepare --online` still fails closed;
> `publish` performs remote uniqueness checks during its global preflight.

<!-- release-skill:capability:safe-first-command -->
> **Start here:**
> `node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs" help`

<!-- release-skill:maturity:v0.1-boundary -->
<!-- release-skill:maturity:boundary -->
> **Safe defaults:** the recommended path is `help → assess → prepare --offline →
> human review`. Production publishing adds `prepare --production → approve →
> publish --confirm-production <planDigest>`; without the digest confirmation,
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

This is the preservation contract: **copy current truth, freeze reviewed
truth, and never rewrite human truth.**

## Quick start

### Install / requirements

- Node.js 22+
- Git 2.30+
- A local checkout of release-skill
- A target Git repository with at least one commit

Set the checkout location once per shell:

```bash
export RELEASE_SKILL_HOME=/absolute/path/to/release-skill
```

Install the checkout's pinned dependencies from its workspace root:

```bash
cd "$RELEASE_SKILL_HOME"
npm exec --yes pnpm@10.17.1 -- install --frozen-lockfile
```

Create `.release-skill/project.yaml` in the target project:

First keep local plans, approvals, and frozen artifacts out of Git:

```gitignore
.release-skill/*
!.release-skill/project.yaml
```

Then create the configuration. npm visibility must be explicit:

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
    distributions:
      - type: npm
        package: my-project
        access: public       # or restricted; choose the real package policy
        provenance: false    # use true only after CI/OIDC is configured
        tag: latest
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
      releaseTitleTemplate: "{unit} {version}"
      releaseNotes: "Human-maintained release notes"
```

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

Run these steps in order. Steps 1–3 are safe default (read-only or local-only);
steps 4–8 are production publishing with explicit human gates.

```bash
CLI="$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs"
PROJECT=/absolute/path/to/my-project
```

1. **Environment check:**
   ```bash
   node "$CLI" help
   ```
2. **Readiness assessment (read-only):**
   ```bash
   node "$CLI" assess --root "$PROJECT" --offline --json
   ```
3. **Local snapshot and plan freeze:**
   ```bash
   node "$CLI" prepare --root "$PROJECT" --offline --json
   ```
4. **Human review:** inspect the returned `planPath`, `externalActions`,
   `units[].targetVersion`, and `planDigest`. Each unit's snapshot is under
   `<evidenceDir>/snapshots/<unit-id>/`. The command writes only local release
   data under `.release-skill/`.
5. **Production plan freeze:**
   ```bash
   node "$CLI" prepare --root "$PROJECT" --offline --production --json
   ```
   Review the new plan's externalActions, npm policy, branch/tag, and frozen digests.
6. **Approval:**
   ```bash
   node "$CLI" approve --plan <planPath> --digest <planDigest> --actor <name> --json
   ```
   Returns the effective `approvalPath` (default: `<planDir>/approval-record.json`).
   Approval expires after 24 hours; use the returned `expiresAt` as authority.
7. **Publish (remote writes start here):**
   ```bash
   node "$CLI" publish --root "$PROJECT" \
     --plan <planPath> --approval <approvalPath> \
     --confirm-production <planDigest> --json
   ```
   Save the returned `runPath`. `PUBLISHED` is **not** the terminal state.
8. **Verify (consumer install check):**
   ```bash
   node "$CLI" verify --root "$PROJECT" \
     --plan <planPath> --run <publishRunPath> --json
   ```

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

### Parent workspace with npm + plugin sub-units

When a monorepo produces both an npm package and a Claude/Codex plugin from
different directories, define separate release units. Only add a plugin
distribution when the unit actually ships a plugin with manifest, marketplace,
and entry Skill:

Here `project` is the parent workspace's orchestration container, not a public
release unit. If the workspace root also publishes its own repository or
package, add another release unit with `source: .`.

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
      source: packages/app/package.json
      tagTemplate: my-app-v{version}
    distributions:
      - type: npm
        package: my-app
        access: public
        provenance: false
        tag: latest
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
    production:
      branchTemplate: release/{tag}
      releaseTitleTemplate: "{unit} {version}"

  - id: my-plugin
    source: packages/plugin
    publicRepo: owner/my-plugin
    version:
      source: packages/plugin/package.json
      tagTemplate: my-plugin-v{version}
    distributions:
      # Declare plugin consumers only when the unit ships a plugin.
      # The CLI smoke is independent; only declare smokeBin when the plugin
      # package also exposes a CLI binary.
      - type: claude-plugin
        plugin: my-plugin
        marketplace: my-plugin
        entrySkill: my-plugin-help
      - type: codex-plugin
        plugin: my-plugin
        marketplace: my-plugin
        entrySkill: my-plugin-help
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
    production:
      branchTemplate: release/{tag}
      releaseTitleTemplate: "{unit} {version}"
```

Each plugin unit **must** list its Claude/Codex `plugin.json`, `marketplace.json`,
the entry Skill, and all required public files. A CLI smoke (`smokeBin`) is
optional for plugin units and only applies when the published npm package
exposes a CLI binary.

### PARTIAL recovery and reconcile

When `publish` succeeds at some checkpoints but fails at others, the run enters
`PARTIAL` status. **Do not restart from scratch and do not delete remote state**
(e.g., do not delete a tag that was already pushed, or unpublish a package).

Instead, use `reconcile` to inspect actual remote state, skip already-consistent
steps, and safely retry incomplete actions:

```bash
node "$CLI" reconcile --root "$PROJECT" \
  --run <publishRunPath> \
  --plan <planPath> \
  --approval <approvalPath> \
  --confirm-production <planDigest> \
  --json
# Save reconcile's new runPath, then perform the fresh install verification.
node "$CLI" verify --root "$PROJECT" \
  --plan <planPath> --run <reconcileRunPath> --json
```

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

## What it does not do yet

<!-- release-skill:capability:unsupported-scope -->
- no automatic README generation or source-file overwrite;
- no automatic conflict merge or rollback workflow;
- no claim that a real production canary has run for marketplace verification;
- no `prepare --online`; production remote checks happen in publish preflight;
- no force push, overwrite of branches/tags/releases, or npm unpublish;
- no promise of Windows or broad multi-platform native write support;
- no hidden commit, push, tag, release, or package publication.

### Write Safety

`assess` is read-only unless an explicit report output is requested. `prepare`
writes local files under `.release-skill/`; it does not write project source
files or remote services. If hooks are configured, they are arbitrary local
processes and require `--acknowledge-hook-side-effects`; hooks may have their
own filesystem or network side effects. `publish` is the production write entry
and requires both approval and the current plan digest. Omit hooks and use local
sandbox targets for the smallest safe rehearsal.

### If something fails

| Result | What to do |
|---|---|
| `CONFIG_INVALID` | Correct `.release-skill/project.yaml`, then rerun `assess`. |
| `PUBLIC_FILE_MISSING` | Add or correct the configured public file. |
| `FORBIDDEN_CONTENT_DETECTED` | Remove the leaked/private content, then prepare again. |
| `SNAPSHOT_FIDELITY_FAILED` | Inspect the source/snapshot path and rerun `prepare`. |
| `BASELINE_CHANGED` | Keep the human edit, then prepare, review, and approve again. |
| `GATE_FAILED` | Inspect frozen artifacts, auth, remote uniqueness, and digest confirmation. |
| `PARTIAL` | Do not restart or delete remote state; review the returned `runPath` and run `reconcile` (see above). |
| `PUBLISHED` | Run `verify --plan <planPath> --run <publishRunPath>`; this is not terminal success. |
| `VERIFIED` | Remote state, exact npm install, and configured plugin consumer installs all matched the frozen plan. |

## Skills

- `release-help`: environment check and next-step guidance.
- `release-assess`: read-only release readiness report.
- `release-prepare`: local snapshot and reviewable release plan.
- `release-publish`: approved, digest-confirmed frozen GitHub+npm publishing.
- `release-reconcile`: evidence-based PARTIAL recovery with human intervention on conflicts.

Conflicts still default to human intervention. The accepted entry is the source
CLI shown above.

## License

MIT. See [LICENSE](LICENSE).
