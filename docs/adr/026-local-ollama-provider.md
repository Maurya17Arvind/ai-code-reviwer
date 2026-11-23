# ADR-026: Local Ollama provider

**Status:** Accepted · 2026-11-23 · Extends the fixed "Claude + GPT" provider decision (requested by the product owner)

## Context

Both cloud accounts had no credit, which blocked end-to-end testing. The brief also asks for a private local
execution mode for sensitive repositories. Ollama runs open models on the developer's machine at no cost, and
no code leaves it.

## Decision

- Add **`ai-providers-ollama`**, a third `AiReviewer` adapter (`provider: 'ollama'`). It uses Ollama's native
  `/api/chat` with `format` set to the shared JSON schema, `temperature: 0`, and `stream: false`. There is no new
  dependency (it uses `fetch`).
- Claude and GPT remain the primary reviewers. `--provider both` (the default) is unchanged. Ollama runs only
  with `--provider ollama` or `--provider all` **and** `OLLAMA_REVIEW_MODEL` set. `review.providers.ollama` in
  `ai-review.yaml` can forbid it (default: allowed).
- **Consent:** when every destination is a loopback host (`localhost`, `127.0.0.0/8`, `::1`), no consent prompt is
  shown ("Nothing leaves this machine"). A non-loopback `OLLAMA_BASE_URL` is treated like any remote provider.
- **Context safety:** Ollama silently truncates prompts longer than `num_ctx`. A prompt that fills the window is
  rejected as `truncated` rather than reviewing a cut-off diff (`OLLAMA_NUM_CTX`, default 16 384).
- Cost is reported as `0`.

## Consequences

- **Measured on this machine:** Ollama 0.40.16, `qwen2.5-coder:3b`, CPU only. The GeForce GT 710 is too old for
  GPU acceleration. A one-file review took about 3.3 minutes. The model found the real off-by-one bug but
  mislabeled it (category and function name) with high confidence.
- Local small models are fine for exercising the pipeline and for private-mode screening. They are not a
  substitute for Claude or GPT review quality, so findings should be read with that in mind.
- Models are stored on D: (`OLLAMA_MODELS=D:\ollama\models`) because C: is nearly full.
