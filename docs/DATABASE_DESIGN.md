# Database Design

> PostgreSQL 18.7 · Prisma 7.10.1 · Last updated: 2026-11-23
> Schema: `libs/database/prisma/schema.prisma` · Migrations: `libs/database/prisma/migrations/`

## 1. Conventions

| Topic            | Rule                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary keys     | `uuid` generated as **UUIDv7** (time-ordered, index-friendly, not guessable as sequences)                                                                 |
| Naming           | Prisma models in PascalCase; tables/columns in snake_case via `@@map`/`@map`                                                                              |
| Timestamps       | `timestamptz(3)`; `created_at` default `now()`, `updated_at` maintained by Prisma                                                                         |
| Tenancy          | Every tenant-owned table has `organization_id uuid not null` FK + leading index (ADR-010)                                                                 |
| Soft deletion    | `deleted_at timestamptz null` on user-facing aggregates (organizations, users, repositories). Queries exclude deleted rows by default (repository layer). |
| Deletes          | FKs use `ON DELETE RESTRICT`; history is preserved, removal is soft                                                                                       |
| Enums            | PostgreSQL enums, mirrored by `zod/mini` enums in `@acra/shared-types` (drift is caught by a unit test)                                                   |
| Integrity in SQL | Constraints Prisma cannot express (CHECK, triggers) are appended to migrations and listed below                                                           |
| Roles            | App connects as non-superuser `acra_app` (owner of the app DB). Bootstrap superuser is only for container init.                                           |
| Pagination       | Keyset (cursor) pagination on `(created_at, id)` — UUIDv7 makes `id` monotonic; offsets are not used for large tables                                     |
| Transactions     | Multi-row invariants use interactive transactions; job handlers are idempotent so retries are safe                                                        |

## 2. Implemented in Phase 1 (`init_tenancy_foundation`)

```text
organizations 1───* organization_members *───1 users
      │
      ├──* repositories
      └──* audit_logs (organization_id nullable for platform events) *───0..1 users (actor)
```

