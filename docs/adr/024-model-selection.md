# ADR-024: Model selection and provider defaults

**Status:** Accepted · 2026-11-23

## Decision

- **Claude:** `claude-opus-5-5` by default (`ANTHROPIC_REVIEW_MODEL`) at `effort: high`
  (`ANTHROPIC_REVIEW_EFFORT`). Opus 5.5's own default is `medium`; reviews are intelligence-sensitive.
  Adaptive thinking is always on for this model and the `thinking` parameter is omitted. Output is streamed
  (`max_tokens` 32k) to avoid HTTP timeouts.
- **Refusal fallback:** `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`, enabled by default
  (`ANTHROPIC_REFUSAL_FALLBACK=false` disables it). A security reviewer legitimately discusses vulnerabilities,
  which can trigger safety classifiers. The fallback re-runs the request on Anthropic's recommended model for
  that refusal category instead of losing the review. The report records `servedByModel`.
- **GPT:** **no default model.** The installed OpenAI SDK lists many model families whose intended use I could
  not verify. Guessing would be worse than requiring `OPENAI_REVIEW_MODEL`. Without it, GPT is skipped and the
  report says so.
- **Cost:** Claude costs use the documented list prices (cached 2026-10-06), at the serving model's price.
  GPT cost is reported only when `OPENAI_PRICE_*` is configured, otherwise `null`. Estimates are not invoices.

## Consequences

Changing models is configuration only. The pricing table must be updated when Anthropic prices change.
