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
    expect(setup.destinations).toEqual([{ provider: 'claude', model: 'claude-opus-5-5', host: 'api.anthropic.com' }]);
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
        { provider: 'gpt', model: 'gpt-review-model', host: 'proxy.internal.example' },
      ]);
    } finally {
      if (original === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = original;
    }
  });
});
