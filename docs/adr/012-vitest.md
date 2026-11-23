# ADR-012: Vitest across the workspace

**Status:** Accepted · 2026-11-23

## Decision

- **Vitest 5.0.5** for every project. The dashboard uses `@angular/build:unit-test` (Vitest + jsdom).
  Node projects use `@nx/vitest`.
- Two test tiers:
  - `test`: unit tests, no infrastructure, never call external APIs.
  - `integration`: `*.integration.spec.ts` against the Docker Compose PostgreSQL/Redis.
    Shared config is in `tools/testing/`. Run with `pnpm test:integration`.
- Database integration tests run inside transactions that are always rolled back.

## Consequences

Nx's built-in Angular version table (written for Angular 22.2) rejected Vitest 5. Installing Angular 22.3.0
first made Nx read the real peer range (`vitest ^4.0.8 || ^5.0.0`). No Jest fallback was needed.
