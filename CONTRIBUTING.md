# Contributing to release-skill

Thank you for your interest in contributing to release-skill.

## Getting Started

1. Fork and clone the repository.
2. Install dependencies: `pnpm install`.
3. Run tests: `pnpm test`.
4. Run syntax validation: `pnpm build`.

## Project Structure

- `skills-src/` - Skill definition source files (SKILL.md for each skill).
- `src/core/` - Deterministic release kernel (baseline, errors, evidence, hooks).
- `src/adapters/` - Registry adapters (Git/GitHub, npm, plugin marketplace).
- `bin/` - CLI entry point.
- `schemas/` - JSON Schema definitions for configuration and plans.
- `references/` - Rendered reference documentation.
- `test/` - Test suite.

## Development Guidelines

- All code uses ESM (`.mjs` extension) on Node.js 22+.
- All `.mjs` files must pass `node --check` (syntax validation).
- Hooks must use executable/argument arrays, not shell strings.
- Never include absolute paths like `/Users/...` in code or documentation.
- Test your changes before submitting a pull request.

## Pull Request Process

1. Create a feature branch from `main`.
2. Make your changes and ensure all tests pass.
3. Write clear commit messages describing what changed and why.
4. Open a pull request with a description of the change and any related
   issue numbers.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting Issues

For non-security issues, please open a GitHub issue with:

- A clear description of the problem.
- Steps to reproduce.
- Expected vs. actual behavior.
- Your environment (Node.js version, OS).
