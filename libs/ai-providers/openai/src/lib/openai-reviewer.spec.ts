import { AiProviderError, type ReviewPrompt } from '@acra/ai-providers-core';
import OpenAI from 'openai';
import { OpenAiReviewer } from './openai-reviewer';

const prompt: ReviewPrompt = { system: 'SYSTEM', user: 'USER', promptHash: 'h' };
const output = { findings: [], summary: 'ok' };
type Params = Record<string, unknown>;

function fakeClient(result: Record<string, unknown> | Error) {
  const calls: Array<{ params: Params; options: Params }> = [];
  const client = {
    responses: {
      create(params: Params, options: Params) {
        calls.push({ params, options });
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp_1',
    model: 'gpt-test-2026',
    status: 'completed',
    incomplete_details: null,
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
    output_text: JSON.stringify(output),
    usage: { input_tokens: 1_000, output_tokens: 200, input_tokens_details: { cached_tokens: 400 } },
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

describe('OpenAiReviewer', () => {
  it('requires an explicit model', () => {
    expect(() => new OpenAiReviewer({ model: '' })).toThrow(AiProviderError);
  });

  it('sends a strict json_schema request without storing data', async () => {
    const { client, calls } = fakeClient(response());
    const result = await new OpenAiReviewer({ model: 'gpt-test', client, reasoningEffort: 'high' }).review(
      prompt,
      signal(),
    );
    expect(calls[0]?.params).toMatchObject({
      model: 'gpt-test',
      instructions: 'SYSTEM',
      input: 'USER',
      store: false,
      reasoning: { effort: 'high' },
      text: { format: { type: 'json_schema', name: 'code_review', strict: true } },
    });
    expect(result).toMatchObject({ provider: 'gpt', servedByModel: 'gpt-test-2026', output, costUsd: null });
    expect(result.usage).toEqual({ inputTokens: 600, outputTokens: 200, cacheReadInputTokens: 400 });
  });

  it('estimates cost only when prices are configured', async () => {
    const { client } = fakeClient(response());
    const result = await new OpenAiReviewer({
      model: 'gpt-test',
      client,
      price: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5 },
    }).review(prompt, signal());
    expect(result.costUsd).toBeCloseTo(600 * 2e-6 + 200 * 8e-6 + 400 * 0.5e-6, 9);
  });

  it.each([
    [{ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }, 'refusal'],
    [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'truncated'],
    [{ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, 'refusal'],
    [{ output_text: '{oops' }, 'invalid_output'],
  ])('maps %j to %s', async (overrides, kind) => {
    const { client } = fakeClient(response(overrides));
    await expect(new OpenAiReviewer({ model: 'gpt-test', client }).review(prompt, signal())).rejects.toMatchObject({
      kind,
    });
  });

  it('maps SDK errors', async () => {
    const headers = new Headers();
    const cases: Array<[Error, string]> = [
      [new OpenAI.RateLimitError(429, undefined, 'slow down', headers), 'rate_limited'],
      [new OpenAI.AuthenticationError(401, undefined, 'bad key', headers), 'authentication'],
      [new OpenAI.NotFoundError(404, undefined, 'no model', headers), 'bad_request'],
      [new OpenAI.InternalServerError(500, undefined, 'oops', headers), 'unavailable'],
    ];
    for (const [error, kind] of cases) {
      const { client } = fakeClient(error);
      await expect(new OpenAiReviewer({ model: 'gpt-test', client }).review(prompt, signal())).rejects.toMatchObject({
        provider: 'gpt',
        kind,
      });
    }
  });
});
