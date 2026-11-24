import {
  AiProviderError,
  type AiReviewer,
  type AiReviewResult,
  modelReviewOutputJsonSchema,
  type ReviewPrompt,
} from '@acra/ai-providers-core';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

export interface OllamaReviewerOptions {
  /** Locally pulled model, e.g. `qwen2.5-coder:3b` (OLLAMA_REVIEW_MODEL). */
  readonly model: string;
  /** Default http://127.0.0.1:11434 (loopback: code never leaves the machine). */
  readonly baseUrl?: string;
  /** Context window requested from Ollama. Default 16 384 tokens. */
  readonly numCtx?: number;
  /** Per-request timeout. Default 15 minutes (CPU inference is slow). */
  readonly timeoutMs?: number;
  /** Injected fetch (tests). Defaults to a node:http client without fetch's 300 s headers timeout. */
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
    this.fetchImpl = options.fetchImpl ?? nodeHttpFetch;
  }

  async review(prompt: ReviewPrompt, signal: AbortSignal): Promise<AiReviewResult> {
    const startedAt = performance.now();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    let body: OllamaChatResponse;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: requestSignal,
        body: JSON.stringify({
          model: this.model,
          // Streamed: on slow (CPU / low-memory) machines a non-streamed answer can take longer than
          // fetch's 300 s headers timeout. Streaming sends data continuously, so only our own
          // timeout (timeoutMs) limits the review.
          stream: true,
          format: prompt.output?.schema ?? modelReviewOutputJsonSchema(),
          options: { temperature: 0, num_ctx: this.numCtx },
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        }),
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as OllamaChatResponse;
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
          `Ollama error ${response.status}: ${(error.error ?? '').slice(0, 200)}`,
        );
      }
      body = await readStream(response);
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      throw this.transportError(error, signal);
    }
    if (body.error) {
      throw new AiProviderError('ollama', 'unavailable', `Ollama error: ${body.error.slice(0, 200)}`);
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

  /** Maps fetch/stream failures: aborts and timeouts are reported as such, not as "unreachable". */
  private transportError(error: unknown, signal: AbortSignal): AiProviderError {
    if (signal.aborted && !(signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError')) {
      return new AiProviderError('ollama', 'aborted', 'Review aborted');
    }
    const name = error instanceof Error ? error.name : '';
    const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
    if (
      signal.aborted ||
      name === 'AbortError' ||
      name === 'TimeoutError' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT'
    ) {
      return new AiProviderError('ollama', 'timeout', `Ollama did not finish within the time limit (${this.baseUrl})`);
    }
    return new AiProviderError(
      'ollama',
      'unavailable',
      `Ollama is not reachable at ${this.baseUrl} (is it running?)`,
      true,
    );
  }
}

/**
 * Reads Ollama's NDJSON chat stream: message chunks are concatenated; the final `done` line carries
 * the model, token counts and done_reason. An `error` line ends the stream with that error.
 */
async function readStream(response: Response): Promise<OllamaChatResponse> {
  if (!response.body) return {};
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let content = '';
  let final: OllamaChatResponse = {};
  const handle = (line: string) => {
    if (!line.trim()) return;
    let chunk: OllamaChatResponse & { done?: boolean };
    try {
      chunk = JSON.parse(line) as OllamaChatResponse & { done?: boolean };
    } catch {
      return; // a malformed line is ignored; the assembled JSON is validated anyway
    }
    if (chunk.error) final = { ...final, error: chunk.error };
    content += chunk.message?.content ?? '';
    if (chunk.done) final = { ...final, ...chunk };
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      handle(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  handle(buffer);
  return { ...final, message: { content } };
}

/**
 * Minimal fetch over node:http(s). Node's global fetch aborts when response headers take longer than
 * 300 s, and Ollama only sends headers after it has evaluated the whole prompt, which can exceed that
 * on CPU-only or memory-constrained machines. With node:http only our own AbortSignal (timeoutMs)
 * limits the request.
 */
export const nodeHttpFetch = ((input: string | URL, init: RequestInit = {}): Promise<Response> =>
  new Promise((resolve, reject) => {
    const url = new URL(String(input));
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(
      url,
      {
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string> | undefined,
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
            status: res.statusCode ?? 502,
            headers: toHeaders(res.headers),
          }),
        );
      },
    );
    request.on('error', reject);
    if (typeof init.body === 'string') request.write(init.body);
    request.end();
  })) as typeof fetch;

function toHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const v of value) result.append(name, v);
    else if (value !== undefined) result.set(name, value);
  }
  return result;
}
