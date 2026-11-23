# Project Plan — AI Code Review Agent

> Status: **Phase 1 complete — awaiting approval for Phase 2.** Last updated: 2026-11-23.
> Phase 1 results and deviations: see [§6](#6-phase-1-results-2026-11-23).

## 1. Phase overview

| Phase | Name                                               | Status                      |
| ----- | -------------------------------------------------- | --------------------------- |
| 0     | Environment and workspace inspection               | ✅ Complete (this document) |
| 1     | Project foundation                                 | ✅ Complete (2026-11-23)    |
| 2     | Local Git integration + CLI                        | ⏳ Awaiting approval        |
| 3     | AI review engine (Claude + GPT, validation, dedup) | Not started                 |
| 4     | GitLab integration                                 | Not started                 |
| 5     | GitHub App integration                             | Not started                 |
| 6     | Approval and fix workflow                          | Not started                 |
| 7     | Angular dashboard (feature build-out)              | Not started                 |
| 8     | Production readiness                               | Not started                 |

Rule: a phase is only marked complete when build, lint, type-check and tests pass, and no
placeholder is presented as working functionality.

## 2. Phase 0 findings (2026-11-23)

### 2.1 Environment

| Item                                    | Found                                                        | Status                                                          |
| --------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| OS                                      | Windows 11 Pro 10.0.26300, x64, 15.8 GB RAM                  | ✅                                                              |
| Disk                                    | D: 194 GB free; **C: 14.2 GB free**                          | ⚠️ C: is tight for Docker's WSL disk                            |
| Node.js                                 | 24.15.0 via nvm-windows (also 22.x, 25.x installed)          | ✅ Matches Angular 22.3 engine range exactly                    |
| npm / pnpm                              | 11.12.1 / 10.32.1                                            | ✅                                                              |
| Git                                     | 2.49.0, user.name/email configured, SSH key present (id_rsa) | ✅                                                              |
| Docker / Compose                        | 29.6.2 / v5.3.1 installed                                    | ⚠️ **Daemon not running** (WSL distro `docker-desktop` stopped) |
| Claude Code                             | 2.1.318                                                      | ✅                                                              |
| Global Nx / Angular CLI                 | 22.0.3 / 22.0.4                                              | ℹ️ Outdated globals; the workspace uses local binaries          |
| GitHub CLI (`gh`) / GitLab CLI (`glab`) | Not installed                                                | ⚠️ Optional, needed for Phase 4/5 setup                         |
| psql / redis-cli                        | Not installed                                                | ℹ️ Not required (use `docker exec`)                             |
| Windows long paths                      | Disabled (`LongPathsEnabled=0`), `core.longpaths` unset      | ⚠️ Recommended to enable                                        |
| Ports                                   | 5432, 6379, 3000 free; **4200 in use by a `node` process**   | ⚠️ Dashboard will use 4300 or that process is stopped           |
| Workspace                               | `D:\demos` is a folder of unrelated projects, not a Git repo | ✅ New project goes in `D:\demos\ai-code-review-agent`          |

### 2.2 Credentials (presence only, values never read)

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_*`, `GITLAB_*`, `DATABASE_URL`, `REDIS_URL` are **all absent**
(process/user/machine scope). Phase 1 doesn't need them. AI keys are needed from Phase 3,
GitLab from Phase 4 and the GitHub App from Phase 5.

### 2.3 Required actions before Phase 1

1. **Start Docker Desktop** (required for PostgreSQL/Redis).
2. **Enable long paths** (recommended, needs admin).
3. Free port 4200 or accept 4300 for the dashboard.

Install/config commands are listed in §5.

## 3. Phase 1 — Project foundation (approved scope — completed, see §6)

**Goal:** a working, empty-but-real skeleton. Every app builds, starts, passes lint, type-check and tests,
and connects to real PostgreSQL and Redis. **No review, AI or Git-provider features.**

### 3.1 Steps

1. **Repository bootstrap**
   - `git init` in `D:\demos\ai-code-review-agent` (local only, no remote, no commit until you ask).
   - `.gitignore` (incl. `.env`, `.env.*` except `.env.example`), `.gitattributes` (`* text=auto eol=lf`),
     `.nvmrc` (24.15.0), `.editorconfig`, `.npmrc` (`engine-strict=true`, `save-exact=true`).
2. **Nx workspace**: `create-nx-workspace@24.0.6` (pnpm, no Nx Cloud), TypeScript 6.0.3,
   strict `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
   `noImplicitOverride`, `useUnknownInCatchVariables`).
