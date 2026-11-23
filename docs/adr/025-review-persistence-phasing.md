# ADR-025: Review persistence — local store now, database in Phase 4

**Status:** Accepted · 2026-11-23 · Deviation from DATABASE_DESIGN.md (review tables were listed for Phase 3)

## Context

In Phase 3 the only entry point that runs reviews is the local CLI, which by design does not connect to the
server database (`scope:cli` cannot import `@acra/database`). Creating `review_sessions`, `model_executions`,
`review_findings` and related tables now would add unused schema.

## Decision

- The pipeline returns a persistence-agnostic `ReviewReport`, validated by `ReviewReportSchema`.
- The CLI stores reports and user decisions in `<git-dir>/ai-review/`: `reports/*.json` (last 50),
  `latest.json` and `decisions.json`.
- The tables are created in Phase 4, when the worker runs reviews for MRs. They will be modelled on the report
  shape: one session per report, one execution per `executions[]` entry, findings keyed by
  `(repository_id, fingerprint)`.

## Consequences

Local history is per clone and is not shared across machines. That is intended for the private local mode.
