# Project Plan — AI Code Review Agent

> Status: **Phase 7 complete — awaiting approval for Phase 8.** Last updated: 2026-11-24.
> Results: Phase 1 in [§6](#6-phase-1-results-2026-11-23), Phase 2 in [§7](#7-phase-2-results-2026-11-23), Phase 3 in [§8](#8-phase-3-results-2026-11-23), Phase 4 in [§9](#9-phase-4-results-2026-11-23), Phase 5 in [§10](#10-phase-5-results-2026-11-23), Phase 6 in [§11](#11-phase-6-results-2026-11-24), Phase 7 in [§12](#12-phase-7-results-2026-11-24).

## 1. Phase overview

| Phase | Name                                               | Status                      |
| ----- | -------------------------------------------------- | --------------------------- |
| 0     | Environment and workspace inspection               | ✅ Complete (this document) |
| 1     | Project foundation                                 | ✅ Complete (2026-11-23)    |
| 2     | Local Git integration + CLI                        | ✅ Complete (2026-11-23)    |
| 3     | AI review engine (Claude + GPT, validation, dedup) | ✅ Complete (2026-11-23)    |
| 4     | GitLab integration                                 | ✅ Complete (2026-11-23)    |
| 5     | GitHub App integration                             | ✅ Complete (2026-11-23)    |
| 6     | Approval and fix workflow                          | ✅ Complete (2026-11-24)    |
| 7     | Angular dashboard (feature build-out)              | ✅ Complete (2026-11-24)    |
| 8     | Production readiness                               | ⏳ Awaiting approval        |

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

## 7. Phase 2 results (2026-11-23)

Branch: `feature/phase-2-local-git` (based on `feature/phase-1-foundation`).

### 7.1 Roadmap items

| Roadmap item                      | Delivered                                                                                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Git adapter                 | `@acra/git-providers-local`: read-only `LocalGitProvider` (git CLI via simple-git strict mode, hardened per ADR-020)                                                                                              |
| Repository and branch information | Root, branch (or detached), HEAD (or none), base-branch detection, masked remote URL                                                                                                                              |
| Staged and unstaged changes       | `staged`, `unstaged` (± untracked), plus `committed`, `branch` (without checkout) and `all` scopes                                                                                                                |
| Compare branches                  | merge-base semantics, so later commits on the base branch are not shown as changes                                                                                                                                |
| Diff parser                       | `parseUnifiedDiff` / `parseHunks`: renames, copies, binary, mode changes, quoted/unicode paths, CRLF, no-EOL-newline, combined diffs skipped, truncated hunks safe                                                |
| Repository context service        | `buildReviewContext`: exclusions, binary/size checks, merged surrounding-line windows, file/byte budgets, omission reasons, deterministic SHA-256 context hash                                                    |
| Initial CLI commands              | `ai-review init`, `status`, `changes` (+ `--repo` for multiple repositories), see [CLI.md](./CLI.md)                                                                                                              |
| Repository configuration          | `ai-review.yaml` schema and loader (strict, approvals cannot be relaxed; ADR-021)                                                                                                                                 |
| Unit and integration tests        | 137 unit tests pass, 1 skipped (Phase 1: 47) across 14 projects; 43 integration tests (database 6, api 6, worker 2, **local git 19, CLI 10**). The git and CLI suites run against real temporary git repositories |

### 7.2 Verification

- `pnpm check` (lint, typecheck, unit tests, build): all 14 projects pass.
- `pnpm test:integration`: 43 tests in 5 projects pass. The git and CLI suites need only `git`, not Docker.
- The built CLI (`node dist/apps/cli/main.js`) was run against this repository: `status` and
  `changes --base feature/phase-1-foundation` give correct results.
- Security tests: a hostile `core.fsmonitor` command is never executed, `--base --upload-pack=…` is rejected,
  path traversal is rejected, and the repository is byte-for-byte unchanged after every read operation.

### 7.3 Deviations and decisions

| Item                                          | Decision                                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `review` / `findings` / `report` CLI commands | **Deferred to Phase 3.** They need the AI engine. `changes` shows the exact review input instead. No placeholders were registered. |
| Single `GitProvider` interface                | Split into capability ports (ADR-019). Only the Phase 2 read ports exist.                                                          |
| `tools/testing`                               | Became Nx project `@acra/testing` so specs can import `TempGitRepo` without relative paths (boundary rule).                        |
| Review categories                             | All 10 categories from Module D are allowed values (the brief's finding model listed 6). `init` writes all 10.                     |
| New dependencies                              | simple-git 4.1.0, yaml 2.9.1, picomatch 4.0.7 (+ types). Exact pins, no peer issues.                                               |

### 7.4 Known limitations / follow-ups

- The symlink-escape unit test is skipped on this Windows machine (symlink creation needs Developer Mode). It runs on Linux.
- Untracked files over the size limit are listed as `too large`. Their content is never read.
- `diff --cc` (unmerged files during a merge or rebase conflict) is skipped. Resolve conflicts before reviewing.
- Nx flagged `database:prisma-generate` as flaky once (a single failure right after `nx reset`). Four consecutive
  reruns passed, so the cause was not reproduced.
- The CLI build resolves third-party packages from the workspace `node_modules`. A standalone distributable
  (bundled dependencies, `bin` entry) is planned for Phase 8.

## 8. Phase 3 results (2026-11-23)

Branch: `feature/phase-3-ai-review-engine` (based on `feature/phase-2-local-git`).

### 8.1 Roadmap items

| Roadmap item                             | Delivered                                                                                                                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integrate Claude                         | `ai-providers-claude`: `claude-opus-5-5`, adaptive thinking + `effort: high`, streamed, `output_config.format` json_schema, cached system prompt, server-side refusal fallback, typed error mapping, cost from list prices |
| Integrate GPT                            | `ai-providers-openai`: Responses API, strict json_schema, `store: false`, refusal/incomplete handling, configurable model and prices                                                                                       |
| Parallel execution                       | LangGraph `StateGraph` with `Send` fan-out; per-provider timeout; failures isolated (`partial` status)                                                                                                                     |
| Structured outputs                       | One shared Zod schema → JSON Schema (portable subset, tested), re-validated locally                                                                                                                                        |
| Aggregation / validation / deduplication | `review-engine`: Module E rules, evidence matching, speculation/style filters, line-independent fingerprints, clustering, capped agreement bonus, recorded disagreement                                                    |
| Confidence & severity                    | Deterministic adjustments, thresholds from `ai-review.yaml`                                                                                                                                                                |
| Static analysis                          | Secrets + risky-API checks on added lines (no repository code executed)                                                                                                                                                    |
| Review reports                           | `ReviewReport` schema; text, JSON and escaped Markdown renderers                                                                                                                                                           |
| Finding lifecycle                        | Transition table, reconciliation (still present / resolved / user-suppressed), `ai-review dismiss`                                                                                                                         |
| CLI (Module A)                           | `review`, `findings`, `report`, `dismiss`, consent gate, `--fail-on` CI exit code 3, local history in `.git/ai-review/`                                                                                                    |
| Angular review intelligence (§11)        | Angular v22 guidance in the system prompt; Angular sanitizer-bypass static check                                                                                                                                           |

### 8.2 Verification

- `pnpm check`: lint, typecheck, unit tests and build pass for **19 projects**. **203 unit tests** pass, 1 skipped (the symlink test on Windows).
- `pnpm test:integration`: **52 tests** pass (database 6, api 6, worker 2, local git 19, CLI 19). The CLI suite runs
  real temporary git repositories with fake AI reviewers. It covers consent refusal and decline, the identical prompt for
  both models, secret redaction, the stored report, the unchanged working tree, partial and total provider failure,
  `--fail-on`, dismiss → suppressed on re-review, and resolved-after-fix.
- Built CLI smoke test on this repository: `review` without `--yes` refuses (exit 2) and shows "95 files, 391 KB, secrets
  redacted, to claude (claude-opus-5-5 via api.anthropic.com)". Nothing was sent and nothing was stored. GPT without
  `OPENAI_REVIEW_MODEL` is skipped with a clear message.
- **Not verified against the real APIs:** no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` is configured on this machine.
  Opt-in live tests exist (`pnpm nx run ai-providers-claude:live`, `ai-providers-openai:live`) and were skipped.
  Request shapes are checked by the SDKs' TypeScript types and by unit tests with mocked clients.

### 8.3 Deviations and decisions

| Item                    | Decision                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| GPT default model       | **None.** `OPENAI_REVIEW_MODEL` is required; GPT is skipped without it (ADR-024)                                 |
| Claude refusal fallback | Enabled by default (`fallbacks: "default"`); recorded as `servedByModel` (ADR-024)                               |
| Review DB tables        | Moved to Phase 4 (worker), local `.git/ai-review/` store for the CLI (ADR-025)                                   |
| Static analysis         | Built-in pattern checks only; repository linters/tests run in the Phase 6 sandbox (untrusted code)               |
| Review categories       | All 10 from Module D (`error_handling`, `concurrency`, `data_consistency`, `scalability` added to the brief's 6) |
| `ai-review dismiss`     | New command (Module F requires dismissing false positives locally)                                               |
| Live API tests          | Opt-in targets, never part of `pnpm check` (they cost money)                                                     |

### 8.4 Known limitations / follow-ups

- First real runs should be watched for prompt quality and cost, and `minimumConfidence` / effort may need tuning.
  This needs API keys.
- Speculation and style filters are keyword heuristics. They are tested, but will need tuning against real reviews.
- Custom repository rules (free text in `ai-review.yaml`) are not supported yet. They need an injection-resistant design.
- Claude cost estimates use the serving model's list price for the whole turn. When a fallback ran, the actual bill
  may differ slightly.

## 9. Phase 4 results (2026-11-23)

Branch: `feature/phase-4-gitlab` (based on `feature/phase-3-ai-review-engine`).

### 9.1 Roadmap items

| Roadmap item             | Delivered                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configure authentication | Project/bot access token (api scope), envelope-encrypted per connection (ADR-011); per-repository webhook secrets stored as SHA-256                                                               |
| Connect repositories     | Operator command `admin.js connect-gitlab`: SSRF-validated host, access check, encrypted connection, repository upsert, hook registration (or manual), audit. Idempotent, rotates the hook secret |
| Webhook processing       | `POST /api/webhooks/gitlab/:repositoryId`: token hash, project id match, event/action filter, replay protection, 2 MB body, enqueue only (ADR-028)                                                |
| Fetch MR changes         | `GitLabProvider`: MR + diff_refs, paginated `/diffs` → shared diff model (binary/withheld diffs flagged, unsafe paths dropped), raw files at SHA with streaming size cap                          |
| Trigger reviews          | `reviews` queue (BullMQ), job id per (repository, MR, head SHA); worker `MergeRequestReviewService` runs the Phase 3 pipeline with `ai-review.yaml` at the head SHA                               |
| Publish inline comments  | Discussions with diff-derived positions (old_line for context lines); rejected positions fall back to the summary                                                                                 |
| Publish summaries        | One summary note per MR, updated in place                                                                                                                                                         |
| Track findings           | `review_findings` lifecycle per fingerprint (PUBLISHED/RESOLVED…), sessions, executions, comments, audit log                                                                                      |
| Handle new commits       | Re-review per head SHA; fixed findings → thread resolved + `RESOLVED`; superseded commits skipped; MR head re-checked before publishing                                                           |

### 9.2 Verification

- `pnpm check`: lint, typecheck, unit tests and build pass for **23 projects**. **267 unit tests** pass, 1 skipped.
- `pnpm test:integration`: **69 tests** pass. New in this phase:
  - **Worker end to end (7):** real worker, PostgreSQL and Redis against the fake GitLab HTTP server, with a fake AI
    reviewer. Covers:
    - the inline comment landing on the right line, plus one summary;
    - every database record (session, executions, findings, comments, audit);
    - an idempotent re-run;
    - a superseded commit being skipped;
    - the fixed commit resolving the thread and updating the same summary;
    - disabled and invalid config;
    - tenant isolation;
    - a full pass through BullMQ.
  - **API webhook (8):** real HTTP covering:
    - connect-gitlab with encrypted storage;
    - queued, duplicate and ignored deliveries;
    - the identical 401 for bad token, unknown repository and project mismatch;
    - a re-review on push;
    - a 300 kB payload;
    - token rotation;
    - SSRF refusal.
  - **GitLab adapter (13, unit tier):** against the fake server. Covers pagination, 429 retry, redirect refusal,
    the SSRF policy, inline position rules, summary upsert, resolve, and hook reuse.
- The built `api`, `worker` and `admin` bundles start in production mode, and the worker now connects to
  PostgreSQL.
- **Not verified against a real GitLab instance.** No GitLab token is configured on this machine. See
  [GITLAB.md](./GITLAB.md) for the steps.

### 9.3 Deviations and decisions

| Item                    | Decision                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| GitLab client           | Small typed `fetch` client instead of `@gitbeaker/rest` (SSRF/redirect/size control) — ADR-027        |
| Connecting repositories | Operator command, not an HTTP API: there is no authenticated management API until Phase 7             |
| Shared reviewer factory | `createReviewers` moved from the CLI to `@acra/ai-providers-factory` (used by the CLI and the worker) |
| Quick-action defence    | Added after analysis: GitLab executes `/merge` etc. from comment text as the bot (ADR-028)            |
| Drafts                  | Draft MRs are reviewed like any other open MR (a configurable skip can be added later)                |
| `background_jobs` table | Not created: BullMQ plus `review_sessions` / `webhook_deliveries` already give durable job state      |

### 9.4 Known limitations / follow-ups

- **Real GitLab verification** needs a token and a public URL (tunnel).
- **Rate limiting on the webhook endpoint** is planned for Phase 8.
- **SSRF:** a DNS-rebinding window remains between the check and the connection. A pinned-address agent is
  planned for Phase 8.
- **Manual review triggers** (a comment command or the API) are not implemented. Reviews start from webhooks only.
- **Dismissing findings on GitLab:** resolving a thread by hand does not yet mark the finding `DISMISSED`.
  That needs note/discussion events, planned for Phase 7 together with the dashboard.

## 10. Phase 5 results (2026-11-23)

Branch: `feature/phase-5-github` (based on `feature/phase-4-gitlab`).

### 10.1 Roadmap items

| Roadmap item                  | Delivered                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub App authentication     | RS256 App JWT (`node:crypto`), installation tokens per job scoped to one repository and contents:read / pull_requests:write / metadata:read, cached in memory (ADR-029) |
| Installation & repo discovery | `admin.js connect-github --org --installation`: verifies the installation, stores the connection (no secret), registers repositories, deactivates revoked ones          |
| Webhook processing            | `POST /api/webhooks/github`: HMAC over the raw body, installation-based routing, PR action filter, replay protection, installation lifecycle sync (ADR-030)             |
| Fetch PR changes              | `GitHubProvider`: PR + merge base (compare API), paginated files → shared diff model (binary / withheld patches flagged, unsafe paths dropped), raw files at SHA        |
| Trigger reviews               | Same `reviews` queue; job `provider` is now `gitlab` or `github`; worker picks the adapter through `HostedProviderFactory`                                              |
| Publish review comments       | PR review comments on diff lines (`line`, `side: RIGHT`, head commit); 422 → summary fallback                                                                           |
| Publish summaries             | One issue comment per PR, updated in place                                                                                                                              |
| Track findings / new commits  | Shared with GitLab: lifecycle per fingerprint; fixed findings resolve the review thread via GraphQL; superseded commits skipped; head re-checked before publishing      |

### 10.2 Verification

- `pnpm check`: lint, typecheck, unit tests and build pass for **24 projects**. **287 unit tests** pass, 1 skipped.
- `pnpm test:integration`: **81 tests** pass. New in this phase:
  - **Worker end to end, GitHub (5):** real worker and PostgreSQL against the fake GitHub App server (REST + GraphQL),
    fake AI reviewer. Covers the review comment on the right line plus one summary, repository-scoped token grants,
    idempotent re-run, superseded commit, the fixed commit resolving the thread and updating the same summary, and
    refusal of a provider-mismatched job.
  - **API webhook + connect-github (7):** real HTTP covering connect-github (no stored secret), refusal to claim an
    installation owned by another organization, queued and duplicate deliveries, 401 for missing / wrong /
    re-serialised signatures, ignored events, auto-registration of a new repository, `installation_repositories`
    sync and uninstall.
  - **GitHub adapter (11, unit tier):** against the fake server — JWT auth and wrong-key rejection, token scope and
    caching, out-of-scope repository, file mapping, raw files, positions, GraphQL resolve, summary upsert, rate-limit
    retry, SSRF refusal.
- The GitLab suite still passes unchanged after the worker was generalised.
- The built `api` bundle starts (GitHub webhook answers 404 while unconfigured) and `admin.js connect-github` runs.
- **Not verified against real GitHub.** No GitHub App is registered for this machine. See [GITHUB.md](./GITHUB.md).

### 10.3 Deviations and decisions

| Item            | Decision                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| GitHub client   | Small typed `fetch` client instead of Octokit (supersedes the ADR-027 note) — ADR-029                              |
| Credentials     | No per-connection secret for GitHub; schema allows null token with a CHECK constraint per provider                 |
| Webhook routing | One App URL; routing by signed installation + repository id; new repositories auto-registered — ADR-030            |
| Shared errors   | `ProviderApiError` / `InlinePositionRejectedError` moved to `git-providers-core`; retry policy is provider-neutral |
| Worker service  | `MergeRequestReviewService` is provider-agnostic; adapters are built by `HostedProviderFactory`                    |
| Drafts          | Draft PRs are reviewed (as for GitLab); `ready_for_review` also triggers a review                                  |

### 10.4 Known limitations / follow-ups

- **Real GitHub verification** needs a registered App, an installation and a public URL (tunnel).
- The PR files API is capped at 3,000 files by GitHub; larger PRs are reviewed partially.
- Manual thread resolution does not yet dismiss findings (Phase 7, with the dashboard).
- Rate limiting of the webhook endpoint and a pinned-address agent against DNS rebinding remain Phase 8 items.

## 11. Phase 6 results (2026-11-24)

Branch: `feature/phase-6-approval-workflow` (based on `feature/phase-5-github`).

### 11.1 Roadmap items

| Roadmap item                | Delivered                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generate fix proposals      | `@acra/fix-engine`: one model, one finding, one file; line edits validated deterministically; patch computed by the platform; protected paths; secrets redacted (ADR-031). CLI `fix propose`; worker when `fixes.enabled` |
| Display proposed patches    | CLI `fix propose/show` (coloured diff + unverified explanation); operator `fixes-show`; dashboard in Phase 7                                                                                                              |
| Implement approval requests | `@acra/approvals`: binding hash, approval codes, state machine, role policy, no merge (ADR-032); `approval_requests` table; CLI and operator commands                                                                     |
| Apply approved patches      | Local: exact patch bytes with `git apply` in an isolated worktree on a new branch, result hash verified. Hosted: content recomputed and hash-checked before the provider write                                            |
| Run tests                   | `@acra/sandbox`: allowlisted validation commands from `ai-review.yaml`, part of the apply approval; results shown and stored (ADR-033)                                                                                    |
| Stage approved changes      | CLI `fix stage` (exactly the fixed file; worktree state verified before and after approval)                                                                                                                               |
| Commit with approval        | CLI `fix commit` (bound message and parent; hooks disabled); hosted `commit_and_push_fix`                                                                                                                                 |
| Push with approval          | CLI `fix push` (exact commit, no force); hosted: new branch at the reviewed commit via provider API (ADR-034)                                                                                                             |
| Create MR/PR with approval  | CLI `fix open` (user token from env); hosted executor into the reviewed MR/PR's source branch; never merged                                                                                                               |

### 11.2 Verification

- `pnpm check`: lint, typecheck, unit tests and build pass for **27 projects**. **338 unit tests** pass, 1 skipped.
- `pnpm test:integration`: **257 tests** pass across 7 projects, 150 of them randomized `git apply` cases. New in
  this phase:
  - **CLI end to end (7):** real git, fake AI and fake GitLab.
    - propose (consent, nothing changed);
    - no approval without a terminal (exit 4), and a wrong code is refused;
    - apply with the code in an isolated worktree, with `npm test` validation;
    - a "no" changes nothing;
    - stage → commit → push to a bare remote → open MR (escaped body, never merged);
    - audit history;
    - invalidation by a newer reviewed commit.
  - **Worker (6):** fake GitLab.
    - automatic proposal after a review;
    - pending and VIEWER refusals;
    - a tampered operation is refused;
    - single-use commit of exactly the approved content;
    - MR into the reviewed branch;
    - head-moved invalidation and supersession.
  - **Admin approval service (4):** PostgreSQL and Redis.
    - membership checks;
    - bound request and VIEWER refusal;
    - approve once and enqueue;
    - reject;
    - newer-commit refusal;
    - the DB CHECK constraint.
  - **Local fix workspace (4):** real hooks are planted and are proven not to run; exact refspec push; discard.
  - **Validation runner (5):** real npm. Covers secret scrubbing, exit codes, timeout kill and the output cap.
  - **Unified diff property test (150):** random edits including CRLF files and files without a final newline;
    every patch applies byte for byte with `git apply`.
- Unit tests:
  - fix engine (16);
  - approvals state machine (7);
  - command policy (26);
  - GitLab and GitHub writers against the fakes (GitHub: a read token cannot write).
- The built `cli` (`fix --help`) and `admin` (approval commands) bundles run.
- **Not verified against real GitLab or GitHub, and not with paid AI models.** The flows are verified with fakes
  and real Git.

### 11.3 Deviations and decisions

| Item                           | Decision                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Patch generation               | Model returns line edits; the platform renders the diff (ADR-031)                                                                       |
| Hosted apply/stage/commit/push | One approved remote write (`commit_and_push_fix`): there is no working tree on the server (ADR-034)                                     |
| Fix MR/PR target               | The reviewed MR/PR's source branch, not the default branch                                                                              |
| Server-side decisions          | Operator CLI with `--user` + approval code until Phase 7 authentication (ADR-032)                                                       |
| Validation isolation           | Allowlist + scrubbed env + limits, approved by a human; no OS-level sandbox yet (Phase 8). Server runs no repository commands (ADR-033) |
| GitHub App permissions         | Contents: Read and write; write tokens only for approved executions (ADR-029 update)                                                    |
| Hosted fix generation          | Opt-in (`fixes.enabled: false` by default) because it spends AI credits                                                                 |

### 11.4 Known limitations / follow-ups

- Fixes are limited to one file and one local region.
- Approval UI, notifications and API endpoints for fixes and approvals are planned for Phase 7.
- The hosted summary comment does not yet mention available fix proposals (Phase 7, with the dashboard link).
- An OS-level sandbox for validation commands is planned for Phase 8.

## 12. Phase 7 results (2026-11-24)

Branch: `feature/phase-7-dashboard` (based on `feature/phase-6-approval-workflow`).

### 12.1 Roadmap items

| Roadmap item             | Delivered                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication           | Password sign-in (scrypt), server-side sessions in an HttpOnly SameSite=Strict cookie, session-bound CSRF token, absolute and idle expiry, lockout and attempt limits, invitation/reset links, password change, operator bootstrap commands (`users-create`, `users-setup-link`, `users-set-password`) (ADR-035) |
| Organization management  | Create (the creator becomes OWNER), rename, organization switcher; membership and role checked on every request (non-members get 404)                                                                                                                                                                            |
| Team and user management | Members page: invite with a single-use setup link, change roles, remove, issue reset links. Only OWNERs manage owners, nobody edits their own membership, the last OWNER is kept                                                                                                                                 |
| Repository management    | Repository list with webhook state and last review; pause or resume reviews per repository                                                                                                                                                                                                                       |
| Git provider connections | Connection list (never credentials). GitLab projects connect from the dashboard with a write-only token (needs `CREDENTIALS_MASTER_KEY` for the API). GitHub installations still connect through the operator CLI (the API holds no App private key)                                                             |
| AI provider settings     | Organization policy switches per provider plus observed provider status (last run, last error, 30-day counts). Keys stay in the worker environment                                                                                                                                                               |
| Review configuration     | `organization_settings`: pause reviews, allow fix proposals, severity and confidence floors. The worker applies them per review and they can only tighten `ai-review.yaml` (ADR-036)                                                                                                                             |
| Review history           | Paginated reviews with repository/outcome filters; details with model executions (tokens, latency, cost, error kind), findings and comment counts                                                                                                                                                                |
| Findings                 | Severity, status, category and repository filters; details with evidence and suggestion as untrusted text; triage to dismissed / false positive (compare-and-set, audited)                                                                                                                                       |
| Approval management      | Open/all lists; details with exactly what will happen, commit and patch hash. Approving needs the request's code typed back (same state machine as the CLI); rejecting with a reason                                                                                                                             |
| Fix proposals            | List and details with the exact platform-computed patch (safe diff view); request approval for the next step (push / open). Merging is never offered                                                                                                                                                             |
| Analytics                | Reviews, new findings, false-positive rate, pending approvals; daily charts; breakdowns by severity, category, outcome and fix status                                                                                                                                                                            |
| Usage and cost           | Tokens and estimated cost per provider/model, daily cost, fix-proposal cost, unpriced runs flagged                                                                                                                                                                                                               |
| Audit logs               | Append-only log with event-type filter and keyset pagination (ADMIN+); secret-like metadata keys are hidden                                                                                                                                                                                                      |

Angular 22.3: standalone components, signals and `computed`, `inject()`, `@if`/`@for`/`@switch`, reactive forms,
`httpResource` (stable since 22.0) with Zod-validated responses, every page lazy-loaded, strict templates, and
accessible states (live regions, labelled controls, a table alongside each chart, keyboard focus). No UI library
was added. Initial bundle: 361 kB raw / 97 kB transferred.

### 12.2 Verification

- `pnpm check`: lint, typecheck, unit tests and build pass for **27 projects**. **369 unit tests** pass, 1 skipped
  (Phase 6: 338). New:
  - organization policy (6);
  - password, cookie, CSRF and limiter primitives (11);
  - dashboard (14): interceptor (CSRF only on writes and only to our API, 401 handling), login (validation, return
    URL, no open redirect, error), findings (filters, error/retry, model text cannot inject markup), approval
    detail (code required, CSRF sent, viewers get no decision), diff view.
- `pnpm test:integration`: **277 tests** pass across 7 projects (Phase 6: 257). New:
  - **Dashboard API (19):** real API, PostgreSQL, Redis and fake GitLab. Covers:
    - deny by default;
    - identical answers for unknown e-mail and wrong password;
    - cookie flags; CSRF refusal; lockout; logout revocation;
    - organization creation; 404 for non-members;
    - invitation link used exactly once;
    - role enforcement (member, admin, owner rules; no self-edit);
    - policy validation and audit;
    - repositories pause; review list and detail with costs; finding filters and triage;
    - approval only with the exact code, and only once;
    - analytics and usage numbers; provider status;
    - GitLab connect with a write-only token, a rejected bad token and a blocked SSRF target;
    - cross-tenant 404 on nested resources.
  - **Worker (1):** a paused organization skips reviews, and a provider disabled by the policy is never requested.
- Live smoke test: the built API and the dashboard dev server, driven over HTTP through the dev proxy. A user
  created with the operator CLI signed in; a write without CSRF was refused; an organization was created; all 14
  organization endpoints returned 200; the audit entry was present; after logout the session was rejected.
- **Not verified in a real browser.** The pages are covered by component tests and the API by integration tests;
  no visual check was done.

### 12.3 Deviations and decisions

| Item                        | Decision                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Authentication method       | Local password accounts with server-side sessions. SSO (OIDC/GitLab/GitHub) can be added later on the same session model (ADR-035) |
| E-mail                      | None. Invitations and resets produce single-use links that an admin shares                                                         |
| "AI provider configuration" | A policy, not key management: keys stay in the worker environment; the dashboard shows observed status (ADR-036)                   |
| "Review configuration"      | An organization policy that only tightens `ai-review.yaml`; no per-repository overrides in the database                            |
| GitHub connection           | Remains an operator command, because the API holds no GitHub App private key (ADR-029)                                             |
| Rate limiting               | Only sign-in and setup attempts are limited (per process). Global rate limiting stays in Phase 8                                   |
| `approvals-admin`           | Now takes an organization slug (CLI) or an authorized tenant (API); both use the same functions                                    |

### 12.4 Open items for Phase 8

- Cluster-wide rate limiting, security audit (including the dashboard), and a production cookie and proxy setup
  (`SESSION_COOKIE_SECURE`, `TRUST_PROXY_HOPS`, HTTPS).
- Container images and deployment of the dashboard; Content-Security-Policy for the static site.
- Optional: e-mail delivery for invitations, SSO, and GitHub installation linking from the dashboard.
