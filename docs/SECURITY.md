# Security

> Status: initial (Phase 1). Last updated: 2026-11-23. This document grows with each phase; Phase 8 includes a full security audit.

## 1. Trust boundaries

| Input                                                                         | Trust                                                 | Handling                                                                                 |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Dashboard users                                                               | Authenticated (Phase 7), authorised per org/repo/role | Server-side authorisation on every request                                               |
| Webhooks (GitLab/GitHub)                                                      | Untrusted until signature verified (Phases 4–5)       | HMAC / token verification, constant-time compare, delivery-ID idempotency                |
| Repository code, diffs, commit messages, MR/PR titles, descriptions, comments | **Untrusted data**                                    | Never interpreted as instructions; delimited in prompts; cannot authorise operations     |
| AI model output                                                               | **Untrusted data**                                    | Zod-validated; findings pass deterministic validators; suggested commands never executed |
| Queue payloads (Redis)                                                        | Untrusted                                             | Re-validated by consumers; malformed jobs fail permanently                               |
| Environment configuration                                                     | Trusted operator input                                | Validated at startup; values never printed                                               |

## 2. Controls implemented in Phase 1

| Control                                                                                     | Where                                   |
| ------------------------------------------------------------------------------------------- | --------------------------------------- |
| Fail-fast env validation without echoing values (tested with a secret in invalid input)     | `@acra/configuration`                   |
| Secrets only in `.env` (git-ignored); `.env.example` documents variables with placeholders  | repo root                               |
| Log redaction of auth headers, webhook secret headers and secret-named keys                 | `@acra/security`, `createLoggerOptions` |
| URL credential masking helper (never echoes unparseable input)                              | `maskUrlCredentials`                    |
| HTTP hardening: helmet headers, no `X-Powered-By`, CORS allowlist (http/https origins only) | `apps/api/src/app/configure-app.ts`     |
| Generic 5xx responses, no stack traces / SQL / driver messages to clients                   | `AllExceptionsFilter`                   |
| Health endpoints expose only coarse status (`reason: timeout\|error`)                       | `HealthService`                         |
| Request-ID validation (rejects injected header values)                                      | `AppModule`                             |
| PostgreSQL: app runs as non-superuser role; `PUBLIC` cannot create in `public` schema       | `infrastructure/database/init`          |
| Append-only audit log enforced by DB triggers                                               | migration `init_tenancy_foundation`     |
| Redis requires a password; ports bound to `127.0.0.1` only                                  | `docker-compose.yml`                    |
| Queue payload validation on producer and consumer                                           | `@acra/queue`, `SystemProcessor`        |
| Module boundaries: browser and CLI cannot import server infrastructure                      | ESLint `enforce-module-boundaries`      |

## 2a. Controls implemented in Phase 2 (local Git + CLI)

| Control                                                                                                                                                          | Where                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Git spawned without a shell; simple-git strict mode blocks command-executing options and strips `GIT_*`/pager env vars                                           | `LocalGitProvider` (ADR-020)                     |
| Hostile repository config neutralised: `core.fsmonitor=false`, `--no-ext-diff`, `--no-textconv`, pinned prefixes/quoting/relative settings                       | `LocalGitProvider`                               |
| Git ref validation: blocks option injection (`--upload-pack=…`), ranges, reflog/blob selectors                                                                   | `assertSafeGitRef` (`@acra/security`)            |
| Path safety: no absolute paths or `..`; symlinks must resolve inside the repository                                                                              | `normalizeRepoRelativePath`, `resolveInsideRepo` |
| Resource limits: 1 MB per file read, 50 MB per diff, 30 s per git process, context budgets (files, bytes)                                                        | `LocalGitProvider`, `buildReviewContext`         |
| Binary sniffing; binary files are never loaded into the review context                                                                                           | `LocalGitProvider`, `buildReviewContext`         |
| Credentials in `origin` URLs are masked before output                                                                                                            | `getRepositoryInfo`                              |
| `ai-review.yaml` treated as untrusted: strict schema, enum-only prompt-bound values, size and alias limits, approvals cannot be relaxed, merge cannot be enabled | `@acra/configuration` (ADR-021)                  |
| Read-only CLI: no command that stages, commits, pushes or merges; `init` writes only `ai-review.yaml` (`wx`, no overwrite without `--force`)                     | `apps/cli`                                       |

