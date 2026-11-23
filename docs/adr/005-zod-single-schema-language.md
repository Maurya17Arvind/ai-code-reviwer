# ADR-005: Zod as the single schema language; zod/mini in the browser

**Status:** Accepted · 2026-11-23

## Context

We validate environment variables, API payloads, queue jobs, `ai-review.yaml` and (later) AI output.
One schema language keeps types and runtime checks in sync. The first dashboard build showed that full Zod
(method-chaining API, not tree-shakable) plus a named `{ z }` import pulled every Zod locale into the bundle:
the System status chunk was **460 kB**.

## Decision

- **Zod 4.6.7** everywhere. TypeScript types are inferred from schemas (`z.infer`).
- Browser-safe libraries (`scope:shared`: shared/types, shared/contracts) use **`zod/mini`**.
- Always import as a namespace (`import * as z from 'zod'` / `'zod/mini'`) so bundlers can tree-shake.

## Consequences

- The System status chunk dropped from 460 kB to **27 kB raw (8.5 kB transfer)**.
- Mini schemas use the functional API (`z.optional(x)`, `.check(z.gte(0))`). Server code may consume them.
