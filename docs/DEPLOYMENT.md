# Deployment

> Status: **implemented in Phase 8** (2026-11-24). Images and the compose deployment are validated in CI
> (`.github/workflows/ci.yml`). They were not built on the development machine (disk space), and no
> production environment exists yet.

## 1. Components

| Component   | Image / source                                                       | Port                  | Scales               |
| ----------- | -------------------------------------------------------------------- | --------------------- | -------------------- |
| `api`       | `infrastructure/docker/node-app.Dockerfile` (`APP=api`)              | 3000 (internal)       | horizontally         |
| `worker`    | same Dockerfile (`APP=worker`)                                       | 3001 health / metrics | horizontally         |
| `migrate`   | same Dockerfile, target `migrate` (one-shot `prisma migrate deploy`) | —                     | run once per release |
| `dashboard` | `infrastructure/docker/dashboard.Dockerfile` (nginx, unprivileged)   | 8080 (public)         | horizontally         |
| PostgreSQL  | 18.x (managed recommended)                                           | 5432 (private)        | managed              |
| Redis       | 8.x with `noeviction`, AOF (managed recommended)                     | 6379 (private)        | managed              |

Only the dashboard container is exposed. It serves the SPA and proxies `/api` (including the GitLab and
GitHub webhooks) to the API, so the platform has a single public origin. TLS is terminated in front of
it (load balancer, ingress or reverse proxy), which should also send HSTS.

## 2. Single-host deployment (Docker Compose)

```bash
cp .env.production.example .env.production      # fill in every value; never commit it
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml logs -f api worker
```

Startup order: postgres and redis become healthy, then `migrate` applies migrations, then api, worker and
dashboard start. Required secrets are enforced; compose refuses to start with empty values.

First user (no e-mail delivery):

```bash
docker compose -f docker-compose.prod.yml exec api node dist/apps/api/admin.js users-create --email you@example.com --name "You"
docker compose -f docker-compose.prod.yml exec api node dist/apps/api/admin.js users-setup-link --email you@example.com
```

## 3. Configuration

All configuration is environment variables, validated at start-up. Invalid configuration stops the process
with a list of problems; values are never echoed. See `.env.production.example`, plus:

| Variable                                          | Where       | Notes                                                                                                                             |
| ------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `DASHBOARD_PUBLIC_URL`, `WEBHOOK_PUBLIC_BASE_URL` | api         | Public https origin; used in setup links and GitLab hook URLs                                                                     |
| `SESSION_COOKIE_SECURE=true`                      | api         | `__Host-` cookie, HTTPS only (default in production)                                                                              |
| `TRUST_PROXY_HOPS`                                | api         | Compose: 1. nginx accepts X-Forwarded-For only from `TRUSTED_PROXY_CIDR` and overwrites it, so clients cannot spoof their address |
| `RATE_LIMIT_*`                                    | api         | Per user / per IP / webhook limits per minute (Redis, cluster-wide)                                                               |
| `METRICS_TOKEN`                                   | api, worker | Bearer token for `/api/metrics` and the worker's `/metrics`                                                                       |
| `WORKER_HTTP_HOST`, `WORKER_HTTP_PORT`            | worker      | Health and metrics endpoint                                                                                                       |
| `MAINTENANCE_INTERVAL_MS`                         | worker      | Stuck-review recovery, approval expiry, session purge (default 5 min)                                                             |
| `AI_REVIEW_TIMEOUT_MS`                            | worker      | Per-provider review timeout                                                                                                       |

Secrets (`CREDENTIALS_MASTER_KEY`, provider keys, `GITHUB_APP_PRIVATE_KEY`, database and Redis
passwords) belong in a secret manager and are injected at runtime. Images contain no `.env` files
(`.dockerignore`).

## 4. Probes and monitoring

| Probe                | Endpoint                                | Meaning                                              |
| -------------------- | --------------------------------------- | ---------------------------------------------------- |
| API liveness         | `GET /api/health/live`                  | process is serving                                   |
| API readiness        | `GET /api/health/ready`                 | PostgreSQL and Redis reachable (503 otherwise)       |
| Worker liveness      | `GET :3001/health/live`                 | process is up                                        |
| Worker readiness     | `GET :3001/health/ready`                | PostgreSQL and Redis reachable                       |
| Dashboard            | `GET /healthz`                          | nginx is serving                                     |
| Metrics (Prometheus) | `GET /api/metrics`, `GET :3001/metrics` | `Authorization: Bearer $METRICS_TOKEN`; 404 if unset |

Recommended alerts are listed in [OPERATIONS.md](./OPERATIONS.md).

## 5. Release procedure

1. CI green on the pull request (checks, integration tests, image builds).
2. Build and push images tagged with the commit SHA (registry of your choice).
3. Run `migrate` with the new image. Migrations are additive in this project, so the previous release
   keeps working during a rolling update.
4. Roll out api, worker and dashboard. Workers finish their current job on SIGTERM
   (`stop_grace_period: 60s`); a review interrupted anyway is marked FAILED by maintenance and can be
   re-triggered with a new commit.

## 6. Production hardening checklist (deployment side)

- [ ] TLS in front of the dashboard; HSTS at the TLS proxy.
- [ ] Managed PostgreSQL with backups and point-in-time recovery; Redis with persistence (AOF).
- [ ] Separate migration role with DDL rights; the runtime role without `CREATEDB` (see SECURITY.md).
- [ ] Secrets in a secret manager; rotate `METRICS_TOKEN`, webhook secrets and provider tokens regularly.
- [ ] Prometheus scraping both metrics endpoints; alerts from OPERATIONS.md.
- [ ] Log shipping (JSON logs on stdout, secrets redacted).
- [ ] GitHub App webhook URL and GitLab hooks point at the public https origin.