Verified by integration tests against real git, including a hostile `core.fsmonitor` command that must never run,
option injection through `--base`, path traversal, and "repository unchanged after every operation".
The symlink-escape test is skipped on Windows machines without Developer Mode (symlink creation needs it) and runs on Linux CI.

## 2b. Controls implemented in Phase 3 (AI review engine)

| Control                                                                                                                             | Where                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Explicit consent before any code leaves the machine (`--yes` or interactive yes); destinations shown                                | `ai-review review` (ADR-023)                                          |
| Secret redaction of every diff line/snippet before prompting; secrets reported as critical findings with redacted evidence          | `redactContext`, `runStaticAnalysis`                                  |
| Prompt-injection defence: untrusted content inside nonce-delimited blocks, "data not instructions" rules, fixed schema              | `buildReviewPrompt`                                                   |
| Model output never trusted: Zod re-validation, path normalisation (traversal rejected), deterministic validators decide publication | `parseModelOutput`, `aggregateFindings`, `validateFindings` (ADR-022) |
| No execution of repository code or model-suggested commands (static analysis is pattern-based)                                      | `review-engine`                                                       |
| Model text rendered safely: terminal control characters stripped; Markdown escaped                                                  | `safeTerminalText`, `escapeMarkdown`                                  |
| Repository `.env` never loaded by the CLI (prevents `*_BASE_URL` exfiltration)                                                      | `apps/cli`                                                            |
| OpenAI `store: false`; LangSmith tracing force-disabled unless explicitly allowed                                                   | adapters, `disableThirdPartyTracing`                                  |
| Timeouts per provider, SDK retries bounded, output caps (findings, text length), refusal handling                                   | adapters, review graph                                                |
| Local review history inside `.git/`, owner-only file modes, atomic writes, schema-validated reads                                   | `LocalReviewStore`                                                    |

## 2c. Controls implemented in Phase 4 (GitLab)

| Control                                                                                                                     | Where                                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Provider tokens envelope-encrypted (AES-256-GCM, per-record data key, AAD = connection id); decrypted only in worker memory | `envelope-crypto.ts`, `gitLabProviderFromConnection` (ADR-011)         |
| Per-repository webhook secret stored as SHA-256, constant-time compare; identical 401 for every auth failure                | `GitLabWebhookService` (ADR-028)                                       |
| Payload project id must match the repository (no cross-project token reuse)                                                 | `GitLabWebhookService`                                                 |
| Replay protection (unique delivery ids); idempotent jobs and sessions per head SHA                                          | `webhook_deliveries`, `reviewJobId`, `review_sessions.idempotency_key` |
| SSRF guard for GitLab URLs: https, host allowlist, DNS-resolved private/reserved ranges blocked, no redirects               | `assertSafeOutboundUrl`, `GitLabClient` (ADR-027)                      |
| GitLab quick actions and @mentions neutralised in every comment; Markdown escaped                                           | `publishing/sanitize.ts` (ADR-028)                                     |
| Duplicate markers trusted only on bot-authored notes                                                                        | `indexBotComments`                                                     |
| Inline positions derived from the diff, never from model output; superseded results never published                         | `planPublication`, worker re-check                                     |
| Webhook jobs carry ids only; `ai-review.yaml` read at the reviewed SHA and validated (invalid → permanent failure)          | queue schema, worker                                                   |
| Tenant isolation: jobs whose organization does not own the repository are rejected; stores filter by organization           | `MergeRequestReviewService`, `ReviewStore`                             |
| Admin token input only via environment (never argv)                                                                         | `admin.ts`                                                             |
| Every review and connection is audited (append-only)                                                                        | `audit_logs`                                                           |

