/**
 * Port implemented by every AI provider adapter (Claude, GPT). The review engine depends only
 * on this interface — never on vendor SDKs (ADR-004).
 */

export type AiProviderName = 'claude' | 'gpt';

/** Identical, provider-neutral prompt. Both reviewers in a session receive the same object. */
export interface ReviewPrompt {
  readonly system: string;
  readonly user: string;
  /** SHA-256 of system + user — proves both models received byte-identical input. */
  readonly promptHash: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

export interface AiReviewResult {
  readonly provider: AiProviderName;
  /** Model that was requested. */
  readonly model: string;
  /** Model that actually produced the answer (differs when a server-side fallback ran). */
  readonly servedByModel: string;
  /** Parsed JSON from the model. Untrusted until validated against ModelReviewOutputSchema. */
  readonly output: unknown;
  readonly usage: TokenUsage;
  /** Estimated cost in USD, or null when no price is known for the model. */
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly requestId?: string;
}

export interface AiReviewer {
  readonly provider: AiProviderName;
  readonly model: string;
  review(prompt: ReviewPrompt, signal: AbortSignal): Promise<AiReviewResult>;
}

export type AiProviderErrorKind =
  | 'authentication'
  | 'rate_limited'
  | 'timeout'
  | 'refusal'
  | 'truncated'
  | 'invalid_output'
  | 'bad_request'
  | 'unavailable'
  | 'aborted'
  | 'unknown';

/** Expected provider failure. `message` is safe to log and show (never contains prompts or keys). */
export class AiProviderError extends Error {
  constructor(
    readonly provider: AiProviderName,
    readonly kind: AiProviderErrorKind,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
