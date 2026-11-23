# ADR-032: Hash-bound, expiring, single-use approvals

**Status:** Accepted · 2026-11-24

## Context

Module H requires each approval to be tied to a user, organization, repository, review session, commit SHA, exact
operation, exact patch and expiry, and to be invalidated when the reviewed commit changes. Approvals must not be
creatable or widened by untrusted content, and must not be replayable.

## Decision

- **Pure domain library** `@acra/approvals`:
  - `ApprovalOperation` is a closed union with no merge kind; `assertKnownOperation` rejects merge-like names;
  - a state machine (pending → approved → executing → executed | failed; rejected, expired, invalidated);
  - a role policy: OWNER, ADMIN and MEMBER decide; VIEWER and system actors never do.
- **Binding hash:** SHA-256 over canonical JSON of every bound field, including the requester and both
  timestamps. Approval and execution recompute it, so any modification of a stored request voids it.
- **Approval code:** the first 12 hex characters of the binding hash.
  - The CLI without a terminal requires `--approve <code>`.
  - The operator CLI always requires `--code`.
  - A code is only valid for the request that was displayed.
- **Re-verification at execution:** the binding, expiry and current head commit are checked again, as is the patch
  hash recomputed from storage. Hosted execution also checks the original-file and result hashes.
- **Single use:** persistence applies transitions with compare-and-set on the previous status and the binding hash
  (`ApprovalStore.transition`). Execution jobs have one attempt, so a failure needs a new approval.
- **Invalidation:**
  - Reviewing a new head invalidates open requests for older heads.
  - Unapplied fixes for older heads become `SUPERSEDED`.
  - The executor also compares the live MR/PR head.
- **Defence in depth in PostgreSQL:** CHECK constraints for patch binding on fix writes, deciders on decided
  states, maximum TTL and hash formats. There is no `MERGE` value in `approval_operation_kind`.

## Consequences

- Each step needs its own decision: apply, stage, commit, push and open locally; push and open on hosted
  repositories. That is deliberate friction.
- Until Phase 7 adds authentication, server-side decisions are made through the operator CLI with `--user <email>`.
  The operator is trusted, like for `connect-*`. The member must exist with a deciding role, and both identity and
  role are recorded in the audit log.
