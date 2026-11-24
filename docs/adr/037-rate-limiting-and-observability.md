# ADR-037: Redis-backed rate limiting and dependency-free observability

**Status:** Accepted · 2026-11-24

## Context

Phase 7 limited only sign-in attempts, in process memory. Production runs several API instances, so
limits must be shared. Operators also need metrics and a worker health endpoint (deferred in ADR-009).

## Decision

**Rate limiting**

- One fixed-window limiter backed by Redis: an atomic Lua `INCR` + `PEXPIRE` with keys under
  `acra:ratelimit:`. The API's existing Redis is used, with its own connection.
- It is applied inside `SessionGuard` to every request, **before** a 401 is returned. Guessing session
  tokens is therefore limited too; a separate guard after SessionGuard would never see rejected requests,
  a gap the first implementation had and its tests caught.
- Budgets per minute, configurable: 600 per signed-in user, 120 per IP without a session, 600 per IP for
  webhooks. Health probes and `/metrics` are exempt. Sign-in and password setup keep their strict per-IP
  and per-e-mail limits, now cluster-wide.
- The response is 429 with `Retry-After`; `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`
  headers are sent on every limited route.
- If Redis is unavailable (1 s command timeout), the limiter falls back to per-process limits instead of
  failing requests: losing Redis must not take the API down.

**Observability**

- `@acra/observability` is a small in-house Prometheus registry (counters, gauges, histograms, text format
  0.0.4) rather than `prom-client`. The needs are small, and it adds no dependency.
- Label values are fixed enums or Express route templates, never raw URLs or ids, so cardinality is
  bounded and no tenant data leaks into metrics.
- `/api/metrics` and the worker's `/metrics` need `Authorization: Bearer $METRICS_TOKEN` and answer 404
  when no token is configured.
- The worker gets a tiny `node:http` server (no Express) with `/health/live`, `/health/ready` and
  `/metrics`, bound to 127.0.0.1 by default.

## Consequences

- Fixed windows allow bursts of up to twice the budget across a window boundary. That is acceptable for
  abuse protection; a sliding window can replace the script later without changing callers.
- Integration tests run against Redis database 1, which is flushed per run, so rate-limit counters from
  earlier runs never leak into later ones.
