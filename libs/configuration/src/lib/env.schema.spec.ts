import { ApiEnvSchema, WorkerEnvSchema } from './env.schema';
import { ConfigValidationError, loadEnv } from './load-env';

const validApiEnv = {
  DATABASE_URL: 'postgresql://acra_app:pw@127.0.0.1:5432/acra',
  REDIS_URL: 'redis://:pw@127.0.0.1:6379/0',
};

describe('ApiEnvSchema', () => {
  it('applies defaults', () => {
    const env = loadEnv(ApiEnvSchema, validApiEnv);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_HOST: '127.0.0.1',
      API_PORT: 3000,
      API_CORS_ORIGINS: ['http://localhost:4300'],
    });
  });

  it('parses ports and comma-separated CORS origins', () => {
    const env = loadEnv(ApiEnvSchema, {
      ...validApiEnv,
      API_PORT: '8080',
      API_CORS_ORIGINS: 'https://review.example.com, http://localhost:4300',
    });
    expect(env.API_PORT).toBe(8080);
    expect(env.API_CORS_ORIGINS).toEqual(['https://review.example.com', 'http://localhost:4300']);
  });

  it('reports missing required variables by name', () => {
    expect(() => loadEnv(ApiEnvSchema, {})).toThrowError(ConfigValidationError);
    try {
      loadEnv(ApiEnvSchema, {});
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL: is required');
      expect(message).toContain('REDIS_URL: is required');
    }
  });

  it('never includes rejected values in the error message', () => {
    const secret = 'super-secret-password-123';
    let message = '';
    try {
      loadEnv(ApiEnvSchema, {
        DATABASE_URL: `mysql://root:${secret}@db/acra`,
        REDIS_URL: `http://:${secret}@cache`,
        API_PORT: secret,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('REDIS_URL');
    expect(message).toContain('API_PORT');
    expect(message).not.toContain(secret);
  });

  it('rejects non-http CORS origins', () => {
    expect(() => loadEnv(ApiEnvSchema, { ...validApiEnv, API_CORS_ORIGINS: 'javascript:alert(1)' })).toThrowError(
      ConfigValidationError,
    );
  });
});

describe('WorkerEnvSchema', () => {
  it('requires database and redis URLs', () => {
    expect(loadEnv(WorkerEnvSchema, validApiEnv).REDIS_URL).toBe(validApiEnv.REDIS_URL);
    expect(() => loadEnv(WorkerEnvSchema, { DATABASE_URL: validApiEnv.DATABASE_URL })).toThrowError(/REDIS_URL/);
  });
});

describe('AiEnvSchema', () => {
  it('defaults to Claude Opus 5.5 at high effort and leaves the GPT model unset', async () => {
    const { AiEnvSchema } = await import('./ai-env.schema');
    const env = loadEnv(AiEnvSchema, {});
    expect(env).toMatchObject({
      ANTHROPIC_REVIEW_MODEL: 'claude-opus-5-5',
      ANTHROPIC_REVIEW_EFFORT: 'high',
      ANTHROPIC_REFUSAL_FALLBACK: true,
      AI_REVIEW_TIMEOUT_MS: 600_000,
    });
    expect(env.OPENAI_REVIEW_MODEL).toBeUndefined();
  });

  it('rejects malformed model ids and timeouts without echoing them', async () => {
    const { AiEnvSchema } = await import('./ai-env.schema');
    expect(() =>
      loadEnv(AiEnvSchema, { OPENAI_REVIEW_MODEL: 'gpt; rm -rf /', AI_REVIEW_TIMEOUT_MS: '5' }),
    ).toThrowError(/OPENAI_REVIEW_MODEL[\s\S]*AI_REVIEW_TIMEOUT_MS/);
  });
});
