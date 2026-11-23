# Review Workflow

> Status: **implemented for local reviews (Phase 3)**. Server-side triggering (webhooks → worker), publishing
> and database persistence follow in Phases 4–5 and reuse this pipeline unchanged.
> Code: `libs/agent-core` (orchestration), `libs/review-engine` (rules), `libs/ai-providers/*` (adapters).

## 1. Pipeline

```text
RECEIVE_REQUEST / IDENTIFY_REPOSITORY / FETCH_COMMIT_AND_DIFF / BUILD_REPOSITORY_CONTEXT   (caller: CLI now, worker in Phase 4)
        │   ReviewContext (contextHash)
        ▼
  ┌───────────────────────────── LangGraph StateGraph (agent-core/review-graph.ts) ─────────────────────────────┐
  │ prepare ──► redact secrets ─► RUN_STATIC_ANALYSIS ─► build ONE prompt (promptHash)                          │
  │    │ Send fan-out (one branch per configured reviewer, same prompt object)                                  │
  │    ├──► ai_review(claude) ─┐   each: own timeout, own error capture, Zod re-validation of output            │
  │    └──► ai_review(gpt)    ─┤                                                                                │
  │                            ▼                                                                                │
  │ aggregate ─► validate ─► deduplicate ─► finalize (thresholds, lifecycle reconcile, MAP_TO_DIFF, report)     │
  └─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
        │   ReviewReport
        ▼
SAVE_REVIEW_HISTORY (CLI: .git/ai-review/; worker: PostgreSQL, Phase 4) · PUBLISH (Phases 4–5)
```

Every node is timed (`report.trace`). Every model call becomes a `ModelExecution` with provider, requested
model, **serving model** (differs when a fallback ran), status, error kind, tokens, cost and latency.

## 2. Same input for every model

1. `buildReviewContext` (Phase 2) produces a deterministic `ReviewContext` with `contextHash`.
2. `redactContext` replaces credentials with `[REDACTED:<kind>]` in every diff line and snippet.
3. `buildReviewPrompt` renders the redacted context once (`promptHash` = SHA-256 of system + user).
4. Each `ai_review` branch receives that one prompt object (LangGraph `Send` branches receive only their payload,
   so the prompt travels inside it). Tests assert equal `promptHash` across providers.

### Prompt structure

- **System:** the task, rules (data-not-instructions, changed code only, no style or speculation, verbatim
  evidence, new-file line numbers, calibrated confidence), the allowed categories, the minimum severity and the
  severity definitions. It adds the **Angular (v22) guidance** when `project.framework: angular` or the code
  imports `@angular/`. The guidance covers inject() contexts, signals/computed/effect, RxJS cleanup, zoneless
  change detection, `@for` track, `@defer`, lazy routes, typed forms, sanitizer bypasses, NgRx, Apollo/GraphQL
  caching, strict TypeScript and testing.
- **User:** the scope description, then the repository content inside `<<<UNTRUSTED_<nonce>` …
  `UNTRUSTED_<nonce>>>`. The nonce is derived from the content itself, so content cannot pre-compute it, and any
  occurrence is stripped. Diff lines are `+ <new line> | code`, `- <old line> | code`, `  <new line> | code`,
  followed by numbered `CONTEXT` blocks.

## 3. Providers

|                   | Claude (`ai-providers-claude`)                                                                          | GPT (`ai-providers-openai`)                             |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| API               | Messages (beta endpoint for fallbacks), streaming + `finalMessage()`                                    | Responses API                                           |
| Model             | `claude-opus-5-5` (default, `ANTHROPIC_REVIEW_MODEL`)                                                   | **required** `OPENAI_REVIEW_MODEL` (no guessed default) |
| Structured output | `output_config.format` json_schema                                                                      | `text.format` json_schema, `strict: true`               |
| Reasoning         | adaptive thinking (always on), `effort` default `high`                                                  | optional `reasoning.effort`                             |
| Refusals          | `fallbacks: "default"` (server-side, routed by refusal category); whole-chain refusal → `refusal` error | refusal part / `content_filter` → `refusal` error       |
| Truncation        | `stop_reason: max_tokens` → `truncated`                                                                 | `status: incomplete` → `truncated`                      |
| Privacy           | —                                                                                                       | `store: false`                                          |
| Caching           | system prompt `cache_control: ephemeral`                                                                | automatic                                               |
| Cost              | list-price table (served model)                                                                         | only if `OPENAI_PRICE_*` configured, else `null`        |
| Retries / timeout | SDK retries ×2 (429/5xx/connection); 10 min request timeout; graph-level `AI_REVIEW_TIMEOUT_MS`         | same                                                    |

A third, optional **local** adapter (`ai-providers-ollama`, ADR-026) uses Ollama `/api/chat` with the same schema as
`format` and `temperature: 0`. It is selected with `--provider ollama|all`, and loopback means no consent is needed.

