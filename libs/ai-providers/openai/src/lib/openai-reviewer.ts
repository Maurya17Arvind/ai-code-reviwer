import {
  AiProviderError,
  type AiReviewer,
  type AiReviewResult,
  estimateCostUsd,
  type ModelPrice,
  modelReviewOutputJsonSchema,
  type ReviewPrompt,
  type TokenUsage,
} from '@acra/ai-providers-core';
import OpenAI from 'openai';

export type OpenAiReasoningEffort = 'low' | 'medium' | 'high';

export interface OpenAiReviewerOptions {
  /** Required: the GPT model to use (e.g. from OPENAI_REVIEW_MODEL). No default is guessed. */
  readonly model: string;
  /** Reasoning effort for reasoning models. Omitted when unset. */
  readonly reasoningEffort?: OpenAiReasoningEffort;
  /** Per-request timeout in ms. Default 10 minutes. */
  readonly timeoutMs?: number;
  /** Default 32 000. */
  readonly maxOutputTokens?: number;
  /** SDK retries. Default 2. */
  readonly maxRetries?: number;
  /** Optional list prices for cost estimates; without them cost is reported as null. */
  readonly price?: ModelPrice;
  /** Injected client (tests). Defaults to `new OpenAI()`, which reads OPENAI_API_KEY. */
  readonly client?: OpenAI;
}

/**
 * GPT adapter for the AiReviewer port (OpenAI Responses API).
 *
 * - Structured output: `text.format` json_schema with `strict: true` (same shared schema as Claude).
 * - Privacy: `store: false` — responses (and the submitted code) are not retained for later retrieval.
 * - Refusals and incomplete responses are reported explicitly, never parsed as findings.
 */
export class OpenAiReviewer implements AiReviewer {
  readonly provider = 'gpt' as const;
  readonly model: string;
  private readonly client: OpenAI;
  private readonly options: OpenAiReviewerOptions;

  constructor(options: OpenAiReviewerOptions) {
    if (!options.model) throw new AiProviderError('gpt', 'bad_request', 'An OpenAI model must be configured');
    this.model = options.model;
    this.options = options;
    this.client = options.client ?? new OpenAI({ maxRetries: options.maxRetries ?? 2 });
  }

  async review(prompt: ReviewPrompt, signal: AbortSignal): Promise<AiReviewResult> {
    const startedAt = performance.now();
    let response: OpenAI.Responses.Response;
    try {
      response = await this.client.responses.create(
        {
          model: this.model,
          instructions: prompt.system,
          input: prompt.user,
          store: false,
          max_output_tokens: this.options.maxOutputTokens ?? 32_000,
          text: {
            format: { type: 'json_schema', name: 'code_review', schema: modelReviewOutputJsonSchema(), strict: true },
          },
          ...(this.options.reasoningEffort ? { reasoning: { effort: this.options.reasoningEffort } } : {}),
        },
        { signal, timeout: this.options.timeoutMs ?? 600_000 },
      );
    } catch (error) {
      throw toProviderError(error, signal);
    }

    const refusal = response.output
      .flatMap((item) => (item.type === 'message' ? item.content : []))
      .find((part) => part.type === 'refusal');
    if (refusal) throw new AiProviderError('gpt', 'refusal', 'GPT declined the review');

    if (response.status === 'incomplete') {
      const reason = response.incomplete_details?.reason ?? 'unknown';
      throw new AiProviderError(
        'gpt',
        reason === 'content_filter' ? 'refusal' : 'truncated',
        `GPT response incomplete (${reason})`,
      );
    }
    if (response.status === 'failed') {
      throw new AiProviderError('gpt', 'unavailable', 'GPT reported a failed response', true);
    }

    let output: unknown;
    try {
      output = JSON.parse(response.output_text);
    } catch {
      throw new AiProviderError('gpt', 'invalid_output', 'GPT returned output that is not valid JSON');
    }

    const cached = response.usage?.input_tokens_details.cached_tokens ?? 0;
    const usage: TokenUsage = {
      // OpenAI counts cached tokens inside input_tokens; split them out for consistent accounting.
      inputTokens: (response.usage?.input_tokens ?? 0) - cached,
      outputTokens: response.usage?.output_tokens ?? 0,
      ...(cached ? { cacheReadInputTokens: cached } : {}),
    };

    return {
      provider: 'gpt',
      model: this.model,
      servedByModel: response.model,
      output,
      usage,
      costUsd: estimateCostUsd(usage, this.options.price),
      latencyMs: Math.round(performance.now() - startedAt),
      requestId: response.id,
    };
  }
}

function toProviderError(error: unknown, signal: AbortSignal): AiProviderError {
  if (error instanceof AiProviderError) return error;
  if (error instanceof OpenAI.APIUserAbortError || signal.aborted) {
    const timedOut = signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';
    return new AiProviderError(
      'gpt',
      timedOut ? 'timeout' : 'aborted',
      timedOut ? 'Review timed out' : 'Review aborted',
    );
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new AiProviderError('gpt', 'timeout', 'Request to OpenAI timed out', true);
  }
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
    return new AiProviderError('gpt', 'authentication', 'OpenAI rejected the credentials (check OPENAI_API_KEY)');
  }
  // OpenAI uses HTTP 429 for both throttling and exhausted credit; only the error code tells them apart.
  if (error instanceof OpenAI.APIError && isQuotaError(error)) {
    return new AiProviderError('gpt', 'quota_exceeded', 'OpenAI account has no credit left (add credits in Billing)');
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new AiProviderError('gpt', 'rate_limited', 'OpenAI rate limit reached', true);
  }
  if (error instanceof OpenAI.BadRequestError || error instanceof OpenAI.NotFoundError) {
    return new AiProviderError('gpt', 'bad_request', `OpenAI rejected the request: ${firstLine(error.message)}`);
  }
  if (error instanceof OpenAI.InternalServerError || error instanceof OpenAI.APIConnectionError) {
    return new AiProviderError('gpt', 'unavailable', 'OpenAI is temporarily unavailable', true);
  }
  if (error instanceof OpenAI.APIError) {
    return new AiProviderError('gpt', 'unknown', `OpenAI API error ${String(error.status)}`);
  }
  return new AiProviderError('gpt', 'unknown', error instanceof Error ? firstLine(error.message) : 'Unknown error');
}

function isQuotaError(error: InstanceType<typeof OpenAI.APIError>): boolean {
  const values = [error.code, error.type].map((v) => String(v ?? ''));
  return values.some((v) => v === 'insufficient_quota' || v === 'credit_balance_exhausted');
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, 300);
}
