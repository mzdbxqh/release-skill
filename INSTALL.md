# Installation Guide

## Prerequisites

- Node.js 22.0.0 or later
- Git 2.30+

## Install from npm (recommended)

This repository is currently preparing the v0.1.1 release. Use the npm path
only after `npm view release-skill version` returns `0.1.1` (or newer). Before
that publication is verified, use the source checkout instructions below.

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

To check if your project is ready for release governance:

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
    command: [npm, test]
```

See the [full README](README.md) for hook parameter constraints and safety
requirements.

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