All adapters share **one JSON schema** (`ModelReviewOutputSchema`). Every object is strict and every property required
(nullable when optional). Unsupported keywords are stripped. Constraints are enforced locally after parsing.

## 4. Deterministic post-processing (Module E)

**Aggregate:** schema-invalid output fails that execution (its findings are discarded entirely). Then:

- at most 100 findings per model;
- text clipped and confidence clamped to 0–1;
- paths normalised; traversal paths are rejected (`invalid_path`);
- line ranges are ordered.

**Validate** (rules in order):

| #   | Rule                                                                             | Outcome                           |
| --- | -------------------------------------------------------------------------------- | --------------------------------- |
| 1   | File is in the reviewed (included) set                                           | else reject `unknown_file`        |
| 2   | Category enabled in `ai-review.yaml`                                             | else reject `category_disabled`   |
| 3   | Line range exists in the reviewed file version                                   | else reject `invalid_line`        |
| 4   | Touches a changed line, or lies within the surrounding code the models saw       | else reject `unrelated_to_change` |
| 5   | Evidence present                                                                 | else reject `no_evidence`         |
| 6   | Style/preference wording in maintainability/architecture/testing                 | reject `style_only`               |
| 7   | Hedged wording + evidence not found verbatim                                     | reject `speculative`              |
| –   | Evidence not found verbatim (otherwise valid)                                    | confidence −0.25                  |
| –   | Hedged wording alone                                                             | confidence −0.10                  |
| 8   | Suggestion that restates the evidence                                            | suggestion dropped                |
| 9   | Every referenced line is a commentable diff line (added/context on the new side) | `inline`, otherwise `summary`     |

Findings without a mappable line are **never** given an invented position. They go to the summary.

**Deduplicate:**

- `fingerprint = sha256(filePath, category, normalised evidence)` with no line numbers, so it is stable across commits.
- Candidates cluster on the same fingerprint, or on the same file with lines within ±3 and the same category or
  a similar title (Jaccard ≥ 0.5).
- The primary finding is the highest confidence, then the highest severity.
- **Agreement between Claude and GPT adds only +0.05** (capped at 0.99). It is a signal, not proof, and never
  bypasses validation.
- Severity disagreement is recorded (`severityAssessments`).

**Finalize:**

- User decisions win: dismissed / false-positive fingerprints are filtered.
- Then `minimumSeverity` and `minimumConfidence` from `ai-review.yaml` are applied.
- Survivors become `ReviewFinding`s with status `validated` (or keep `published`, plus their id and createdAt, if seen before).

**Report status:** `completed` (every run provider succeeded), `partial` (at least one succeeded and at least one
failed), `failed` (none succeeded; static findings are still reported).

## 5. Static analysis (no AI)

Runs on **added lines only**, without executing repository code. Repository linters and tests run only in the
Phase 6 sandbox.

| Check                                                                                                                                               | Severity | Category        |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------- |
| Hard-coded secrets (AWS, GitHub, GitLab, Anthropic, OpenAI, Slack, Google, Stripe live keys, private keys, JWTs, URL credentials, `password = "…"`) | critical | security        |
| `eval` / `new Function`                                                                                                                             | high     | security        |
| Angular `DomSanitizer.bypassSecurityTrust*`                                                                                                         | high     | security        |
| Shell command built with template interpolation                                                                                                     | high     | security        |
| SQL built with template interpolation                                                                                                               | high     | security        |
| TLS verification disabled                                                                                                                           | high     | security        |
| React `dangerouslySetInnerHTML`                                                                                                                     | medium   | security        |
| `@ts-ignore`                                                                                                                                        | low      | maintainability |

Evidence for static findings is redacted.

## 6. Finding lifecycle (Module F)

Transitions (`FINDING_TRANSITIONS`):

```text
new        → validated | dismissed | false_positive
validated  → published | resolved | dismissed | false_positive
published  → resolved | dismissed | false_positive
resolved   → validated   (reappears)
dismissed, false_positive: terminal (user decisions are never overridden by automation)
```

`reconcileFindings(prior, currentFingerprints, reviewedFiles)`:

- keeps ids for findings seen again;
- suppresses user-dismissed ones;
- marks prior open findings **resolved** only if their file was part of the new review. Absence from a
  narrower scope proves nothing.

Locally, `ai-review dismiss <id> [--false-positive]` records the decision. In Phase 4 the same logic runs
against PostgreSQL and MR/PR comment state.

## 7. What leaves the machine

Only when the user consents (ADR-023), and only:

- diff hunks of included files;
- the bounded surrounding lines;
- file paths and statuses;
- the names and reasons of omitted files;
- the review instructions.

Secrets are redacted first. These never leave the machine:

- excluded or binary files, and files over the size limits;
- `.env` files (the CLI never loads a repository `.env`);
- credentials;
- the local review history.

LangSmith tracing is force-disabled unless `ACRA_ALLOW_LANGSMITH_TRACING=true`.
