import { AiEnvSchema, loadEnv } from '@acra/configuration';
import { createReviewers } from './reviewers';

describe('createReviewers (real factory, no network)', () => {
  const originalKey = process.env['ANTHROPIC_API_KEY'];
  beforeAll(() => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-not-a-real-key';
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = originalKey;
  });

  it('builds Claude with defaults and skips GPT when no model is configured', () => {
    const setup = createReviewers(loadEnv(AiEnvSchema, {}), new Set(['claude', 'gpt']));
    expect(setup.reviewers.map((r) => [r.provider, r.model])).toEqual([['claude', 'claude-opus-5-5']]);
    expect(setup.skipped).toEqual([
      expect.objectContaining({ provider: 'gpt', reason: 'OPENAI_REVIEW_MODEL is not set' }),
    ]);
    expect(setup.destinations).toEqual([
      { provider: 'claude', model: 'claude-opus-5-5', host: 'api.anthropic.com', local: false },
    ]);
  });

  it('shows custom endpoints in the consent destinations', () => {
    const env = loadEnv(AiEnvSchema, {
      OPENAI_REVIEW_MODEL: 'gpt-review-model',
      OPENAI_BASE_URL: 'https://proxy.internal.example/v1',
      OPENAI_API_KEY: 'unused',
    });
    const original = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-test-not-a-real-key';
    try {
      const setup = createReviewers(env, new Set(['gpt']));
      expect(setup.destinations).toEqual([
        { provider: 'gpt', model: 'gpt-review-model', host: 'proxy.internal.example', local: false },
      ]);
    } finally {
      if (original === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = original;
    }
  });
});

describe('Ollama wiring', () => {
  it('builds the local reviewer only when a model is configured, marking it as on-machine', async () => {
    const { isLoopbackHost } = await import('./reviewers');
    const skipped = createReviewers(loadEnv(AiEnvSchema, {}), new Set(['ollama']));
    expect(skipped.reviewers).toHaveLength(0);
    expect(skipped.skipped[0]).toMatchObject({ provider: 'ollama', reason: 'OLLAMA_REVIEW_MODEL is not set' });

    const setup = createReviewers(
      loadEnv(AiEnvSchema, { OLLAMA_REVIEW_MODEL: 'qwen2.5-coder:3b' }),
      new Set(['ollama']),
    );
    expect(setup.reviewers.map((r) => [r.provider, r.model])).toEqual([['ollama', 'qwen2.5-coder:3b']]);
    expect(setup.destinations).toEqual([
      { provider: 'ollama', model: 'qwen2.5-coder:3b', host: '127.0.0.1:11434', local: true },
    ]);

    const remote = createReviewers(
      loadEnv(AiEnvSchema, {
        OLLAMA_REVIEW_MODEL: 'qwen2.5-coder:3b',
        OLLAMA_BASE_URL: 'http://gpu-box.internal:11434',
      }),
      new Set(['ollama']),
    );
    expect(remote.destinations[0]?.local).toBe(false);

    expect(['localhost:11434', '127.0.0.1', '127.1.2.3:80', '[::1]:11434'].every(isLoopbackHost)).toBe(true);
    expect(['api.openai.com', '10.0.0.5:11434', 'localhost.evil.com', '127.0.0.1.nip.io'].some(isLoopbackHost)).toBe(
      false,
    );
  });
});
