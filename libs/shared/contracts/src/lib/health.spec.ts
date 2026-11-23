import { ReadinessResponseSchema } from './health';

describe('ReadinessResponseSchema', () => {
  it('accepts a degraded readiness payload', () => {
    const payload = {
      status: 'unavailable',
      timestamp: new Date().toISOString(),
      checks: [
        { name: 'database', status: 'up', latencyMs: 3 },
        { name: 'redis', status: 'down', latencyMs: 1000, reason: 'timeout' },
      ],
    };
    expect(ReadinessResponseSchema.parse(payload)).toEqual(payload);
  });

  it('rejects unknown dependency names', () => {
    const result = ReadinessResponseSchema.safeParse({
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: [{ name: 'kafka', status: 'up', latencyMs: 1 }],
    });
    expect(result.success).toBe(false);
  });
});