Residual risks (Phase 8):

- DNS rebinding between the SSRF check and the connection (planned fix: a pinned-address agent);
- the webhook endpoint has no rate limiting yet;
- the master key comes from an environment variable (planned: a KMS).

## 2d. Controls implemented in Phase 5 (GitHub App)

| Control                                                                                                                       | Where                                                      |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| GitHub App only (no PATs); App permissions limited to contents:read, pull_requests:write, metadata:read                       | docs/GITHUB.md (ADR-029)                                   |
| Per-job installation tokens scoped to the single reviewed repository and the minimal permissions; cached in memory only       | `GitHubAppAuth`, `HostedProviderFactory`                   |
| No secret stored per GitHub connection; App private key only in the worker/admin environment, never given to the API          | `resolveGitHubAppSettings`, `ApiConfigSchema`              |
| Webhook HMAC-SHA256 verified over the raw body in constant time before parsing; 404 when unconfigured                         | `verifyWebhookSignature`, `GitHubWebhookService` (ADR-030) |
| Routing only by signed installation + repository ids, only for operator-connected installations; one organization per install | `findGitHubRepository`, `saveGitHubConnection`             |
| Uninstall / suspend / repository removal deactivates access immediately; audited                                              | `GitHubWebhookService`                                     |
| Replay protection on `X-GitHub-Delivery`; idempotent jobs and sessions per head SHA                                           | `webhook_deliveries`, `reviewJobId`                        |
| Same outbound discipline as GitLab: SSRF policy, no redirects, same-origin `Link` pagination, size caps, bounded retries      | `GitHubClient`                                             |
| Duplicate markers trusted only on comments by the App's bot login; model text escaped, @mentions neutralised                  | `GitHubProvider.listComments`, `publishing/sanitize.ts`    |
| Job provider must match the repository's provider                                                                             | `MergeRequestReviewService`                                |

### Development-only relaxations (must not reach production)

- `acra_app` has `CREATEDB` so `prisma migrate dev` can create a shadow database. Production roles: no `CREATEDB`; migrations via `migrate deploy`.
- Local passwords are random per machine (generated into `.env`), not shared.

## 3. Planned controls (by phase)

| Control                                                                                                      | Phase |
| ------------------------------------------------------------------------------------------------------------ | ----- |
| SSRF protection for self-hosted GitLab URLs (scheme allowlist, private-range blocking, DNS rebinding checks) | 4     |
| Envelope-encrypted credentials (ADR-011)                                                                     | 4     |
| Approval workflow: SHA-bound, expiring, patch-hash-bound approvals; merge never implemented                  | 6     |
| Sandboxed fix validation: temp worktree, command allowlist, CPU/memory/time limits, no network               | 6     |
| AuthN/AuthZ, rate limiting (`@nestjs/throttler`), CSRF strategy for cookie sessions                          | 7–8   |
| Dependency scanning, container hardening, RLS evaluation, security audit                                     | 8     |

## 4. Data sent to external AI providers (implemented in Phase 3)

See [REVIEW_WORKFLOW.md §7](./REVIEW_WORKFLOW.md) and ADR-023. Only with explicit consent, and only:

- diff hunks of included files;
- bounded surrounding lines;
- paths and statuses;
- names of omitted files;
- the review instructions.

Secrets are redacted before the prompt is built. Excluded, binary and oversized files are never sent, and
neither are `.env` files, credentials or local history. OpenAI requests use `store: false`. Third-party
(LangSmith) tracing is force-disabled. Destinations, including custom `*_BASE_URL` hosts, are shown before
consent.

## 5. Reporting

Security issues should be reported privately to the maintainers; do not open public issues.