| Table                  | Key columns                                                                                                                                                            | Constraints / indexes                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`        | `name`, `slug`                                                                                                                                                         | `slug` unique; CHECK `slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`                                                                                                               |
| `users`                | `email`, `display_name`                                                                                                                                                | `email` unique; CHECK `email = lower(email)`                                                                                                                           |
| `organization_members` | `organization_id`, `user_id`, `role` (`OWNER/ADMIN/MEMBER/VIEWER`)                                                                                                     | unique `(organization_id, user_id)`; index `user_id`                                                                                                                   |
| `repositories`         | `organization_id`, `provider` (`GITHUB/GITLAB/LOCAL`), `external_id`, `full_name`, `default_branch`, `web_url`, `is_active`                                            | unique `(organization_id, provider, external_id)`; index `(organization_id, is_active)`                                                                                |
| `audit_logs`           | `organization_id?`, `actor_type` (`USER/SYSTEM/WEBHOOK`), `actor_user_id?`, `action`, `target_type`, `target_id?`, `metadata jsonb`, `request_id?`, `ip_address inet?` | indexes `(organization_id, created_at desc)`, `(actor_user_id, created_at desc)`, `(target_type, target_id)`; **UPDATE/DELETE/TRUNCATE rejected by trigger** (ADR-018) |

Verified by `libs/database/src/lib/database.integration.spec.ts` (relations, unique membership, CHECK constraints,
append-only trigger, non-superuser connection).

## 2b. Implemented in Phase 4 (`phase4_reviews_gitlab`)

| Table                  | Key columns                                                                                                                                                                                     | Constraints / indexes                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `provider_connections` | `organization_id`, `provider`, `name`, `base_url`, `encrypted_token` (envelope, AAD = connection id), `token_key_id`                                                                            | unique `(organization_id, provider, name)`           |
| `repositories` (+)     | `connection_id`, `webhook_secret_hash` (SHA-256), `webhook_id`                                                                                                                                  | FK to connection                                     |
| `review_sessions`      | `repository_id`, `request_id`, `base_sha`, `head_sha`, `context_hash`, `prompt_hash`, `status` (QUEUED/RUNNING/COMPLETED/PARTIAL/FAILED/SUPERSEDED/SKIPPED), `report` jsonb, error code/message | unique `idempotency_key` (provider:repo:MR:head SHA) |
| `model_executions`     | provider, model, served model, status, error kind, tokens, `cost_micros`, latency                                                                                                               | CHECK status                                         |
| `review_findings`      | lifecycle per `(repository_id, request_id, fingerprint)`, `status` (NEW…FALSE_POSITIVE), `first_seen_sha`, `last_seen_sha`, `sources[]`, `placement`                                            | unique triple; CHECK severity/placement/confidence   |
| `review_comments`      | provider discussion/note ids, kind INLINE/SUMMARY, finding                                                                                                                                      | FKs to session and finding                           |
| `webhook_deliveries`   | `provider`, `delivery_id`, event, status ACCEPTED/IGNORED/REJECTED, reason                                                                                                                      | unique `(provider, delivery_id)` (replay protection) |

Tenant-scoped access goes through `ReviewStore` / `ConnectionStore`. Their methods take a `TenantContext` and
filter by `organization_id` (ADR-010). The webhook path resolves the repository by id first, as the trust
anchor, then switches to tenant scope.

## 2c. Implemented in Phase 5 (`phase5_github_app`)

| Table                  | Change                                                                                                     | Constraints / indexes                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `provider_connections` | + `installation_id`, `account_login`; `encrypted_token` / `token_key_id` now nullable (GitHub stores none) | unique `(provider, installation_id)`; CHECK `provider_connections_credentials_chk` (GitLab ⇒ token, GitHub ⇒ installation id) |

GitHub repositories use `repositories.external_id` = GitHub repository id; `webhook_secret_hash` stays null
(the App has one webhook secret, held by the API environment). Review tables are shared by both providers;
idempotency keys are prefixed with the provider.

## 2d. Implemented in Phase 6 (`phase6_fixes_approvals`)

| Table               | Key columns                                                                                                                                                                                                                                                                           | Constraints / indexes                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proposed_fixes`    | `finding_id`, `review_session_id`, `request_id`, `base_sha`, `target_branch`, `explanation`, `changes` jsonb, `patch`, `patch_sha256`, `original_sha256`, `result_sha256`, `status` (PROPOSED/APPLIED/OPENED/SUPERSEDED/REJECTED), `branch`, `commit_sha`, `review_request_url`       | FKs to org/session/finding; CHECK counts + hash format, branch `ai-review/fix-*`; index `(repository_id, request_id, status)`                            |
| `approval_requests` | `review_session_id`, `proposed_fix_id`, `request_id`, `head_sha`, `operation_kind` (no MERGE value), `operation` jsonb, `patch_sha256`, `binding_hash`, `status`, `requested_by_id`/`requested_by`, `decided_by_id`/`decided_by`, `decided_at`, `expires_at`, `executed_at`, `result` | FKs to users; CHECK patch bound for fix writes, decider for decided states, expiry ≤ 7 days, hash formats; index `(organization_id, status, expires_at)` |

`audit_logs` now records human actions with `actor_type = USER` and `actor_user_id`. `ApprovalStore` applies every
status change with compare-and-set on the previous status and the binding hash.

## 2e. Implemented in Phase 7 (`phase7_auth_dashboard`)

| Table                   | Key columns                                                                                                                                                                           | Constraints / indexes                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `users` (altered)       | + `password_hash` (scrypt, null until set), `password_changed_at`, `failed_login_count`, `locked_until`, `last_login_at`                                                              | —                                                                           |
| `user_sessions`         | `user_id`, `token_hash` (SHA-256 of the cookie token), `expires_at`, `last_seen_at`, `revoked_at`, `ip_address`, `user_agent`                                                         | unique `token_hash`; index `(user_id, expires_at)`                          |
| `user_setup_tokens`     | `user_id`, `token_hash`, `purpose` (INVITE/RESET), `created_by_id`, `expires_at`, `used_at`                                                                                           | unique `token_hash`; consumed with compare-and-set on `used_at IS NULL`     |
| `organization_settings` | PK `organization_id`; `reviews_enabled`, `allow_claude`, `allow_openai`, `allow_ollama`, `allow_fix_proposals`, `minimum_severity_floor`, `minimum_confidence_floor`, `updated_by_id` | CHECK severity in (critical, high, medium, low); CHECK confidence in [0, 1] |

