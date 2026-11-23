# Architecture — AI Code Review Agent

> Status: **Phase 1 implemented** (foundation). Last updated: 2026-11-23.
> Decisions are recorded as ADRs in [`docs/adr/`](./adr/README.md).

## 1. Purpose and scope

A standalone, multi-tenant platform that reviews code changes from **local Git repositories**,
**GitLab Merge Requests** and **GitHub Pull Requests**. Claude and GPT independently review the same
versioned context. A deterministic validation layer decides what is published. Every code or Git
mutation needs explicit human approval, and merging is never performed.

## 2. System context

```text
                 ┌──────────────┐        webhooks         ┌──────────────────┐
  GitHub App ───▶│              │◀────────────────────────│ GitLab project   │
                 │   apps/api   │                          └──────────────────┘
  Dashboard ────▶│  (NestJS)    │── enqueue ──▶ Redis/BullMQ ──▶ apps/worker (NestJS)
  (Angular 22)   │              │                                  │
                 └──────┬───────┘                                  │ LangGraph review pipeline (Phase 3)
                        │                                          │  ├─ Claude (Anthropic SDK)
                        ▼                                          │  └─ GPT    (OpenAI SDK)
                   PostgreSQL ◀─────────── Prisma ─────────────────┘
                                                                   │
                                                  publish via GitProvider adapters (Phases 4–5)

  Developer laptop:  apps/cli ── LocalGitProvider + review-engine ── (optional) AI providers
                     Local/private mode: no API server needed; nothing uploaded without consent.
```

## 3. Deployable applications

| App              | Tech                                         | Responsibility                                                      | Must NOT                           | Phase 1 state                                                                    |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| `apps/api`       | NestJS 11 + Express 5                        | HTTP API, auth, webhook intake, approval endpoints, enqueuing jobs  | Run AI reviews inline              | Health probes, error envelope, helmet, CORS allowlist, request IDs, pino logging |
| `apps/worker`    | NestJS 11 application context (no HTTP)      | Consume BullMQ queues: reviews, publishing, fixes, approved Git ops | Expose HTTP                        | Consumes `system` queue (`heartbeat` job)                                        |
| `apps/dashboard` | Angular 22.3 (standalone, zoneless, signals) | UI for orgs, repos, reviews, findings, approvals, analytics, audit  | Import server code or see secrets  | Shell, lazy routes, System status page                                           |
| `apps/cli`       | Node + commander                             | `ai-review` local review, reports, findings                         | Modify, stage, commit or push code | `--help` / `--version` only                                                      |

API and worker are separate processes (ADR-009). Webhook intake stays fast, review throughput scales on
its own, and a crashing job cannot take the API down.

## 4. Library layout (Nx)

```text
libs/
├── shared/
│   ├── types/            ✅ Domain enums (zod/mini), browser-safe
│   └── contracts/        ✅ API DTO schemas (zod/mini) — health, error envelope
├── configuration/        ✅ Env schemas (Zod), fail-fast loader, logger options
├── security/             ✅ Log redaction paths, URL credential masking
├── database/             ✅ Prisma 7 schema + migrations, client factory, Nest module, health probe
├── queue/                ✅ Queue/job registry, Zod job schemas, Redis options, producer, health probe
│
├── agent-core/           ⏳ Phase 3 — LangGraph StateGraph, node contracts, run tracing
├── review-engine/        ⏳ Phase 3 — analyzers, reviewers, aggregator, validators, dedup, lifecycle
├── repository-context/   ⏳ Phase 2 — diff parsing, hunk mapping, context extraction
├── ai-providers/{core,claude,openai}        ⏳ Phase 3
├── git-providers/{core,local,gitlab,github} ⏳ Phases 2, 4, 5
├── publishing/           ⏳ Phase 4
├── approvals/            ⏳ Phase 6
└── fix-engine/           ⏳ Phase 6
```

Libraries are created in the phase that first needs them, to avoid empty abstractions.

### 4.1 Dependency rules (enforced by `@nx/enforce-module-boundaries`)

Every project carries one `scope:*` and one `type:*` tag (see root `eslint.config.mjs`).

| Scope tag         | Meaning                                                                    | May depend on                                                              |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `scope:shared`    | Browser-safe (shared/types, shared/contracts)                              | `scope:shared`                                                             |
| `scope:node`      | Node-only utilities usable by server **and** CLI (configuration, security) | `scope:shared`, `scope:node`                                               |
| `scope:server`    | Server infrastructure (database, queue, api, worker)                       | `scope:shared`, `scope:node`, `scope:server`                               |
| `scope:dashboard` | Angular app                                                                | `scope:shared` only. No server code reaches the browser                    |
| `scope:cli`       | Local CLI                                                                  | `scope:shared`, `scope:node`, `scope:cli`. **Never** the database or queue |

