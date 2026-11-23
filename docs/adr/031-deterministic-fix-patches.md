# ADR-031: Models propose line edits; the platform computes the patch

**Status:** Accepted · 2026-11-24

## Context

Module G requires fix proposals that a human approves and that are then applied exactly. A model-written unified
diff is unreliable: hunk headers are often wrong, context drifts, and CRLF or missing final newlines break it. A
model-written diff is also hard to validate. It could touch other files or hide changes in context lines.

## Decision

- The model receives one finding plus one file (a window of ±150 lines for files over 600 lines). It returns
  `{ canFix, explanation, edits: [{ startLine, endLine, replacement }] }` under a strict JSON schema
  (`ModelFixOutputSchema`). AI providers accept the schema per call (`ReviewPrompt.output`).
- Validation is deterministic:
  - edits must be inside the shown window, in range and non-overlapping;
  - size limits apply: at most 10 edits, 80 lines replaced and 120 lines written;
  - no NUL bytes;
  - no redaction markers, and no edits to lines whose secret was redacted;
  - no copied line-number prefixes;
  - the fix must not be a no-op.
- **Protected paths** are refused before any model call (`PROTECTED_PATH_GLOBS`):
  - CI and workflow files, hooks, `.gitattributes` and `.gitmodules`;
  - package manifests and lockfiles, `.npmrc`;
  - Docker, compose and Make files;
  - `.env*`, keys, and `ai-review.yaml`.

  These files execute code or widen trust when they change.

- The platform turns edits into minimal line changes and renders a git-compatible unified diff. It stores the
  `patch_sha256`, and the SHA-256 hashes of the original and resulting file. Right before writing, the result is
  recomputed from the original content and both hashes must match (`applyProposal`).
- Exactly one provider generates a fix, in the order Claude, GPT, Ollama, filtered by configuration. Fix generation
  does not need two independent models: the patch is checked deterministically and approved by a human.

## Consequences

- Fixes are limited to one file and a local region. Larger refactors are out of scope by design.
- The diff writer has a property test: 150 random edit sets, including CRLF files and files without a final
  newline, are applied with `git apply` and must match byte for byte. It found two edge cases during development.
