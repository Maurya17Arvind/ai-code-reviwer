import { type AuthStore } from '@acra/database';
import { type MailQueueProducer, type SendMailJob } from '@acra/queue';
import { HttpException, NotFoundException } from '@nestjs/common';
import { ApiConfigSchema } from '../api-config';
import { RateLimiter } from '../common/rate-limit/rate-limiter';
import { AuthService, RESET_PER_ADDRESS, RESET_PER_IP } from './auth.service';

const KNOWN = { id: '0193a0d2-6b1e-7c3a-9f00-123456789abc', email: 'ana@example.com', displayName: 'Ana' };

function setup(mailEnabled = true) {
  const config = ApiConfigSchema.parse({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379/0',
    API_CORS_ORIGINS: 'http://localhost:4300',
    MAIL_ENABLED: mailEnabled ? 'true' : 'false',
  });
  const audits: Array<{ action: string; userId: string | null; actor?: string; metadata?: unknown }> = [];
  const store = {
    findUserByEmail: vi.fn(async (email: string) => (email === KNOWN.email ? { ...KNOWN, passwordHash: 'x' } : null)),
    audit: vi.fn(async (entry: (typeof audits)[number]) => {
      audits.push(entry);
    }),
  };
  const jobs: SendMailJob[] = [];
  const mail = {
    enqueue: vi.fn(async (job: SendMailJob) => {
      jobs.push(job);
      return { jobId: `mail_${job.correlationId}` };
    }),
  };
  const service = new AuthService(
    store as unknown as AuthStore,
    config,
    new RateLimiter(null),
    mail as unknown as MailQueueProducer,
  );
  return { service, store, jobs, audits };
}

const info = (ip = '203.0.113.7') => ({ ipAddress: ip, userAgent: null, requestId: 'req-1' });

describe('AuthService.requestPasswordReset', () => {
  it('enqueues ids only for a known address (normalised) and audits the platform as actor', async () => {
    const { service, jobs, audits } = setup();
    await service.requestPasswordReset('  Ana@Example.COM ', info());
    expect(jobs).toEqual([
      { purpose: 'password_reset', userId: KNOWN.id, correlationId: expect.any(String), requestId: 'req-1' },
    ]);
    expect(audits).toEqual([
      expect.objectContaining({ action: 'auth.password_reset_requested', userId: KNOWN.id, actor: 'system' }),
    ]);
  });

  it('resolves identically for an unknown address and sends nothing', async () => {
    const { service, jobs, audits } = setup();
    await expect(service.requestPasswordReset('nobody@example.com', info())).resolves.toBeUndefined();
    expect(jobs).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('silently drops requests over the per-address budget (no 429 that would single out an account)', async () => {
    const { service, jobs, audits } = setup();
    for (let i = 0; i < RESET_PER_ADDRESS + 2; i++) {
      await expect(service.requestPasswordReset(KNOWN.email, info(`198.51.100.${i}`))).resolves.toBeUndefined();
    }
    expect(jobs).toHaveLength(RESET_PER_ADDRESS);
    expect(audits.filter((a) => a.action === 'auth.password_reset_throttled')).toHaveLength(2);
  });

  it('refuses a client IP over its budget with 429, for known and unknown addresses alike', async () => {
    const { service } = setup();
    for (let i = 0; i < RESET_PER_IP; i++) await service.requestPasswordReset(`user${i}@example.com`, info());
    const error = await service.requestPasswordReset('another@example.com', info()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
  });

  it('is not offered when mail is disabled', async () => {
    const { service, store } = setup(false);
    expect(service.mailEnabled).toBe(false);
    await expect(service.requestPasswordReset(KNOWN.email, info())).rejects.toBeInstanceOf(NotFoundException);
    expect(store.findUserByEmail).not.toHaveBeenCalled();
  });
});