3. **Apps**
   - `apps/api` — NestJS 12. `/health/live` and `/health/ready` (checks DB and Redis), global ValidationPipe
     equivalent using Zod, helmet, CORS allowlist, pino logging, graceful shutdown.
   - `apps/worker` — NestJS 12 application context. Registers one `system` queue with a
     `heartbeat` job to prove end-to-end BullMQ wiring. Graceful shutdown.
   - `apps/dashboard` — Angular 22.3, standalone, zoneless, strict templates, lazy-loaded route shell,
     plus a status page that calls `/health`. No feature screens yet.
   - `apps/cli` — `ai-review --version` / `--help` skeleton (commander). Real commands come in Phase 2.
4. **Libraries (created now, mostly empty with explicit TODO markers)**: `shared/types`,
   `shared/contracts`, `configuration`, `database`, `queue`, `security`. Other libs are created in the
   phase that first needs them, to avoid premature abstraction.
5. **Configuration**: Zod env schema in `libs/configuration`. The app fails fast on startup with a readable
   error that never echoes secret values. `.env.example` is committed.
6. **Database**: Prisma 7.10.1 with `prisma.config.ts` and `@prisma/adapter-pg`. **Initial migration covers
   the tenancy foundation only**: `organizations`, `users`, `organization_members`, `repositories`,
   `audit_logs`. The full model is designed up front in `DATABASE_DESIGN.md`, and remaining tables are added in
   the phase that uses them.
7. **Queue**: BullMQ 6 + `@nestjs/bullmq` 12, typed queue names and Zod-validated job payloads in `libs/queue`.
8. **Docker Compose**: `postgres:18.7-alpine`, `redis:8.x-alpine` (exact tag pinned at install), named volumes,
   healthchecks, bound to `127.0.0.1` only. Redis has a password; Postgres uses a non-superuser app role.
9. **Quality gates**: ESLint 10 flat config + typescript-eslint + angular-eslint, Nx module-boundary
   tags (ARCHITECTURE §4.1), Prettier, Vitest. Integration tests run against the Compose services
   (DB connect plus migration, enqueue/consume heartbeat job).
10. **Docs**: `ARCHITECTURE.md` (update), `DATABASE_DESIGN.md`, `LOCAL_DEVELOPMENT.md`, `SECURITY.md` (initial),
    ADR-001…013 in `docs/adr/`. Stubs for `API_DESIGN.md`, `REVIEW_WORKFLOW.md`, `APPROVAL_WORKFLOW.md`, `DEPLOYMENT.md`.

### 3.2 Phase 1 acceptance criteria

- `pnpm nx run-many -t lint typecheck test build` passes for all projects.
- `docker compose up -d` brings up healthy Postgres and Redis.
- `pnpm nx run database:migrate` applies the initial migration.
- `api` `/health/ready` returns 200 with DB and Redis up, and 503 when either is down.
- The worker processes a heartbeat job enqueued by the API (integration test).
- The dashboard builds in production mode and shows API health.
- `ai-review --version` runs.
- No `--force` / `--legacy-peer-deps`, no peer-dependency warnings left unexplained.
- No secrets in the repo. `.env` is git-ignored.

### 3.3 Explicitly out of scope for Phase 1

Authentication flows, AI provider calls, Git provider adapters, the review pipeline, findings, approvals,
dashboard feature screens, CI/CD pipelines, deployment manifests.

## 4. Risks and open questions

| Risk                                                      | Mitigation                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `@nx/nest` generator scaffolds NestJS 11 packages         | Align to 12.x after generation and verify peers                                            |
| Angular 22.3.0 is very new (2026-11-18)                   | Pin exact; bump to the next 22.3.x patch if needed                                         |
| C: drive has 14 GB free and Docker's WSL disk lives there | Move Docker disk image to D: (Docker Desktop → Settings → Resources → Disk image location) |
| Redis 8 licence terms                                     | Valkey is a drop-in alternative; decide before production (Phase 8)                        |
| Nest + Vitest decorator metadata                          | SWC plugin; Jest fallback per ADR-012                                                      |

## 5. Prerequisite commands (PowerShell)

