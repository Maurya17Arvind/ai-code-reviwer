import { AiProviderError, type ReviewPrompt } from '@acra/ai-providers-core';
import { OllamaReviewer } from './ollama-reviewer';

const prompt: ReviewPrompt = { system: 'SYSTEM', user: 'USER', promptHash: 'h' };
const output = { findings: [], summary: 'ok' };

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (overrides: Record<string, unknown> = {}) => ({
  model: 'qwen2.5-coder:3b',
  message: { content: JSON.stringify(output) },
  done_reason: 'stop',
  prompt_eval_count: 1_200,
  eval_count: 80,
  ...overrides,
});
const signal = () => new AbortController().signal;

describe('OllamaReviewer', () => {
  it('requires a model', () => {
    expect(() => new OllamaReviewer({ model: '' })).toThrow(AiProviderError);
  });

  it('posts a deterministic, schema-constrained chat request to the loopback server', async () => {
    const { impl, calls } = fakeFetch(200, ok());
    const result = await new OllamaReviewer({ model: 'qwen2.5-coder:3b', fetchImpl: impl }).review(prompt, signal());
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'qwen2.5-coder:3b',
      stream: false,
      options: { temperature: 0, num_ctx: 16_384 },
      messages: [
        { role: 'system', content: 'SYSTEM' },
        { role: 'user', content: 'USER' },
      ],
    });
    expect(body['format']).toMatchObject({ type: 'object' });
    expect(result).toMatchObject({
      provider: 'ollama',
      output,
      costUsd: 0,
      usage: { inputTokens: 1_200, outputTokens: 80 },
    });
  });

  it.each([
    [404, { error: 'model not found' }, 'bad_request', /ollama pull/],
    [500, { error: 'boom' }, 'unavailable', /500/],
    [200, ok({ prompt_eval_count: 16_384 }), 'truncated', /context window/],
    [200, ok({ done_reason: 'length' }), 'truncated', /generation limit/],
    [200, ok({ message: { content: 'not json' } }), 'invalid_output', /not valid JSON/],
  ])('maps HTTP %s / %j to %s', async (status, body, kind, message) => {
    const { impl } = fakeFetch(status, body);
    const failure = await new OllamaReviewer({ model: 'm', fetchImpl: impl })
      .review(prompt, signal())
      .catch((e: unknown) => e);
    expect(failure).toMatchObject({ provider: 'ollama', kind });
    expect((failure as Error).message).toMatch(message);
  });

  it('reports an unreachable server clearly', async () => {
    const impl = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    await expect(
      new OllamaReviewer({ model: 'm', fetchImpl: impl, baseUrl: 'http://127.0.0.1:9' }).review(prompt, signal()),
    ).rejects.toMatchObject({
      kind: 'unavailable',
      message: expect.stringContaining('not reachable at http://127.0.0.1:9'),
    });
  });
});
