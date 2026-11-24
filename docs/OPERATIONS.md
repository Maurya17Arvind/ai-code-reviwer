# Operations runbook

> Added in Phase 8 (2026-11-24). How to watch, troubleshoot and recover the platform.

## 1. Key metrics (Prometheus)

| Metric                                                 | Source | Use                                                  |
| ------------------------------------------------------ | ------ | ---------------------------------------------------- |
| `acra_http_requests_total{method,route,status}`        | api    | traffic, error rate (5xx), 429 rate (rate limiting)  |
| `acra_http_request_duration_seconds{method,route}`     | api    | latency per route template                           |
| `acra_queue_jobs{queue,state}`                         | api    | backlog (`waiting`), stuck work (`active`), `failed` |
| `acra_reviews_total{outcome}`                          | worker | completed / partial / failed / skipped / superseded  |
| `acra_review_duration_seconds{outcome}`                | worker | review latency (minutes for local models)            |
| `acra_ai_executions_total{provider,status,error_kind}` | worker | provider failures, e.g. `quota_exceeded`, `timeout`  |
| `acra_approval_executions_total{status}`               | worker | approved writes executed or failed                   |
| `acra_maintenance_actions_total{action}`               | worker | recovered stuck reviews, expired approvals           |
| `acra_process_*`                                       | both   | memory and uptime                                    |

## 2. Recommended alerts

| Alert                   | Condition (example)                                                                             | First steps                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| API errors              | `rate(acra_http_requests_total{status=~"5.."}[5m]) / rate(acra_http_requests_total[5m]) > 0.02` | API logs by `requestId`; readiness probe        |
| Review backlog          | `acra_queue_jobs{queue="reviews",state="waiting"} > 20` for 15 min                              | Worker running? Scale workers; provider latency |
| AI provider failing     | `increase(acra_ai_executions_total{status="failed"}[30m]) > 5`                                  | Check `error_kind`: quota, timeout, unavailable |
| Credit exhausted        | `increase(acra_ai_executions_total{error_kind="quota_exceeded"}[1h]) > 0`                       | Add provider credit or disable it in the policy |
| Stuck reviews recovered | `increase(acra_maintenance_actions_total{action="stuckReviewsFailed"}[1h]) > 0`                 | Worker crashes or OOM kills; check worker logs  |
| Readiness failing       | API or worker `/health/ready` ≠ 200 for 2 min                                                   | PostgreSQL / Redis reachability                 |
| Rate limiting spikes    | `rate(acra_http_requests_total{status="429"}[5m])` well above normal                            | Attack or misconfigured `TRUST_PROXY_HOPS`      |

## 3. Common situations

**Reviews do not appear on a merge/pull request**

1. API logs: was the webhook accepted? (`Queued merge request review` / webhook status in
   `webhook_deliveries`). A 401 means a wrong webhook secret or token; GitHub shows deliveries under the
   App's Advanced tab, GitLab under Settings → Webhooks.
2. Worker running and ready? `GET :3001/health/ready`.
3. Review status in the dashboard (Reviews): `skipped` shows the reason (policy paused, repository
   inactive, `review.enabled: false`); `failed` shows the error code.

**A provider fails (`quota_exceeded`, `timeout`, `unavailable`)**

The review is published with the remaining providers (`partial`). If none succeeded it is `failed`, and
previous findings are not marked resolved. Fix the provider (credit, model name, local resources) or turn
it off in the organization policy.

**Worker crashed during a review**

Maintenance marks reviews RUNNING longer than 2× `AI_REVIEW_TIMEOUT_MS` (at least 30 min) as FAILED
(`worker_interrupted`). BullMQ retries stalled jobs. Otherwise a new commit triggers a new review.

**A user is locked out or forgot their password**

Lockout clears automatically after 15 minutes. An admin issues a reset link from Members (or
`admin.js users-setup-link --email …`); using it signs out all sessions of that user.

**Rotate secrets**

- `GITHUB_WEBHOOK_SECRET`: change it in the GitHub App and the API environment together.
- GitLab tokens: reconnect the project in the dashboard (Repositories → Connect GitLab project). This also
  rotates the webhook token.
- `METRICS_TOKEN`: update the API, the worker and the Prometheus scrape configuration together.
- `CREDENTIALS_MASTER_KEY`: envelope encryption supports a key id (`kid:base64`). Re-encryption of stored
  tokens is a planned operator command; until then reconnect connections after a key change.

## 4. Data retention

- Audit logs are append-only (database trigger) and never deleted by the platform.
- Expired or revoked sessions and used or expired setup links are deleted 7 days after expiry.
- Review sessions, findings, executions and fixes are kept; delete per organization only with a
  deliberate, audited operator procedure (not provided yet).

## 5. Load test

`node tools/load-test/load-test.mjs --base <api url> --findings 20000` against a disposable database with
`RATE_LIMIT_ENABLED=false`. Baseline on the development laptop (2026-11-24, 20,000 findings, 20 concurrent
clients): list endpoints p95 under 100 ms; analytics p95 169 ms; usage p95 93 ms.
