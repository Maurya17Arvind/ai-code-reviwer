# ADR-038: PostgreSQL Row-Level Security evaluated, not adopted yet

**Status:** Accepted · 2026-11-24 (revisit before onboarding untrusted tenants at scale)

## Context

ADR-010 enforces tenant isolation in the application: every store method takes a `TenantContext` and
filters by `organization_id`, and the API checks membership for `/organizations/:orgId`. It asked for
PostgreSQL Row-Level Security (RLS) to be evaluated in Phase 8 as defence in depth.

## Evaluation

RLS needs the tenant id in the database session, e.g. `SET LOCAL app.organization_id = …` per transaction,
with policies such as `organization_id = current_setting('app.organization_id')::uuid`.

- With Prisma 7 and the pg adapter, that means wrapping every tenant query in an interactive transaction
  that sets the variable first. That affects every store method, adds a round trip per request, and has
  to stay correct with connection pooling (a forgotten `LOCAL` would leak a tenant id to the next user of
  the connection).
- Cross-tenant code paths exist by design and would need a bypass role: webhook intake resolves a
  repository before the tenant is known, and maintenance spans all tenants.
- The current guarantees are tested: a route-matrix test proves that every organization route answers 404
  to other tenants for every method, and store-level tests cover the scoping.

## Decision

Do not adopt RLS in Phase 8. Keep application-level isolation, guarded by:

1. the store convention (no raw Prisma client in services; every tenant query takes a `TenantContext`);
2. the automated route-matrix test, which covers new routes without extra work;
3. code review of any new store method.

## Consequences

- One missing `organization_id` filter in a new store method would not be caught by the database. The
  route-matrix test catches it only when the route takes `:orgId` from the path.
- Revisit when the platform is offered to mutually untrusted tenants at scale. The recommended approach
  then is RLS policies, a `withTenant()` transaction helper in `@acra/database`, and a separate bypass role
  for webhook intake and maintenance.
