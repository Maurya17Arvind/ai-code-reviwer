# ADR-010: Tenant isolation in the data layer

**Status:** Accepted for schema; enforcement lands with the first tenant-scoped repository · 2026-11-23

## Decision

- Every tenant-owned table carries a non-null `organization_id` foreign key, indexed as the leading column.
- Data access goes through repository classes whose methods require a `TenantContext`
  (`organizationId` plus the acting user). Services never receive a raw Prisma client.
- PostgreSQL Row-Level Security is evaluated in Phase 8 as defence in depth.

## Consequences

Phase 1 tables follow the convention. The repository and `TenantContext` layer is introduced with the
first feature that reads tenant data, so it is designed against real use cases.
