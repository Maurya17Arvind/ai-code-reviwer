import { loadEnv } from '@acra/configuration';
import { ApiErrorSchema } from '@acra/shared-contracts';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '@acra/database';
import { ApiConfigSchema } from './api-config';
import { hashPassword } from './auth/password';
import { AppModule } from './app.module';
import { APP_OPTIONS, configureApp } from './configure-app';

const METRICS_TOKEN = 'metrics-token-for-tests-0123456789';

/** Rate limits are stored in Redis and therefore shared by every API instance. */
describe('Rate limiting (integration: Redis)', () => {
  const apps: INestApplication[] = [];
  const urls: string[] = [];

  beforeAll(async () => {
    const config = loadEnv(ApiConfigSchema, {
      ...process.env,
      API_CORS_ORIGINS: 'http://localhost:4300',
      TRUST_PROXY_HOPS: '1',
      RATE_LIMIT_ANONYMOUS_PER_MINUTE: '10',
      RATE_LIMIT_WEBHOOK_PER_MINUTE: '10',
      METRICS_TOKEN: METRICS_TOKEN,
    });
    // Two API instances against the same Redis.
    for (let i = 0; i < 2; i++) {
      const app = await NestFactory.create(AppModule.forRoot(config), APP_OPTIONS);
      configureApp(app, config);
      await app.listen(0, '127.0.0.1');
      apps.push(app);
      urls.push((await app.getUrl()).replace('[::1]', '127.0.0.1'));
    }
  });

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  // Unique, valid documentation-range addresses (RFC 5737) per test, sent through the trusted proxy header.
  const clientIp = () => `198.51.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;

  it('limits anonymous clients across instances and answers 429 with Retry-After', async () => {
    const ip = clientIp();
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 12; i++) {
      last = await fetch(`${urls[i % 2]}/api/v1/auth/session`, { headers: { 'X-Forwarded-For': ip } });
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect(Number(last?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(last?.headers.get('ratelimit-limit')).toBe('10');
    expect(ApiErrorSchema.parse(await last?.json()).message).toMatch(/Too many requests/);

    // Another client is unaffected.
    const other = await fetch(`${urls[0]}/api/v1/auth/session`, { headers: { 'X-Forwarded-For': clientIp() } });
    expect(other.status).toBe(401);
  });

  it('does not let failed attempts from one IP lock the real user out (no account-wide lock)', async () => {
    const email = `victim-${randomUUID().slice(0, 8)}@example.com`;
    const password = 'victim correct passphrase';
    const prisma = createPrismaClient({ databaseUrl: process.env['DATABASE_URL'] as string, poolMax: 1 });
    try {
      const user = await prisma.user.create({
        data: { email, displayName: 'Victim', passwordHash: await hashPassword(password) },
      });
      const attackerIp = clientIp();
      const login = (ip: string, pw: string) =>
        fetch(`${urls[0]}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Forwarded-For': ip },
          body: JSON.stringify({ email, password: pw }),
        });
      for (let i = 0; i < 5; i++) expect((await login(attackerIp, 'wrong guess!!')).status).toBe(401);
      expect((await login(attackerIp, 'wrong guess!!')).status).toBe(429);
      // The victim, from their own address, still signs in with the right password.
      expect((await login(clientIp(), password)).status).toBe(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).lockedUntil).toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });

  it('never limits health probes', async () => {
    const ip = clientIp();
    for (let i = 0; i < 15; i++) {
      const response = await fetch(`${urls[0]}/api/health/live`, { headers: { 'X-Forwarded-For': ip } });
      expect(response.status).toBe(200);
    }
  });

  it('exposes Prometheus metrics only with the token, labelled by route template', async () => {
    expect((await fetch(`${urls[0]}/api/metrics`)).status).toBe(401);
    expect(
      (await fetch(`${urls[0]}/api/metrics`, { headers: { Authorization: 'Bearer wrong-token-0123456789xx' } })).status,
    ).toBe(401);
    const orgId = randomUUID();
    await fetch(`${urls[0]}/api/v1/organizations/${orgId}/findings`, { headers: { 'X-Forwarded-For': clientIp() } });
    const response = await fetch(`${urls[0]}/api/metrics`, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const text = await response.text();
    expect(text).toContain(
      'acra_http_requests_total{method="GET",route="/api/v1/organizations/:orgId/findings",status="401"}',
    );
    expect(text).toContain('acra_queue_jobs{queue="reviews",state="waiting"}');
    expect(text).toContain('acra_http_request_duration_seconds_bucket');
    expect(text).not.toContain(orgId);
  });

  it('gives webhooks their own budget', async () => {
    const ip = clientIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const response = await fetch(`${urls[1]}/api/webhooks/gitlab/${randomUUID()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Forwarded-For': ip, 'X-Gitlab-Token': 'x' },
        body: '{}',
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