```powershell
# 1. Start Docker Desktop (required) and wait for the engine
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
docker info --format '{{.ServerVersion}}'   # re-run until it prints a version

# 2. Enable Windows long paths (recommended; run PowerShell as Administrator)
New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
git config --global core.longpaths true

# 3. See what is on port 4200 (optional)
Get-Process -Id (Get-NetTCPConnection -LocalPort 4200 -State Listen).OwningProcess

# 4. Optional, for Phases 4–5
winget install --id GitHub.cli -e
winget install --id GLab.GLab -e

# 5. Later phases: set API keys for the current user (never commit them)
#    [Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', '<value>', 'User')
#    [Environment]::SetEnvironmentVariable('OPENAI_API_KEY',    '<value>', 'User')
```

Phase 4/5 will also need a GitLab test project with a token, a GitHub account to register a GitHub App,
and a public tunnel for webhooks during local development (smee.io or cloudflared).

## 6. Phase 1 results (2026-11-23)

### 6.1 Acceptance criteria

| Criterion                                                                     | Result                                                                                                                             |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `nx run-many -t lint typecheck test build` passes for all projects            | ✅ 10 projects (4 apps, 6 libs); 47 unit tests                                                                                     |
| `docker compose up -d` brings up healthy Postgres and Redis                   | ✅ `postgres:18.7-alpine`, `redis:8.10.3-alpine`, healthchecks, bound to 127.0.0.1                                                 |
| Initial migration applies                                                     | ✅ `init_tenancy_foundation` (5 tables + CHECK constraints + append-only audit trigger)                                            |
| `/api/health/ready` returns 200 with DB and Redis up, 503 when either is down | ✅ Integration test (200) + manual outage test: Redis stopped → 503 within 4 ms, `/live` stays 200, recovers after restart         |
| Worker processes a heartbeat job                                              | ✅ Integration test: `SystemQueueProducer` (the API's producer) → Redis → `SystemProcessor`; idempotent job ids                    |
| Dashboard builds in production mode and shows API health                      | ✅ Production build (initial 76 kB transfer, status page chunk 8.5 kB); dev server + `/api` proxy verified against the running API |
| `ai-review --version` runs                                                    | ✅ built CLI prints `0.1.0`; unknown commands exit 1                                                                               |
| No `--force` / `--legacy-peer-deps`; peer warnings explained                  | ✅ strict peers on; one scoped peer rule and one Nx patch, both documented                                                         |
| No secrets in repo; `.env` git-ignored                                        | ✅ `.env` generated locally with random passwords; verified ignored                                                                |
| Integration tests                                                             | ✅ 14 tests (database 6, api 6, worker 2) via `pnpm test:integration`                                                              |
| Built bundles run outside Nx                                                  | ✅ `node dist/apps/api/main.js` and `dist/apps/worker/main.js` start in production mode with JSON logs                             |

### 6.2 Deviations from the approved plan (all recorded as ADRs)

| Planned                                | Actual                                                | Why                                                                                                                           |
| -------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| NestJS 12.x                            | **NestJS 11.2.11**                                    | `@nx/nest@24.0.6` peer `@nestjs/* <12`; overriding would hide an incompatibility (ADR-014)                                    |
| Nx 24.0.6 unmodified                   | **Nx 24.0.6 + one-line pnpm patch**                   | Angular 22.3's new `exports` map breaks Nx's deep import; no stable Nx fix yet; Angular 22.3 is a fixed requirement (ADR-015) |
| `create-nx-workspace` template         | Hand-written root config + official Nx generators     | Template ignored flags, installed Nx 24.0.0, added 8 AI-agent folders (ADR-001)                                               |
| `scope:server` covers CLI-usable libs  | Added `scope:node`                                    | CLI may use configuration/security but never database/queue (ADR-017)                                                         |
| Full Zod everywhere                    | `zod/mini` for browser-safe libs                      | Status page chunk 460 kB → 27 kB (ADR-005)                                                                                    |
| —                                      | React 19.3.1 as a dev dependency                      | Peer of Prisma Studio only; not used by any app                                                                               |
| Worker: one `system` queue + heartbeat | As planned; worker does not connect to PostgreSQL yet | No DB-backed job exists in Phase 1                                                                                            |

### 6.3 Known limitations / follow-ups

- No authentication yet (Phase 7); the only endpoints are unauthenticated health probes.
- Worker has no health endpoint (Phase 8).
- Windows: Nx generators must be run from Git Bash (or followed by `pnpm install`) — see LOCAL_DEVELOPMENT.md.
- Remove `patches/nx@24.0.6.patch` and upgrade NestJS to 12 once a stable Nx release supports both.
- Windows long paths are still disabled on this machine (admin action, optional).
