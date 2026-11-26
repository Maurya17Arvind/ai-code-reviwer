import { HeartbeatJobSchema, SendMailJobSchema } from './queues';

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

describe('SendMailJobSchema (ADR-040: ids only)', () => {
  const valid = {
    purpose: 'password_reset',
    userId: '0193a0d2-6b1e-7c3a-9f00-123456789abc',
    correlationId: '0193a0d2-6b1e-7c3a-9f00-123456789abd',
    requestId: 'req-1',
  };

  it('accepts ids and a known purpose', () => {
    expect(SendMailJobSchema.parse(valid)).toEqual(valid);
    expect(SendMailJobSchema.parse({ ...valid, requestId: null }).requestId).toBeNull();
  });

  it('rejects any extra field, so tokens, links or addresses cannot reach Redis', () => {
    for (const extra of [{ token: 'abc' }, { link: 'https://x' }, { email: 'a@example.com' }]) {
      expect(SendMailJobSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
  });

  it('rejects unknown purposes and malformed ids', () => {
    expect(SendMailJobSchema.safeParse({ ...valid, purpose: 'newsletter' }).success).toBe(false);
    expect(SendMailJobSchema.safeParse({ ...valid, userId: 'user-1' }).success).toBe(false);
  });
});
