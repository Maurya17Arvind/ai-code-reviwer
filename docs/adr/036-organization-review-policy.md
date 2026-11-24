# ADR-036: Organization review policy that can only tighten repository configuration

**Status:** Accepted · 2026-11-24

## Context

The dashboard needs "AI provider settings" and "review configuration". Review behaviour is already configured per
repository in `ai-review.yaml`, which is untrusted input (ADR-021). AI API keys live only in the worker's environment,
and the API never sees them. Organization admins still need central control, for example to disable a paid provider,
pause reviews or raise thresholds, without editing every repository and without being able to weaken safety rules.

## Decision

- **New table** `organization_settings`, one row per organization:
  - switches: reviews enabled; allow Claude, OpenAI and Ollama; allow automatic fix proposals;
  - floors: minimum severity and minimum confidence, which are optional and protected by CHECK constraints.
- **Combination rule** (`applyOrganizationPolicy` in `@acra/configuration`):
  - booleans are combined with **AND** and thresholds with **max()**;
  - the policy can never enable what the repository disabled, and the repository can never enable what the policy
    disabled;
  - approval rules are untouched: every write still needs a human approval, and merging stays disabled.
- **Enforcement in the worker.** The worker applies the policy right after reading `ai-review.yaml`, for each review.
  A paused organization records the review as `SKIPPED` with the reason "reviews are paused by the organization
  policy".
- **Provider status in the dashboard.** API keys are not reported. The dashboard shows what was observed in
  `model_executions`: the last run, the last error kind (for example `quota_exceeded`) and 30-day counts.
- Only ADMIN and OWNER may change the policy. Every change is audited with its full new value.

## Consequences

- The policy works the same for GitLab and GitHub without touching repositories.
- Key presence is not shown. A provider that was never used appears as "not used yet", which is honest without
  passing secrets or worker environment details to the API.
- Per-repository overrides from the dashboard are not offered. `ai-review.yaml` remains the per-repository source.
