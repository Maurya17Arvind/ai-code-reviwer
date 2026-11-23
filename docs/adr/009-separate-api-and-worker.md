# ADR-009: Separate API and worker processes

**Status:** Accepted · 2026-11-23

## Decision

`apps/api` (HTTP) and `apps/worker` (NestJS application context, no HTTP listener) are separate deployables
that share libraries. The API only enqueues work. The worker only processes it.

## Consequences

Webhook latency is isolated from review latency, the two scale independently, and failures are contained.
Readiness of the worker will be exposed in Phase 8 (queue heartbeat or a minimal health endpoint).
