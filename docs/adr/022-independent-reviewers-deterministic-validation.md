# ADR-022: Independent AI reviewers, deterministic validation

**Status:** Accepted · 2026-11-23

## Context

The brief requires Claude and GPT to review the same input independently, and forbids publishing a finding just
because a model produced it, or because two models agree.

## Decision

- One prompt (one `promptHash`) is built from the redacted context and sent to every reviewer in parallel
  (LangGraph `Send` fan-out). Reviewers never see each other's output.
- All model output is re-validated with Zod. A schema-invalid response fails that execution as a whole.
- Publication is decided by **deterministic rules**: file and line existence, relation to the change, verbatim
  evidence, speculation and style filters, then thresholds. See REVIEW_WORKFLOW.md §4.
- Agreement between models adds a fixed, small bonus (+0.05, capped at 0.99). Disagreement on severity is
  recorded, not hidden.
- One provider failing (error, refusal, timeout, invalid output) never discards the other's findings. The
  report status says `partial`.

## Consequences

Precision is favoured over recall. Some true issues with poor evidence are filtered and are visible in the report
(`rejected`, `filtered`). Thresholds come from `ai-review.yaml`.
