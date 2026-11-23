# ADR-013: Structured logging with pino and central redaction

**Status:** Accepted · 2026-11-23

## Decision

- `nestjs-pino` in API and worker. Options come from `createLoggerOptions()` in `@acra/configuration`:
  JSON in production, `pino-pretty` in development, `service` field on every line.
- Redaction paths are maintained centrally in `@acra/security` (`LOG_REDACT_PATHS`): authorization and
  cookie headers, GitLab/GitHub webhook secret headers, and keys such as `password`, `token`, `apiKey`,
  `privateKey`, `databaseUrl` and `redisUrl`.
- Request correlation: a validated inbound `X-Request-Id` (8–64 chars, `[A-Za-z0-9-]`) or a fresh UUID,
  echoed in the response and included in error bodies.
- Health probe requests are excluded from access logs.

## Consequences

Startup configuration errors are written with `console.error` before the logger exists. They contain
variable names only.
