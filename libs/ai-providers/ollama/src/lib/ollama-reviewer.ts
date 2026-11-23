import {
  AiProviderError,
  type AiReviewer,
  type AiReviewResult,
  modelReviewOutputJsonSchema,
  type ReviewPrompt,
} from '@acra/ai-providers-core';

export interface OllamaReviewerOptions {
  /** Locally pulled model, e.g. `qwen2.5-coder:3b` (OLLAMA_REVIEW_MODEL). */
  readonly model: string;
  /** Default http://127.0.0.1:11434 (loopback: code never leaves the machine). */
  readonly baseUrl?: string;
  /** Context window requested from Ollama. Default 16 384 tokens. */
  readonly numCtx?: number;
  /** Per-request timeout. Default 15 minutes (CPU inference is slow). */
  readonly timeoutMs?: number;
  /** Injected fetch (tests). */
  readonly fetchImpl?: typeof fetch;
}

interface OllamaChatResponse {
  readonly model?: string;
  readonly message?: { readonly content?: string };
  readonly done_reason?: string;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
  readonly error?: string;
}

/**
 * Local model adapter (Ollama native /api/chat) for the AiReviewer port.
 *
 * - Structured output: `format` = the shared JSON schema (Ollama constrained decoding); the engine
 *   still re-validates with Zod.
 * - Deterministic: temperature 0.
 * - Context safety: Ollama silently truncates prompts longer than `num_ctx`; when the evaluated prompt
 *   fills the window the result is rejected as `truncated` instead of reviewing a cut-off diff.
 * - Cost is 0 (local compute). No retries: failures are local and immediate.
 */
export class OllamaReviewer implements AiReviewer {
  readonly provider = 'ollama' as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly numCtx: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaReviewerOptions) {
    if (!options.model) throw new AiProviderError('ollama', 'bad_request', 'An Ollama model must be configured');
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.numCtx = options.numCtx ?? 16_384;
    this.timeoutMs = options.timeoutMs ?? 900_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async review(prompt: ReviewPrompt, signal: AbortSignal): Promise<AiReviewResult> {
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: modelReviewOutputJsonSchema(),
          options: { temperature: 0, num_ctx: this.numCtx },
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        }),
      });
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError'))
      ) {
        const timedOut =
          !signal.aborted || (signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError');
        throw new AiProviderError(
          'ollama',
          timedOut ? 'timeout' : 'aborted',
          timedOut ? 'Ollama review timed out' : 'Review aborted',
        );
      }
      throw new AiProviderError(
        'ollama',
        'unavailable',
        `Ollama is not reachable at ${this.baseUrl} (is it running?)`,
        true,
      );
    }

    const body = (await response.json().catch(() => ({}))) as OllamaChatResponse;
    if (!response.ok) {
      if (response.status === 404) {
        throw new AiProviderError(
          'ollama',
          'bad_request',
          `Model "${this.model}" is not available locally (run: ollama pull ${this.model})`,
        );
      }
      throw new AiProviderError(
        'ollama',
        response.status >= 500 ? 'unavailable' : 'bad_request',
        `Ollama error ${response.status}: ${(body.error ?? '').slice(0, 200)}`,
      );
    }

    const promptTokens = body.prompt_eval_count ?? 0;
    if (promptTokens >= this.numCtx - 16) {
      throw new AiProviderError(
        'ollama',
        'truncated',
        `Prompt (${promptTokens} tokens) filled the ${this.numCtx}-token context window; raise OLLAMA_NUM_CTX or narrow the scope`,
      );
    }
    if (body.done_reason === 'length') {
      throw new AiProviderError('ollama', 'truncated', 'Ollama output hit the generation limit');
    }

    let output: unknown;
    try {
      output = JSON.parse(body.message?.content ?? '');
    } catch {
      throw new AiProviderError('ollama', 'invalid_output', 'Ollama returned output that is not valid JSON');
    }

    return {
      provider: 'ollama',
      model: this.model,
      servedByModel: body.model ?? this.model,
      output,
      usage: { inputTokens: promptTokens, outputTokens: body.eval_count ?? 0 },
      costUsd: 0,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}
