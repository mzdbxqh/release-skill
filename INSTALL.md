# Installation Guide

## Prerequisites

- Node.js 22.0.0 or later
- pnpm 8+ (or npm 9+)
- Git 2.30+

## Current Install (Local Checkout)

The npm package is not yet published. Current distribution is a local source
checkout. Set `RELEASE_SKILL_HOME` to the absolute path of your release-skill
checkout:

```bash
export RELEASE_SKILL_HOME=/absolute/path/to/release-skill
```

Verify:

```bash
node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs" --version
node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs" help
```

You should see the version number and the list of available commands.

> **Planned:** `npm install -g release-skill` will be available after the first
> verified npm publish.

## First Run

The safest first command is always `help`. It runs entirely locally and
performs no writes.

```bash
node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs" help
```

To check if your project is ready for release governance:

```bash
node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs" \
  assess --root /path/to/your/project --json
```

This command is read-only. It examines your project structure, configuration,
documentation, and supply chain, then outputs a gap report. All
`.release-skill/` files and hook side effects are written inside your project
directory, not the release-skill checkout.

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

hooks:
  build:
    command: [npm, run, build]
  test:
    command: [npm, test]
```

## Next Steps

- Read the [full README](README.md) for the complete workflow guide.
- Run `assess --root <your-project>` to evaluate your project's release readiness.
- Run `prepare --root <your-project> --offline` (release-skill pipeline writes
  locally only; user-configured hooks may perform remote operations) to generate
  a release plan.
