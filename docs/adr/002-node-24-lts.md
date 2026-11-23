# ADR-002: Node.js 24 LTS

**Status:** Accepted · 2026-11-23

## Context

`@angular/core@22.3.0` and `@angular/build@22.3.0` declare `engines.node: ^22.22.3 || ^24.15.0 || >=26.0.0`.
Node 24.15.0 is installed on the development machine, and 24 is the active LTS line.

## Decision

Use Node **24.15.x**, pinned in `.nvmrc`. The root `package.json` `engines` allows `^22.22.3 || ^24.15.0`,
and `engine-strict=true` makes installs fail on unsupported versions.

## Consequences

- Native `process.loadEnvFile()` replaces a dotenv dependency.
- Production images must use Node 24.15+ (Phase 8).
