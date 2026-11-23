import {
  AiProviderError,
  type AiReviewer,
  type AiReviewResult,
  CLAUDE_PRICES,
  estimateCostUsd,
  modelReviewOutputJsonSchema,
  type ReviewPrompt,
  type TokenUsage,
} from '@acra/ai-providers-core';
import Anthropic from '@anthropic-ai/sdk';

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeReviewerOptions {
  /** Default `claude-opus-5-5`. */
  readonly model?: string;
  /** Thinking depth / token spend. Default `high` (Opus 5.5's own default is `medium`). */
  readonly effort?: ClaudeEffort;
  /** Per-request timeout in ms. Default 10 minutes (high-effort reviews of large diffs can take minutes). */
  readonly timeoutMs?: number;
  /** Output budget including adaptive thinking. Default 32 000 (streamed, so no HTTP timeout risk). */
  readonly maxTokens?: number;
  /** SDK retries for 408/409/429/5xx and connection errors. Default 2. */
  readonly maxRetries?: number;
  /** Server-side refusal fallback (`fallbacks: "default"`). Default true. */
  readonly refusalFallback?: boolean;
  /** Injected client (tests). Defaults to `new Anthropic()`, which reads ANTHROPIC_API_KEY or an `ant auth` profile. */
  readonly client?: Anthropic;
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Claude adapter for the AiReviewer port.
 *
 * - Structured output: `output_config.format` with the shared JSON schema (constrained decoding);
 *   the engine still re-validates the result with Zod.
 * - Thinking: Claude Opus 5.5 always uses adaptive thinking; depth is controlled with `effort`.
 * - Refusals: opts into server-side fallbacks so a classifier decline (e.g. code that discusses
 *   vulnerabilities) is re-run on Anthropic's recommended fallback model instead of failing;
 *   `servedByModel` records which model answered. A refusal of the whole chain is reported as such.
 * - The stable system prompt is cached (`cache_control`) to reduce cost on repeated reviews.
 */
export class ClaudeReviewer implements AiReviewer {
  readonly provider = 'claude' as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: ClaudeEffort;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly refusalFallback: boolean;

  constructor(options: ClaudeReviewerOptions = {}) {
    this.model = options.model ?? 'claude-opus-5-5';
    this.effort = options.effort ?? 'high';
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.maxTokens = options.maxTokens ?? 32_000;
    this.refusalFallback = options.refusalFallback ?? true;
    this.client = options.client ?? new Anthropic({ maxRetries: options.maxRetries ?? 2 });
  }

  async review(prompt: ReviewPrompt, signal: AbortSignal): Promise<AiReviewResult> {
    const startedAt = performance.now();
    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          ...(this.refusalFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
          output_config: {
            effort: this.effort,
            format: { type: 'json_schema', schema: modelReviewOutputJsonSchema() },
          },
          system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: prompt.user }],
        },
        { signal, timeout: this.timeoutMs },
      );
      message = await stream.finalMessage();
    } catch (error) {
      throw toProviderError(error, signal);
    }

    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category ?? 'unspecified';
      throw new AiProviderError('claude', 'refusal', `Claude declined the review (category: ${category})`);
    }
    if (message.stop_reason === 'max_tokens') {
      throw new AiProviderError('claude', 'truncated', `Output exceeded max_tokens (${this.maxTokens})`);
    }

    const text = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new AiProviderError('claude', 'invalid_output', 'Claude returned output that is not valid JSON');
    }

    const usage: TokenUsage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      ...(message.usage.cache_read_input_tokens ? { cacheReadInputTokens: message.usage.cache_read_input_tokens } : {}),
      ...(message.usage.cache_creation_input_tokens
        ? { cacheCreationInputTokens: message.usage.cache_creation_input_tokens }
        : {}),
    };
    const servedByModel = message.model;

    return {
      provider: 'claude',
      model: this.model,
      servedByModel,
      output,
      usage,
      // Estimated at the serving model's list price (a fallback turn may span two models).
      costUsd: estimateCostUsd(usage, CLAUDE_PRICES[servedByModel] ?? CLAUDE_PRICES[this.model]),
      latencyMs: Math.round(performance.now() - startedAt),
      ...(message.id ? { requestId: message.id } : {}),
    };
  }
}

function toProviderError(error: unknown, signal: AbortSignal): AiProviderError {
  if (error instanceof AiProviderError) return error;
  if (error instanceof Anthropic.APIUserAbortError || signal.aborted) {
    const timedOut = signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';
    return new AiProviderError(
      'claude',
      timedOut ? 'timeout' : 'aborted',
      timedOut ? 'Review timed out' : 'Review aborted',
    );
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiProviderError('claude', 'timeout', 'Request to Claude timed out', true);
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AiProviderError('claude', 'authentication', 'Claude rejected the credentials (check ANTHROPIC_API_KEY)');
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AiProviderError('claude', 'rate_limited', 'Claude rate limit reached', true);
  }
  // Exhausted credit arrives as a 400 invalid_request_error; the message is the only discriminator.
  if (error instanceof Anthropic.BadRequestError && /credit balance is too low/i.test(error.message)) {
    return new AiProviderError('claude', 'quota_exceeded', 'Anthropic account has no credit left (Plans & Billing)');
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new AiProviderError('claude', 'bad_request', `Claude rejected the request: ${firstLine(error.message)}`);
  }
  if (error instanceof Anthropic.InternalServerError || error instanceof Anthropic.APIConnectionError) {
    return new AiProviderError('claude', 'unavailable', 'Claude is temporarily unavailable', true);
  }
  if (error instanceof Anthropic.APIError) {
    return new AiProviderError('claude', 'unknown', `Claude API error ${String(error.status)}`);
  }
  return new AiProviderError('claude', 'unknown', error instanceof Error ? firstLine(error.message) : 'Unknown error');
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, 300);
}
