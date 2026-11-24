# API Design

> Last updated: 2026-11-24 · Implemented endpoints are marked ✅.

## 1. Conventions

- Base path: `/api`. Versioning via path prefix (`/api/v1/...`) starts with the first business endpoint.
- JSON only. Request/response schemas are Zod schemas in `@acra/shared-contracts`, shared with the dashboard.
- Every request is validated server-side; the dashboard additionally validates responses.
- Errors use one envelope (`ApiErrorSchema`):

  ```json
  { "statusCode": 404, "error": "Not Found", "message": "Cannot GET /api/x", "requestId": "4f6c…" }
  ```

  5xx responses always carry the generic message `An unexpected error occurred.`; details are logged with the `requestId`.

- `X-Request-Id`: accepted if it matches `^[A-Za-z0-9-]{8,64}$`, otherwise generated; always echoed.
- Security headers via helmet; CORS restricted to `API_CORS_ORIGINS`.
- Pagination (from Phase 3): keyset — `?limit=50&cursor=<opaque>` → `{ items, nextCursor }`.
- Authentication/authorization (Phase 7 dashboard auth; webhook auth in Phases 4–5): every tenant endpoint
  is scoped as `/api/v1/organizations/:orgId/...` and checked against membership + role.

## 2. Endpoints

### ✅ `GET /api/health/live`

Process liveness. Never touches dependencies. `200 { status: "ok", timestamp }`. `Cache-Control: no-store`.

### ✅ `GET /api/health/ready`

Readiness: probes PostgreSQL (`SELECT 1`) and Redis (`INFO` over the BullMQ connection) in parallel, 2 s timeout each.

| Status | Body                                                                                                           |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| `200`  | `{ status: "ok", timestamp, checks: [{ name: "database", status: "up", latencyMs }, { name: "redis", ... }] }` |
| `503`  | same shape with `status: "unavailable"` and failing checks `{ status: "down", reason: "timeout" \| "error" }`  |

No versions, hostnames or driver messages are exposed. Contract: `ReadinessResponseSchema`.

### ✅ `POST /api/webhooks/gitlab/:repositoryId`

GitLab project hook (registered by `connect-gitlab`, see [GITLAB.md](./GITLAB.md)). Headers: `X-Gitlab-Token`,
`X-Gitlab-Event`, `X-Gitlab-Event-UUID`. Body: GitLab merge request event (2 MB max).

| Status | Body                             | When                                                                 |
| ------ | -------------------------------- | -------------------------------------------------------------------- |
| `202`  | `{ status: "queued", jobId }`    | MR opened / reopened / new commits                                   |
| `200`  | `{ status: "duplicate" }`        | delivery already processed                                           |
| `200`  | `{ status: "ignored", reason }`  | other events or actions, closed MR, inactive repository              |
| `401`  | ApiError `Invalid webhook token` | unknown repository, bad token, project mismatch (identical response) |

### ✅ `POST /api/webhooks/github`

The GitHub App webhook (one URL for all installations, see [GITHUB.md](./GITHUB.md) and ADR-030). Headers:
`X-Hub-Signature-256` (HMAC-SHA256 of the raw body), `X-GitHub-Event`, `X-GitHub-Delivery`. Body: 2 MB max.

| Status | Body                                 | When                                                                                                        |
| ------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `202`  | `{ status: "queued", jobId }`        | `pull_request` opened / reopened / synchronize / ready_for_review on an open PR                             |
| `200`  | `{ status: "duplicate" }`            | delivery already processed                                                                                  |
| `200`  | `{ status: "ignored", reason }`      | ping, other events/actions, closed PR, inactive repository, unknown installation; installation sync results |
| `401`  | ApiError `Invalid webhook signature` | missing or wrong signature                                                                                  |
| `404`  | ApiError                             | `GITHUB_WEBHOOK_SECRET` not configured                                                                      |

### ✅ Dashboard API (Phase 7, ADR-035)

All `/api/v1` routes need a session cookie unless noted, and every non-GET request needs `X-CSRF-Token`. Tenant routes
live under `/api/v1/organizations/:orgId` and are checked against membership: non-members get 404, and members below
the route's minimum role get 403. Request and response bodies are the Zod contracts in `@acra/shared-contracts`.
Lists use keyset pagination (`?limit=1–100&cursor=`) and return `{ items, nextCursor }`. Responses carry
`Cache-Control: no-store`.

