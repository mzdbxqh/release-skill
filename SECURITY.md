# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in release-skill, please report it
responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please send an email to the maintainers with:

1. A description of the vulnerability.
2. Steps to reproduce the issue.
3. The potential impact.
4. Any suggested fix, if you have one.

You should receive an acknowledgement within 72 hours. We will work with
you to understand the issue and coordinate a fix before any public
disclosure.

## Security Design Principles

release-skill is designed with the following security guarantees:

- **No automatic external writes**: The `prepare` phase never pushes,
  creates releases, or publishes packages itself. User-configured hooks
  may produce arbitrary side effects; pass `--acknowledge-hook-side-effects`
  to authorize hook execution.
- **Approval-gated publishing**: The `publish` phase requires an explicit,
  non-expired approval record bound to a frozen release plan. Approval
  expires after 24 hours and auto-invalidates when the plan, tree hash,
  target version, or remote conflict state changes.
- **Checkpoint-based execution**: Every external write is a checkpoint.
  Failure stops subsequent actions and enters a `PARTIAL` state. The system
  never auto-deletes remote tags, overwrites releases, unpublishes npm
  packages, or restarts from scratch.
- **Hook safety**: Project hooks use executable/argument arrays with
  relative cwd, timeout, and environment allowlist. Shell strings are not
  accepted. Project overlays cannot disable secret scanning, plan
  validation, approval gates, or post-publish verification.
- **Credential safety**: Logs never record tokens, authentication headers,
  npm config content, or unredacted environment variables.
