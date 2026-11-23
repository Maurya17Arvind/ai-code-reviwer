# ADR-007: PostgreSQL 18.7 rather than 19.0

**Status:** Accepted · 2026-11-23

## Context

PostgreSQL 19.0 is published, but it is a brand-new `.0` major. Prisma 7.10's support for 19 is not established.

## Decision

Use **`postgres:18.7-alpine`** for local development. Revisit in Phase 8 once Prisma lists PostgreSQL 19 support.

## Consequences

None of the features we need (UUIDv7 via Prisma, JSONB, `inet`, triggers) requires 19.