| Type tag       | May depend on                                           |
| -------------- | ------------------------------------------------------- |
| `type:util`    | `type:util`                                             |
| `type:port`    | `type:util`, `type:port`                                |
| `type:domain`  | `type:util`, `type:port`, `type:domain`                 |
| `type:adapter` | `type:util`, `type:port`, `type:domain`, `type:adapter` |
| `type:app`     | all library types                                       |

The domain depends on **ports** and never on vendor SDKs. Apps wire concrete adapters through Nest DI
(api/worker) or a composition root (cli). The rules are verified by lint: importing `@acra/database` from
the dashboard or the CLI is a lint error.

### 4.2 Deviations from the originally suggested structure

1. **`review-engine` will be one Nx project with sub-folders**, not six. The sub-areas are tightly
   coupled and released together.
2. **`git-providers/local` added, and `ai-providers/core` / `git-providers/core` split** so ports are
   importable without vendor SDKs.
3. **`shared/contracts` and `queue` added.** Contracts keep the dashboard decoupled from backend
   internals. `queue` keeps job payloads typed and validated on both sides.
4. **`scope:node` added** so the CLI can share configuration and security utilities without access
   to server infrastructure.
5. **`tools/testing/`** holds shared integration-test configuration. It is not an Nx project.

## 5. Cross-cutting conventions (implemented)

| Concern              | Convention                                                                                                                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration        | Each process validates its env with a Zod schema at startup and exits with a list of variable names and rules. **Values are never printed.** `.env` is loaded only if present.                                                                                                      |
| Dependency injection | Nest constructor parameters use explicit `@Inject(Token)` (ADR-016). DI does not depend on `emitDecoratorMetadata`, so it works the same under webpack/tsc and Vitest.                                                                                                              |
| Logging              | pino via nestjs-pino. JSON in production, pretty in development. Central redaction paths cover auth headers, webhook secrets and common secret keys. Request IDs are accepted from a validated `X-Request-Id` or generated, and echoed back.                                        |
| Errors               | The API returns `{ statusCode, error, message, requestId? }`. 5xx bodies are always generic. Details are logged server-side only.                                                                                                                                                   |
| Health               | `/api/health/live` (process) and `/api/health/ready` (PostgreSQL + Redis, 2 s per-probe timeout, 503 when degraded, coarse `reason` only).                                                                                                                                          |
| Queues               | Job names and payload schemas live in `@acra/queue`. Producers validate before enqueue, and consumers re-validate (Redis content is untrusted). Malformed jobs fail with `UnrecoverableError`. `jobId` gives idempotency. Producer connections fail fast, worker connections block. |
| Database             | UUIDv7 keys, snake_case tables, `timestamptz(3)`, `organization_id` on tenant-owned tables, soft delete where user-facing, DB-enforced append-only `audit_logs`. The app connects as a non-superuser role.                                                                          |
| Browser bundles      | Browser-safe libraries use `zod/mini` with `import * as z` (tree-shakable). The System status chunk is 27 kB raw.                                                                                                                                                                   |
| Testing              | Vitest everywhere. Unit tests run without infrastructure (`nx run-many -t test`). `*.integration.spec.ts` runs against Docker Compose services (`pnpm test:integration`). External AI/Git APIs are never called in automated tests.                                                 |

## 6. Review pipeline (summary; detailed in `REVIEW_WORKFLOW.md`, Phase 3)

`RECEIVE_REQUEST → IDENTIFY_REPOSITORY → FETCH_COMMIT_AND_DIFF → BUILD_REPOSITORY_CONTEXT →
ANALYZE_CHANGED_FILES → RUN_STATIC_ANALYSIS → PARALLEL_AI_REVIEW (Claude ‖ GPT) →
AGGREGATE → VALIDATE → DEDUPLICATE → MAP_TO_DIFF → PUBLISH → SAVE_HISTORY → WAIT`

Invariants:

- Both models receive a **byte-identical context snapshot** keyed by `(repo, baseSha, headSha, contextHash)`.
- Every model run is recorded (provider, model, tokens, cost, latency, status, error).
- One provider failing does not discard the other's findings. The session is marked `PARTIAL`.
- Model agreement is a signal, **not** proof. Every finding passes deterministic validators.
- Findings that can't be mapped to a diff line go to the summary. We never invent an inline position.
- Webhook deliveries and jobs use idempotency keys.

## 7. Security model (summary; detailed in [`SECURITY.md`](./SECURITY.md))

- Repository content, diffs, commit messages, PR/MR text, comments and AI output are **untrusted data**.
- Privileged operations run only from an approved, SHA-bound, expiring `ApprovalRequest`. Merge is not implemented.
- Webhook signature verification, SSRF guards, sandboxed fix execution and envelope-encrypted credentials
  come in the phases that introduce those features.

