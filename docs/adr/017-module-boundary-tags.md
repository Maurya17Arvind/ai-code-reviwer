# ADR-017: Scope/type tags for module boundaries

**Status:** Accepted · 2026-11-23

## Decision

Every Nx project has a `scope:*` tag (`shared`, `node`, `server`, `dashboard`, `cli`) and a `type:*` tag
(`util`, `port`, `domain`, `adapter`, `app`). The constraints are in the root `eslint.config.mjs` and
documented in ARCHITECTURE.md §4.1. `scope:node` was added beyond the Phase 0 proposal so the CLI can
reuse configuration and security utilities without being able to reach the database or queue.

## Consequences

Verified during Phase 1: an import of `@acra/database` from the dashboard or the CLI fails lint.
