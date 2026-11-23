# ADR-018: Database-enforced append-only audit log

**Status:** Accepted · 2026-11-23

## Decision

`audit_logs` rejects `UPDATE`, `DELETE` and `TRUNCATE` through triggers that raise `insufficient_privilege`
(see migration `init_tenancy_foundation`). It has no `updated_at` and no soft delete. Retention or archiving,
if required, will be done by a separate privileged maintenance role (Phase 8).

## Consequences

Application bugs or a compromised application code path cannot rewrite audit history. This is covered by
an integration test.