## 8. Execution modes and data egress

| Mode            | Where the review runs       | What leaves the machine                                                                                                                                     |
| --------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local / private | Developer's machine via CLI | Diff plus bounded context, sent directly to the configured AI provider(s) with the developer's keys. Nothing goes to our server unless explicitly uploaded. |
| Server          | Worker                      | Diff plus bounded context (after redaction and exclude filters) sent to Anthropic/OpenAI. Metadata and findings are stored in PostgreSQL.                   |

## 9. Version baseline (verified 2026-11-23 against npm registry metadata; all pinned exactly)

| Component                                   | Version                                                        | Notes                                                              |
| ------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| Node.js                                     | 24.15.0 (`.nvmrc`)                                             | Angular 22.3 engines `^22.22.3 \|\| ^24.15.0 \|\| >=26`            |
| pnpm                                        | 10.32.1                                                        | `packageManager` field; strict peers; `engine-strict`              |
| TypeScript                                  | 6.0.3                                                          | Angular requires `>=6.0 <6.1`; TS 7 not used (ADR-003)             |
| Angular                                     | 22.3.0 (core, common, router, forms, build, cli, compiler-cli) | Zoneless, esbuild application builder                              |
| Nx + plugins                                | 24.0.6                                                         | One-line pnpm patch for Angular 22.3 compatibility (ADR-015)       |
| NestJS                                      | **11.2.11**                                                    | Not 12.x: `@nx/nest@24.0.6` peer `@nestjs/* >=10 <12` (ADR-014)    |
| Express                                     | 5.2.1                                                          | via `@nestjs/platform-express`                                     |
| Prisma                                      | 7.10.1 (+ `@prisma/adapter-pg`, `pg` 8.23.1)                   | Stable; npm `latest` tag points at an 8.0 RC (ADR-006)             |
| PostgreSQL                                  | 18.7 (`postgres:18.7-alpine`)                                  | ADR-007                                                            |
| Redis                                       | 8.10.3 (`redis:8.10.3-alpine`)                                 | ADR-008                                                            |
| BullMQ / @nestjs/bullmq / ioredis           | 6.7.8 / 12.0.2 / 6.0.0                                         | `@nestjs/bullmq` peer `@nestjs/core ^10\|\|^11\|\|^12`             |
| Zod                                         | 4.6.7                                                          | `zod` on server, `zod/mini` in browser-safe libs                   |
| pino / nestjs-pino / pino-http              | 10.4.0 / 5.3.2 / 11.0.0                                        |                                                                    |
| helmet                                      | 8.3.0                                                          |                                                                    |
| commander                                   | 15.1.0                                                         | CLI                                                                |
| Vitest / Vite                               | 5.0.5 / 8.3.8                                                  | Accepted by `@angular/build@22.3.0` (`^4.0.8 \|\| ^5.0.0`)         |
| ESLint / typescript-eslint / angular-eslint | 10.15.0 / 8.73.0 / 22.8.0                                      | Flat config                                                        |
| Prettier                                    | 3.10.1                                                         | Angular parser for templates                                       |
| React (dev only)                            | 19.3.1                                                         | Peer of Prisma Studio (`@prisma/studio-core`); not used by any app |
| LangGraph, Anthropic SDK, OpenAI SDK        | 1.7.5, 1.12.0, 7.62.0                                          | **Not installed yet** — Phase 3                                    |
| simple-git / gitbeaker / Octokit            | 4.1.0 / 44.1.10 / 16.x                                         | **Not installed yet** — Phases 2, 4, 5                             |

### Known compatibility items

- **Nx 24.0.6 ↔ Angular 22.3.0:** Angular 22.3 added a package `exports` map to `@angular-devkit/architect`
  that no longer exposes `./node/index.js`, which Nx imports. Fixed with a one-line pnpm patch
  (`patches/nx@24.0.6.patch`). **Remove the patch when upgrading to an Nx release that includes the fix.**
- **pnpm peer rule:** `@angular/build` → `@oxc-parser/binding-wasm32-wasi` → `@napi-rs/wasm-runtime` declares
  `@emnapi/* ^1.7.1` while oxc ships `2.0.0-alpha.6`. This is a WASI fallback binding that is never loaded
  on win32/linux/darwin x64/arm64. Scoped `peerDependencyRules.allowedVersions` for exactly that edge.
  Strict peer checking stays on for everything else.
- `.npmrc` holds pnpm settings (`strict-peer-dependencies`, `auto-install-peers`). Raw `npm` commands
  print "unknown project config" warnings. Use `pnpm`.
