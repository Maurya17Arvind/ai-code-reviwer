# AI Code Review Agent

A standalone, multi-tenant code review platform. Claude and GPT independently review changes from local Git
repositories, GitLab merge requests and GitHub pull requests. A deterministic validation layer decides what gets
published, and every code or Git change requires human approval. Merging is never automated.

> **Status: Phase 3 (AI review engine) complete.** `ai-review review` runs Claude and GPT in parallel on local changes,
> validates and deduplicates findings deterministically, and keeps history in `.git/ai-review/`. GitLab follows in Phase 4.
> See [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) and [docs/CLI.md](docs/CLI.md).

## Stack

Claude (Anthropic SDK) + GPT (OpenAI SDK) via LangGraph · Nx 24 · TypeScript 6.0 · Angular 22.3 (zoneless, signals) · NestJS 11 · PostgreSQL 18 + Prisma 7 ·
Redis 8 + BullMQ 6 · Zod 4 · Vitest 5 · pnpm 10 · Node 24 LTS

## Repository layout

```text
apps/
  api/          NestJS HTTP API (health, error envelope, security headers)
  worker/       NestJS BullMQ worker (no HTTP)
  dashboard/    Angular 22 dashboard
  cli/          `ai-review` command-line tool (init, status, changes, review, findings, report, dismiss)
libs/
  shared/types        domain enums (browser-safe)
  shared/contracts    API contracts (browser-safe)
  configuration       env validation, logger options
  security            redaction utilities
  database            Prisma schema, migrations, client
  queue               queue registry, job schemas, producer
  git-providers/core  provider ports and diff model
  git-providers/local read-only local Git adapter
  repository-context  diff parser and review-context builder
  ai-providers/*      AiReviewer port, Claude and GPT adapters
  review-engine       static analysis, prompt, validation, dedup, lifecycle, reports
  agent-core          LangGraph review pipeline
infrastructure/       Docker init scripts
tools/testing/        integration-test configuration
docs/                 architecture, ADRs, design docs
```

## Quick start

```powershell
pnpm install
Copy-Item .env.example .env    # replace every change-me value
pnpm infra:up                  # PostgreSQL + Redis
pnpm db:migrate
pnpm check                     # lint, typecheck, unit tests, build
pnpm test:integration
pnpm dev:api                   # http://127.0.0.1:3000/api/health/ready
pnpm dev:dashboard             # http://localhost:4300
```

Full instructions: [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md).

## Documentation

| Document                                          | Contents                                                        |
| ------------------------------------------------- | --------------------------------------------------------------- |
| [CLI.md](docs/CLI.md)                             | `ai-review` commands, scopes and exit codes                     |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md)           | System design, module boundaries, conventions, version baseline |
| [adr/](docs/adr/README.md)                        | Architecture decision records                                   |
| [DATABASE_DESIGN.md](docs/DATABASE_DESIGN.md)     | Schema conventions, implemented and target model                |
| [API_DESIGN.md](docs/API_DESIGN.md)               | API conventions and endpoints                                   |
| [SECURITY.md](docs/SECURITY.md)                   | Trust boundaries, implemented and planned controls              |
| [REVIEW_WORKFLOW.md](docs/REVIEW_WORKFLOW.md)     | Review pipeline (Phase 3)                                       |
| [APPROVAL_WORKFLOW.md](docs/APPROVAL_WORKFLOW.md) | Human approval model (Phase 6)                                  |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md)               | Deployment (Phase 8)                                            |
