# ADR-008: Redis 8 + BullMQ 6

**Status:** Accepted · 2026-11-23

## Context

Reviews, publishing and fix generation are background work that needs retries, idempotency and back-pressure.

## Decision

- **BullMQ 6.7.8** with `@nestjs/bullmq` 12.0.2 and `ioredis` 6.0.0, on **Redis 8.10.3**.
- Redis requires a password, uses `appendonly yes` and `maxmemory-policy noeviction` (BullMQ must never lose jobs).
- Producer connections fail fast (`enableOfflineQueue: false`, `maxRetriesPerRequest: 1`), so API requests
  never hang on a Redis outage. Worker connections use `maxRetriesPerRequest: null` as BullMQ requires.
- BullMQ 6 abstracts the Redis client (`IRedisClient`). The health probe uses `INFO` over the BullMQ
  connection because `PING` is not part of that interface.
- BullMQ 6 also offers a PostgreSQL backend. It is not used; Redis remains the queue store as specified.

## Consequences

Redis 8 is licensed RSALv2/SSPLv1/AGPLv3. If that is unacceptable for a deployment, Valkey is a drop-in
replacement. Decide before production (Phase 8).
