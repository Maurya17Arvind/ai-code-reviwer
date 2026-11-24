import { AiProviderError, type ReviewPrompt } from '@acra/ai-providers-core';
import { OllamaReviewer } from './ollama-reviewer';

const prompt: ReviewPrompt = { system: 'SYSTEM', user: 'USER', promptHash: 'h' };
const output = { findings: [], summary: 'ok' };

/** Successful responses are an NDJSON stream: content split over chunks, metadata on the done line. */
function ndjson(final: Record<string, unknown>): string {
  const { message, ...meta } = final as { message?: { content?: string } };
  const content = message?.content ?? '';
  const middle = Math.floor(content.length / 2);
  return [
    { message: { role: 'assistant', content: content.slice(0, middle) }, done: false },
    { message: { role: 'assistant', content: content.slice(middle) }, done: false },
    { message: { role: 'assistant', content: '' }, done: true, ...meta },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
}

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const text = status === 200 ? ndjson(body as Record<string, unknown>) : JSON.stringify(body);
    return Promise.resolve(new Response(text, { status, headers: { 'content-type': 'application/x-ndjson' } }));
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
      stream: true,
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

  it('reports an error line in the stream', async () => {
    const impl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'model runner crashed' }), { status: 200 }),
      )) as unknown as typeof fetch;
    await expect(new OllamaReviewer({ model: 'm', fetchImpl: impl }).review(prompt, signal())).rejects.toMatchObject({
      kind: 'unavailable',
      message: expect.stringContaining('model runner crashed'),
    });
  });

  it('reports a slow model as a timeout, not as an unreachable server', async () => {
    const headersTimeout = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
    const impl = (() => Promise.reject(headersTimeout)) as unknown as typeof fetch;
    await expect(new OllamaReviewer({ model: 'm', fetchImpl: impl }).review(prompt, signal())).rejects.toMatchObject({
      kind: 'timeout',
    });
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

describe('OllamaReviewer over node:http (default client)', () => {
  let server: import('node:http').Server;
  let baseUrl: string;
  let mode: 'stream' | 'hang' = 'stream';

  beforeAll(async () => {
    const { createServer } = await import('node:http');
    server = createServer((req, res) => {
      if (mode === 'hang') return; // never sends headers
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const content = JSON.stringify(output);
        res.write(`${JSON.stringify({ message: { content: content.slice(0, 5) }, done: false })}\n`);
        setTimeout(() => {
          res.end(
            `${JSON.stringify({ message: { content: content.slice(5) }, done: false })}\n` +
              `${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', model: 'm', prompt_eval_count: 10, eval_count: 5 })}\n`,
          );
        }, 20);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('node:net').AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reads a streamed answer through the default client', async () => {
    mode = 'stream';
    const result = await new OllamaReviewer({ model: 'm', baseUrl }).review(prompt, signal());
    expect(result).toMatchObject({ output, usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it('still enforces its own time limit when the server never answers', async () => {
    mode = 'hang';
    await expect(
      new OllamaReviewer({ model: 'm', baseUrl, timeoutMs: 200 }).review(prompt, signal()),
    ).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});
