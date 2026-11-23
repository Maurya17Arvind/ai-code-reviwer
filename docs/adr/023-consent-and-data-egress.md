# ADR-023: Explicit consent and minimal data egress for AI reviews

**Status:** Accepted · 2026-11-23

## Decision

- **Consent:** `ai-review review` prints the file count, byte size and destinations (provider, model, host
  including custom `*_BASE_URL`). Then:
  - in an interactive terminal it asks before sending;
  - without a terminal it refuses unless `--yes` is given (exit code 2).
- **Redaction:** secrets are replaced before the prompt is built. The secret scanner favours known token formats
  over generic entropy to avoid noise.
- **No repository `.env`:** the CLI never loads a `.env` file from the repository under review. Otherwise an
  untrusted repository could redirect `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` to exfiltrate code.
- **Provider retention:** OpenAI requests use `store: false`.
- **No third-party tracing:** LangSmith/LangChain tracing variables are overridden to `false` unless
  `ACRA_ALLOW_LANGSMITH_TRACING=true`.
- **Local history** is kept in `.git/ai-review/`: never committed, written with owner-only permissions, and
  re-validated on read.

## Consequences

CI usage requires `--yes`, a deliberate opt-in. The server mode (Phase 4) replaces the interactive consent with
organisation and repository settings.
