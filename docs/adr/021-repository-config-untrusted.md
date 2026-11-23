# ADR-021: `ai-review.yaml` is untrusted and cannot relax policy

**Status:** Accepted · 2026-11-23

## Context

The repository configuration file is committed by whoever can push to the repository, including the author of
the MR/PR being reviewed. Its values will reach AI prompts (Phase 3) and control publishing.

## Decision

- Strict Zod schema (`ReviewConfigSchema`, version 1). Unknown keys are rejected, so typos cannot silently
  disable a setting.
- Values that can reach prompts are **enums, booleans or numbers**: framework, language, categories, severity,
  confidence and limits. No free text. Exclusion globs are length- and count-limited, and are only used for path
  matching.
- `review.approval.*` accepts only `required`, and `merge` accepts only `disabled`. The section exists to make
  the policy visible, not to configure it.
- Parsing limits: 64 KiB maximum size, at most 50 YAML aliases (billion-laughs protection), duplicate keys
  rejected. Errors report key paths and rules, never values.
- The CLI reads the file through the path-safe provider. The server will read it at the reviewed commit SHA
  (Phase 4).

## Consequences

Repository owners can narrow reviews (exclude paths, disable providers or categories, raise thresholds) but
cannot widen privileges. Custom rules, which are free text, will need a separate injection-resistant design
in Phase 3.
