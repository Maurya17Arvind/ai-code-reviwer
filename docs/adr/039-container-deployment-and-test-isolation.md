# ADR-039: Container deployment from the workspace lockfile; isolated integration test targets

**Status:** Accepted · 2026-11-24

## Context

Phase 8 needs production images and a reproducible deployment. Two problems came up:

- The per-app `package.json` that Nx generates next to the bundle misses packages the bundle loads at
  runtime (`@prisma/client/runtime/*`, `tslib`). An image built from it would crash at start-up. It
  worked locally only because the monorepo's `node_modules` sits next to the build output.
- Integration tests shared the development database and Redis. A running development worker took jobs
  enqueued by tests, and test data accumulated in the development database.

## Decision

**Images**

- One Dockerfile for the API and the worker (`--build-arg APP=…`), and one for the dashboard.
- Dependencies are installed with `pnpm install --frozen-lockfile` from the workspace lockfile, the app is
  built with Nx, and `pnpm prune --prod` removes development dependencies. The runtime stage copies
  `node_modules` and the app's `dist` folder, runs as the non-root `node` user, and has a health check.
- A `migrate` target runs `prisma migrate deploy` as a one-shot release step.
- The dashboard is served by unprivileged nginx with a strict CSP (scripts from the same origin only;
  inline styles allowed because Angular component styles are inline). The same container proxies `/api`,
  so the platform has one public origin and SameSite=Strict cookies work without CORS.
- Base images are pinned to exact versions (`node:24.15.0-alpine3.22`,
  `nginxinc/nginx-unprivileged:1.29.3-alpine`).

**Test isolation**

- A Vitest global setup creates and migrates `<database>_test` on the same server and flushes Redis
  database 1. Integration test processes point `DATABASE_URL` and `REDIS_URL` at those targets
  (`ACRA_TEST_USE_DEV_DB=1` restores the old behaviour).
- The worker's HTTP server binds a free port in tests.

**CI**

- On pull requests: format check, `pnpm check`, migrations, integration tests against PostgreSQL and
  Redis service containers, and builds of all images (not pushed).

## Consequences

- Images include every production dependency of the workspace (including browser libraries, unused at
  runtime). They are larger than minimal per-app images, in exchange for reproducibility from one
  lockfile. Per-app pruning can come later, once the generated manifests are complete.
- Images were validated in CI only. They were not built on the development laptop because of disk space.
