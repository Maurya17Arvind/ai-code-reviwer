import { HeartbeatJobSchema } from './queues';

describe('HeartbeatJobSchema', () => {
  it('accepts a valid payload', () => {
    const payload = {
      correlationId: '0193a0d2-6b1e-7c3a-9f00-123456789abc',
      requestedAt: '2026-11-23T10:00:00.000Z',
      source: 'api',
    };
    expect(HeartbeatJobSchema.parse(payload)).toEqual(payload);
  });

  it('rejects payloads with unexpected sources or malformed ids', () => {
    expect(
      HeartbeatJobSchema.safeParse({ correlationId: 'x', requestedAt: '2026-11-23T10:00:00.000Z', source: 'api' })
        .success,
    ).toBe(false);
    expect(
      HeartbeatJobSchema.safeParse({
        correlationId: '0193a0d2-6b1e-7c3a-9f00-123456789abc',
        requestedAt: '2026-11-23T10:00:00.000Z',
        source: 'webhook',
      }).success,
    ).toBe(false);
  });
});
