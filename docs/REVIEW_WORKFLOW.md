# Review Workflow

> Status: **not implemented** — design outline. Implementation and full specification in Phase 3.

## Pipeline (LangGraph `StateGraph`, ADR-004)

```text
RECEIVE_REQUEST → IDENTIFY_REPOSITORY → FETCH_COMMIT_AND_DIFF → BUILD_REPOSITORY_CONTEXT
→ ANALYZE_CHANGED_FILES → RUN_STATIC_ANALYSIS → PARALLEL_AI_REVIEW (Claude ‖ GPT)
→ AGGREGATE_FINDINGS → VALIDATE_FINDINGS → DEDUPLICATE_FINDINGS → MAP_FINDINGS_TO_DIFF
→ PUBLISH_VALIDATED_COMMENTS → SAVE_REVIEW_HISTORY → WAIT_FOR_NEW_COMMIT_OR_APPROVAL
```

## Invariants (binding for the implementation)

- Both models review a byte-identical, versioned context snapshot (`baseSha`, `headSha`, `contextHash`).
- Each model execution is recorded with provider, model, tokens, cost, latency and status; timeouts and retries per provider.
- Partial failure keeps successful findings (`PARTIAL` session).
- Deterministic validation decides publication; model agreement is a signal only.
- Unmappable findings go to the summary; no invented inline positions.
- Idempotency keys for webhook deliveries and every job; a new head SHA supersedes the running session.

To be documented in Phase 3: state schema, node contracts, validation rules, fingerprint algorithm, confidence model, prompt structure and egress payload.

## Building blocks already implemented (Phase 2)

- `FETCH_COMMIT_AND_DIFF` (local): `LocalGitProvider.getChangeSet(scope)` with all five scopes.
- `BUILD_REPOSITORY_CONTEXT`: `buildReviewContext` in `@acra/repository-context`. Includes exclusions, budgets,
  surrounding-line snippets, omission reasons and the deterministic `contextHash` that will key the
  byte-identical snapshot both models receive.
- Preview of this input: `ai-review changes --format json`.
