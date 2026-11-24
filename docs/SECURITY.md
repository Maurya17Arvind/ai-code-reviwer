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

## 2e. Controls implemented in Phase 6 (fixes and approvals)

| Control                                                                                                                                                         | Where                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Every code/Git change needs a human approval of that exact operation; no merge operation exists anywhere                                                        | `@acra/approvals` (ADR-032), DB enum without MERGE         |
| Approvals bound by SHA-256 over user, org, repository, session, commit, operation, patch hash and expiry; re-verified at approval and execution                 | `computeBindingHash`, `beginExecution`                     |
| Single use: compare-and-set transitions; execution jobs never retried                                                                                           | `ApprovalStore.transition`, `approvals` queue (attempts 1) |
| New reviewed commit invalidates open approvals and supersedes unapplied fixes; executor checks the live MR/PR head                                              | `invalidateForHead`, `ApprovalExecutionService`            |
| Only OWNER/ADMIN/MEMBER humans decide; VIEWERs and system actors cannot; decisions audited with the member id                                                   | state machine, `audit_logs.actor_user_id`                  |
| Model output never becomes a diff, command, branch name or unescaped text: line edits validated, patch computed, branch generated, titles plain, bodies escaped | `fix-engine` (ADR-031), `fix-text.ts`                      |
| Protected files (CI, hooks, manifests, lockfiles, Docker/Make, .env, keys, ai-review.yaml) are never fixed automatically                                        | `PROTECTED_PATH_GLOBS`                                     |
| Secrets redacted before fix prompts; fixes may not touch redacted lines                                                                                         | `generateFix`                                              |
| Local fixes in an isolated worktree/branch; repository hooks disabled; pushes exact refspec, never forced                                                       | `LocalFixWorkspace` (ADR-033)                              |
| Validation commands: allowlist, argv without shell, denied redirect flags, scrubbed env, 10-min limit with tree kill, output cap; shown in the approval         | `@acra/sandbox` (ADR-033)                                  |
| Hosted writes only on `ai-review/fix-*`, never move existing branches; GitHub write tokens only for approved executions, repo-scoped                            | `RepositoryWriter`, `WRITE_TOKEN_PERMISSIONS` (ADR-034)    |
| No repository code runs on the server                                                                                                                           | worker design                                              |

Residual risks:

- Local validation commands run as the user, without OS-level isolation. They are shown and approved first, and
  an optional container runner is planned for Phase 8.
- Hosted approval decisions are made in the dashboard (Phase 7) or through the operator CLI.

## 2f. Controls implemented in Phase 7 (dashboard)

| Control                                                                                                                                                                                                                              | Where                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Deny by default: a global guard requires a session on every route except `@Public()` ones (health, webhooks, login, password setup)                                                                                                  | `SessionGuard` (ADR-035)                      |
| Passwords hashed with scrypt (N=2^17, r=8, p=1, per-hash salt and parameters, rehash on sign-in); 12–200 characters, NFKC-normalised                                                                                                 | `auth/password.ts`                            |
| Server-side sessions: random 256-bit token in an HttpOnly, SameSite=Strict cookie (`__Host-` + Secure in production); only its hash stored                                                                                           | `user_sessions`, `session-token.ts`           |
| Absolute and idle session expiry; logout and password changes revoke sessions server-side                                                                                                                                            | `AuthService.authenticate`                    |
| CSRF: session-bound token required in `X-CSRF-Token` on every non-GET request; login accepts JSON only                                                                                                                               | `SessionGuard`, `csrfTokenFor`                |
| Lockout after 5 failures (15 min, in the database), plus per-IP and per-e-mail attempt limits; identical answers for unknown e-mails, wrong passwords and locked accounts                                                            | `AuthService.login`, `AttemptLimiter`         |
| Tenant isolation: `/organizations/:orgId` checked against membership on every request; non-members get 404; every store query filters by `organization_id`                                                                           | `OrganizationGuard`, stores (ADR-010)         |
| Roles: ADMIN+ manages members, repositories, connections and policy; MEMBER+ triages findings and decides approvals; only OWNERs manage owners; nobody edits their own membership; the last OWNER is kept (serializable transaction) | `OrganizationsService`, `OrganizationStore`   |
| Dashboard approvals need the request's code typed back and run through the same state machine as the CLI                                                                                                                             | `ApprovalsService` (ADR-032)                  |
| Invitation and reset links: single use, 72 h, hash stored, token only in the URL fragment, earlier links voided                                                                                                                      | `user_setup_tokens`, `setup-password-page.ts` |
| GitLab tokens entered in the dashboard are write-only: validated, envelope-encrypted, never returned or logged; the base URL passes the SSRF policy                                                                                  | `RepositoriesService.connectGitLab`           |
| The organization policy can only tighten `ai-review.yaml` (AND / max) and never relaxes approvals                                                                                                                                    | `applyOrganizationPolicy` (ADR-036)           |
| Tenant API responses carry `Cache-Control: no-store`; validation errors name fields but never echo values; 5xx responses stay generic                                                                                                | `configureApp`, `ZodValidationPipe`           |
| Dashboard: untrusted text (model output, file paths, patches) is rendered by interpolation only, never `innerHTML`; every response is validated against shared Zod contracts; return URLs must stay inside the app                   | dashboard                                     |
| Audit: identity events (platform level) and every organization change, with request id and client IP; metadata with secret-like keys is hidden in the audit view                                                                     | `audit_logs`, `InsightsController`            |

Residual risks:

- The attempt limits are per process. Cluster-wide rate limiting for all endpoints is Phase 8.
- Setup links are handed over by an admin, because there is no e-mail delivery yet. Anyone holding a link can set that
  user's password until the link is used or expires.
- `TRUST_PROXY_HOPS` must match the deployment. Otherwise audit logs and attempt limits see the proxy's address.

### Development-only relaxations (must not reach production)

- `acra_app` has `CREATEDB` so `prisma migrate dev` can create a shadow database. Production roles: no `CREATEDB`; migrations via `migrate deploy`.
- Local passwords are random per machine (generated into `.env`), not shared.

## 3. Planned controls (by phase)

| Control                                                                                                      | Phase |
| ------------------------------------------------------------------------------------------------------------ | ----- |
| SSRF protection for self-hosted GitLab URLs (scheme allowlist, private-range blocking, DNS rebinding checks) | 4     |
| Envelope-encrypted credentials (ADR-011)                                                                     | 4     |
| OS-level isolation for validation commands (container, no network, CPU/memory limits)                        | 8     |
| AuthN/AuthZ and CSRF for cookie sessions: done in Phase 7; global rate limiting (`@nestjs/throttler`)        | 8     |
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