Sessions and setup links store only hashes. Platform-level identity events go to `audit_logs` with
`organization_id = NULL`. Dashboard lists use keyset pagination over `(created_at desc, id desc)` with opaque cursors.

## 3. Target model (added in the phase that uses it)

> Review tables moved from Phase 3 to Phase 4 (ADR-025): in Phase 3 only the local CLI runs reviews, and it stores
> `ReviewReport`s in `.git/ai-review/`. The tables mirror that report shape.

| Table                        | Phase | Purpose / notable columns                                                                                                                                                                                                 |
| ---------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_connections`       | 4/5   | Org-level GitLab/GitHub connection: `kind`, `base_url` (SSRF-validated), `encrypted_credentials` (ciphertext, iv, tag, key_version — ADR-011), `webhook_secret_encrypted`, `github_installation_id`                       |
| `repositories.connection_id` | 4/5   | FK to `provider_connections` (nullable for LOCAL)                                                                                                                                                                         |
| `repository_configs`         | 4     | Validated `ai-review.yaml` snapshot per repo + commit SHA, `config_hash`, server-side overrides                                                                                                                           |
| `review_sessions`            | 4     | `repository_id`, `trigger` (local/webhook/manual), `request_ref` (MR/PR iid), `base_sha`, `head_sha`, `context_hash`, `status` (`QUEUED/RUNNING/PARTIAL/COMPLETED/FAILED/SUPERSEDED`), `idempotency_key` unique           |
| `model_executions`           | 4     | `review_session_id`, `provider`, `model`, `status`, `input_tokens`, `output_tokens`, `cost_micros`, `latency_ms`, `error_code`, `raw_output_ref`                                                                          |
| `review_findings`            | 4     | Fields of the `ReviewFinding` schema + `fingerprint` (indexed with `repository_id`), `status` lifecycle (`NEW/VALIDATED/PUBLISHED/RESOLVED/DISMISSED/FALSE_POSITIVE`), `model_sources`, `first_seen_sha`, `last_seen_sha` |
| `review_comments`            | 4/5   | Published comment ↔ finding mapping: `provider_comment_id`, `discussion_id`, `kind` (inline/summary), `body_hash` (duplicate suppression)                                                                                 |
| `review_feedback`            | 4+    | User feedback on findings (helpful / false positive + reason)                                                                                                                                                             |
| `background_jobs`            | 4     | Durable record of queued work: `queue`, `job_id`, `idempotency_key` unique, `status`, `attempts`, `last_error_code`                                                                                                       |

Indexes are added with each table based on its query patterns; every list endpoint gets a supporting
`(organization_id, …, created_at desc, id)` index for keyset pagination.

## 4. Secure credential storage

No credential is stored in plain text. Encryption/decryption happens only in the backend credential
service (ADR-011); the dashboard receives `{ configured: boolean, lastRotatedAt }` style metadata only.

## 5. Operations

| Command                                                | Purpose                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `pnpm nx run database:prisma-generate`                 | Regenerate the client (also runs on `pnpm install` and before dependent targets)                   |
| `pnpm db:migrate:dev`                                  | Create/apply migrations in development (uses a shadow DB — requires `CREATEDB`, dev only)          |
| `pnpm nx run database:migrate-create -- --name <name>` | Create a migration without applying (to append hand-written SQL)                                   |
| `pnpm db:migrate`                                      | Apply pending migrations (`prisma migrate deploy`) — the only command for shared/prod environments |
| `pnpm db:status`                                       | Show migration status                                                                              |
| `pnpm db:studio`                                       | Prisma Studio (dev only)                                                                           |
