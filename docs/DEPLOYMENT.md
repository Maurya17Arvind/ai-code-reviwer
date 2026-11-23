# Deployment

> Status: **not implemented** — Phase 8. Only local development infrastructure exists (`docker-compose.yml`).

Known requirements collected so far:

- Node 24.15+ runtime images for `api` and `worker` (built artifacts in `dist/apps/*`; Nx `prune` targets
  produce a pruned `package.json` + lockfile per app).
- `prisma migrate deploy` as a release step, executed with a migration role; the runtime role has no DDL rights in production.
- Managed PostgreSQL 18 and Redis 8 (or Valkey — see ADR-008) with TLS (`rediss://`).
- Secrets from a secret manager / KMS (credential master key, provider keys); no `.env` files in images.
- Health probes: `/api/health/live` (liveness), `/api/health/ready` (readiness); worker probe to be added.
- Static hosting for `dist/apps/dashboard/browser` with SPA fallback and strict CSP.