| Method & path                                                                             | Min role       | Purpose                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/auth/login` (public)                                                            | —              | Sign in. Sets the session cookie and returns `SessionResponse` with the CSRF token. Gives the same 401 for unknown e-mail, wrong password and locked account; 429 when limited. |
| `GET /v1/auth/session`                                                                    | —              | Current user, memberships and CSRF token                                                                                                                                        |
| `POST /v1/auth/logout`                                                                    | —              | Revokes the session server-side (204)                                                                                                                                           |
| `POST /v1/auth/password`                                                                  | —              | Changes the password and revokes other sessions                                                                                                                                 |
| `POST /v1/auth/setup-password` (public)                                                   | —              | Accepts an invitation or reset token (single use)                                                                                                                               |
| `POST /v1/organizations`                                                                  | —              | Creates an organization; the caller becomes OWNER                                                                                                                               |
| `GET /:orgId` · `PATCH /:orgId`                                                           | VIEWER · ADMIN | Organization details · rename                                                                                                                                                   |
| `GET /:orgId/members`                                                                     | VIEWER         | Members with role, invitation state and last sign-in                                                                                                                            |
| `POST /:orgId/members`                                                                    | ADMIN          | Adds a member. New users get a setup link (shown once). Only OWNERs grant OWNER.                                                                                                |
| `PATCH` / `DELETE /:orgId/members/:memberId`                                              | ADMIN          | Changes the role or removes the member. Never your own membership, owners only by owners, the last OWNER stays.                                                                 |
| `POST /:orgId/members/:memberId/setup-link`                                               | ADMIN          | New invitation or password-reset link                                                                                                                                           |
| `GET` / `PUT /:orgId/settings`                                                            | VIEWER / ADMIN | Organization review policy (ADR-036)                                                                                                                                            |
| `GET /:orgId/ai-providers`                                                                | VIEWER         | Observed status per AI provider; policy flags                                                                                                                                   |
| `GET /:orgId/repositories` · `PATCH /:orgId/repositories/:id`                             | VIEWER · ADMIN | Repositories · pause or resume (`isActive`)                                                                                                                                     |
| `GET /:orgId/connections` · `GET /:orgId/integrations`                                    | VIEWER         | Connections (never credentials) · which connect flows the server supports                                                                                                       |
| `POST /:orgId/connections/gitlab`                                                         | ADMIN          | Connects a GitLab project with a write-only token. Needs `CREDENTIALS_MASTER_KEY`.                                                                                              |
| `GET /:orgId/reviews?repositoryId&status` · `GET /:orgId/reviews/:id`                     | VIEWER         | Review history · details with model executions, findings and comment counts                                                                                                     |
| `GET /:orgId/findings?severity&status&category&repositoryId` · `GET /:orgId/findings/:id` | VIEWER         | Findings · details with evidence, fixes and allowed transitions                                                                                                                 |
| `PATCH /:orgId/findings/:id`                                                              | MEMBER         | Marks a finding `dismissed` or `false_positive` (compare-and-set, audited)                                                                                                      |
| `GET /:orgId/fixes` · `GET /:orgId/fixes/:id`                                             | VIEWER         | Fix proposals · exact patch and next step                                                                                                                                       |
| `GET /:orgId/approvals?scope=open\|all` · `GET /:orgId/approvals/:id`                     | VIEWER         | Approval requests · description and approval code                                                                                                                               |
| `POST /:orgId/approvals`                                                                  | MEMBER         | Requests approval for a fix step (`push` / `open`)                                                                                                                              |
| `POST /:orgId/approvals/:id/approve` · `.../reject`                                       | MEMBER         | Decides a request. Approve needs `{ code }`, which must match the request.                                                                                                      |
| `GET /:orgId/analytics?days&repositoryId`                                                 | VIEWER         | Reviews, findings, false-positive rate, fixes and approvals; daily series                                                                                                       |
| `GET /:orgId/usage?days&repositoryId`                                                     | VIEWER         | Tokens and estimated cost per provider/model, daily cost, fix cost                                                                                                              |
| `GET /:orgId/audit-logs?action&cursor`                                                    | ADMIN          | Append-only audit log                                                                                                                                                           |
