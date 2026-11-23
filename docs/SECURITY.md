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

### Development-only relaxations (must not reach production)

- `acra_app` has `CREATEDB` so `prisma migrate dev` can create a shadow database. Production roles: no `CREATEDB`; migrations via `migrate deploy`.
- Local passwords are random per machine (generated into `.env`), not shared.

## 3. Planned controls (by phase)

| Control                                                                                                                 | Phase |
| ----------------------------------------------------------------------------------------------------------------------- | ----- |
| Path-traversal-safe file access, bounded context extraction, exclude globs, secret scrubbing before AI calls            | 2–3   |
| Prompt-injection defences (data/instruction separation, output schema enforcement, no tool execution from model output) | 3     |
| Webhook signature verification (GitHub `X-Hub-Signature-256`, GitLab token), replay protection                          | 4–5   |
| SSRF protection for self-hosted GitLab URLs (scheme allowlist, private-range blocking, DNS rebinding checks)            | 4     |
| Envelope-encrypted credentials (ADR-011)                                                                                | 4     |
| Approval workflow: SHA-bound, expiring, patch-hash-bound approvals; merge never implemented                             | 6     |
| Sandboxed fix validation: temp worktree, command allowlist, CPU/memory/time limits, no network                          | 6     |
| AuthN/AuthZ, rate limiting (`@nestjs/throttler`), CSRF strategy for cookie sessions                                     | 7–8   |
| Dependency scanning, container hardening, RLS evaluation, security audit                                                | 8     |

## 4. Data sent to external AI providers (draft — finalised in Phase 3)

Only: the diff hunks under review, bounded surrounding context of changed files, file paths, and the
review instructions. Never: credentials, `.env` files, excluded paths, or files over configured size limits.
A secret scrubber runs before every provider call. Repository-level `ai-review.yaml` and org settings can
disable providers or the server mode entirely.

## 5. Reporting

Security issues should be reported privately to the maintainers; do not open public issues.
