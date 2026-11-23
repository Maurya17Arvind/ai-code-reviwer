import { AiProviderError, type ReviewPrompt } from '@acra/ai-providers-core';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeReviewer } from './claude-reviewer';

const prompt: ReviewPrompt = { system: 'SYSTEM', user: 'USER', promptHash: 'h' };
const output = { findings: [], summary: 'ok' };

type Params = Record<string, unknown>;

/** Minimal fake of `client.beta.messages.stream(...).finalMessage()` — no network. */
function fakeClient(result: Partial<Anthropic.Beta.BetaMessage> | Error) {
  const calls: Array<{ params: Params; options: Params }> = [];
  const client = {
    beta: {
      messages: {
        stream(params: Params, options: Params) {
          calls.push({ params, options });
          return {
            finalMessage: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

function message(overrides: Partial<Anthropic.Beta.BetaMessage> = {}): Partial<Anthropic.Beta.BetaMessage> {
  return {
    id: 'msg_1',
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    stop_details: null,
    content: [
      { type: 'thinking', thinking: '', signature: 's' } as unknown as Anthropic.Beta.BetaContentBlock,
      { type: 'text', text: JSON.stringify(output), citations: null } as Anthropic.Beta.BetaTextBlock,
    ],
    usage: {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_read_input_tokens: 2_000,
      cache_creation_input_tokens: 0,
    } as Anthropic.Beta.BetaUsage,
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

describe('ClaudeReviewer', () => {
  it('sends structured-output, effort, fallback and cached system prompt', async () => {
    const { client, calls } = fakeClient(message());
    const result = await new ClaudeReviewer({ client }).review(prompt, signal());

    const { params, options } = calls[0] ?? { params: {}, options: {} };
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 32_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema' } },
      system: [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'USER' }],
    });
    expect(params).not.toHaveProperty('thinking');
    expect(options).toMatchObject({ timeout: 600_000 });

    expect(result).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-5-5',
      servedByModel: 'claude-opus-5-5',
      output,
    });
    expect(result.usage).toEqual({ inputTokens: 1_000, outputTokens: 500, cacheReadInputTokens: 2_000 });
    expect(result.costUsd).toBeCloseTo(0.004 + 0.01 + 0.0004, 6);
  });

  it('records the serving model when a server-side fallback answered', async () => {
    const { client } = fakeClient(message({ model: 'claude-opus-4-8' }));
    const result = await new ClaudeReviewer({ client }).review(prompt, signal());
    expect(result.servedByModel).toBe('claude-opus-4-8');
  });

  it('can disable the fallback', async () => {
    const { client, calls } = fakeClient(message());
    await new ClaudeReviewer({ client, refusalFallback: false }).review(prompt, signal());
    expect(calls[0]?.params).not.toHaveProperty('fallbacks');
  });

  it.each([
    [{ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } }, 'refusal'],
    [{ stop_reason: 'max_tokens' }, 'truncated'],
    [{ content: [{ type: 'text', text: 'not json', citations: null }] }, 'invalid_output'],
  ] as const)('maps %j to %s', async (overrides, kind) => {
    const { client } = fakeClient(message(overrides as unknown as Partial<Anthropic.Beta.BetaMessage>));
    await expect(new ClaudeReviewer({ client }).review(prompt, signal())).rejects.toMatchObject({ kind });
  });

  it('maps SDK errors to provider-neutral kinds', async () => {
    const headers = new Headers();
    const cases: Array<[Error, string, boolean]> = [
      [new Anthropic.RateLimitError(429, undefined, 'rate limited', headers), 'rate_limited', true],
      [new Anthropic.AuthenticationError(401, undefined, 'bad key', headers), 'authentication', false],
      [new Anthropic.BadRequestError(400, undefined, 'bad', headers), 'bad_request', false],
      [new Anthropic.InternalServerError(500, undefined, 'oops', headers), 'unavailable', true],
    ];
    for (const [error, kind, retryable] of cases) {
      const { client } = fakeClient(error);
      const failure = await new ClaudeReviewer({ client }).review(prompt, signal()).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(AiProviderError);
      expect(failure).toMatchObject({ provider: 'claude', kind, retryable });
    }
  });

  it('recognises exhausted credit', async () => {
    const error = new Anthropic.BadRequestError(
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Your credit balance is too low to access the Anthropic API.',
        },
      },
      'Your credit balance is too low to access the Anthropic API.',
      new Headers(),
    );
    const { client } = fakeClient(error);
    await expect(new ClaudeReviewer({ client }).review(prompt, signal())).rejects.toMatchObject({
      kind: 'quota_exceeded',
      retryable: false,
    });
  });

  it('reports timeouts from the abort signal', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('timed out', 'TimeoutError'));
    const { client } = fakeClient(new Anthropic.APIUserAbortError());
    await expect(new ClaudeReviewer({ client }).review(prompt, controller.signal)).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});
