# API Design

> Last updated: 2026-11-23 · Implemented endpoints are marked ✅.

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

### Planned (later phases)

| Area                       | Endpoints (indicative)                                                                                      | Phase                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------- |
| Organizations / members    | `/api/v1/organizations`, `/members`                                                                         | 7                     |
| Repositories & connections | `/api/v1/organizations/:orgId/repositories`, `/connections`                                                 | 4, 5, 7               |
| Reviews & findings         | `/reviews`, `/reviews/:id`, `/findings?severity=&status=`, `PATCH /findings/:id` (dismiss / false positive) | 3, 7                  |
| Approvals & fixes          | `/approvals`, `POST /approvals/:id/approve                                                                  | reject`, `/fixes/:id` | 6   |
| Analytics, usage, audit    | `/analytics`, `/usage`, `/audit-logs`                                                                       | 7                     |
