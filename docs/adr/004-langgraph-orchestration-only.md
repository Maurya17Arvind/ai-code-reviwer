# ADR-004: LangGraph for orchestration, vendor SDKs behind a port

**Status:** Accepted (implemented in Phase 3, `libs/agent-core`) · 2026-11-23

## Context

The review pipeline needs explicit state, branching, parallel fan-out (Claude ‖ GPT) and resumability.
Provider calls need native structured-output features, precise token/cost accounting and easy mocking.

## Decision

- Use **LangGraph JS (1.7.x) `StateGraph`** only for pipeline orchestration in `libs/agent-core`.
- Call Anthropic and OpenAI through their **official SDKs**, wrapped by an `AiReviewer` port in
  `libs/ai-providers/core`, with adapters in `ai-providers/claude` and `ai-providers/openai`.
  LangChain chat-model wrappers are not used.
- All model output is validated with Zod before it enters the domain.

## Consequences

The review engine depends only on the port, and tests use fakes. Provider-specific features remain accessible.
