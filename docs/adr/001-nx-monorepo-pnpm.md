# ADR-001: Nx monorepo with pnpm

**Status:** Accepted · 2026-11-23

## Context

Four deployables (API, worker, dashboard, CLI) share domain types, contracts and infrastructure code.
They have different runtime targets: browser, long-running Node server, and a CLI.

## Decision

- One **Nx 24.0.6** workspace using the _integrated_ layout: TypeScript path aliases and `project.json` files,
  without package-manager workspaces. The Nx Angular plugin is built for this layout.
- **pnpm 10.32.1** as package manager, pinned via `packageManager`. `.npmrc` enables `engine-strict`,
  `save-exact`, `strict-peer-dependencies` and `auto-install-peers=false`.
- The official `create-nx-workspace` template (`nrwl/empty-template`) was **not** used. It ignored
  `--workspaces=false`, installed Nx 24.0.0 instead of 24.0.6, and added eight AI-agent config folders.
  The root config was written by hand, and all apps and libs were generated with the official Nx generators.
- All dependency versions are exact. The lockfile is committed.

## Consequences

- Cached, affected-only `lint/typecheck/test/build` and enforced module boundaries (ADR-017).
- Strict peers surface incompatibilities at install time instead of at runtime. Two were found and
  handled explicitly (ADR-014, ADR-015).
- Nx generators run their own `pnpm install` and fail when invoked from Windows PowerShell. Run Nx
  generators from Git Bash, or run `pnpm install` afterwards (see LOCAL_DEVELOPMENT.md).
