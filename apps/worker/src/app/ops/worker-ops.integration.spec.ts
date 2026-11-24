import { loadEnv } from '@acra/configuration';
import { createPrismaClient, type PrismaClient } from '@acra/database';
import { type INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { SystemProcessor } from '../system.processor';
import { WorkerConfigSchema } from '../worker-config';
import { WorkerModule } from '../worker.module';
import { WorkerHttpServer } from './worker-http.server';

const METRICS_TOKEN = 'worker-metrics-token-0123456789';
const HOUR = 3_600_000;

describe('Worker operations (integration: PostgreSQL + Redis)', () => {
  let app: INestApplicationContext;
  let prisma: PrismaClient;
  let base: string;

  beforeAll(async () => {
    const config = loadEnv(WorkerConfigSchema, { ...process.env, METRICS_TOKEN, WORKER_HTTP_PORT: '0' });
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.forRoot(config)] }).compile();
    app = await moduleRef.init();
    base = `http://127.0.0.1:${app.get(WorkerHttpServer).port}`;
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL, poolMax: 2 });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  it('serves liveness, readiness (PostgreSQL + Redis) and token-protected metrics', async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: 'ok',
      checks: [
        expect.objectContaining({ name: 'database', status: 'up' }),
        expect.objectContaining({ name: 'redis', status: 'up' }),
      ],
    });
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    const metrics = await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('# TYPE acra_reviews_total counter');
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('recovers reviews stuck after a crash and expires overdue approvals, once', async () => {
    const now = new Date();
    const org = await prisma.organization.create({ data: { slug: `ops-${randomUUID().slice(0, 8)}`, name: 'Ops' } });
    const user = await prisma.user.create({
      data: { email: `ops-${randomUUID().slice(0, 8)}@example.com`, displayName: 'Ops' },
    });
    const repo = await prisma.repository.create({
      data: { organizationId: org.id, provider: 'GITLAB', externalId: randomUUID(), fullName: 'ops/repo' },
    });
    const session = (startedAt: Date) =>
      prisma.reviewSession.create({
        data: {
          organizationId: org.id,
          repositoryId: repo.id,
          requestId: 1,
          headSha: 'a'.repeat(40),
          status: 'RUNNING',
          startedAt,
          idempotencyKey: `ops:${randomUUID()}`,
        },
      });
    const stuck = await session(new Date(now.getTime() - 3 * HOUR));
    const active = await session(new Date(now.getTime() - 60_000));
    const approval = await prisma.approvalRequest.create({
      data: {
        id: randomUUID(),
        organizationId: org.id,
        repositoryId: repo.id,
        reviewSessionId: stuck.id,
        requestId: 1,
        headSha: 'a'.repeat(40),
        operationKind: 'CREATE_MERGE_REQUEST',
        operation: { kind: 'create_merge_request' },
        bindingHash: 'b'.repeat(64),
        requestedById: user.id,
        requestedBy: { kind: 'user', id: user.id, display: user.email },
        createdAt: new Date(now.getTime() - 48 * HOUR),
        expiresAt: new Date(now.getTime() - 24 * HOUR),
      },
    });

    const processor = app.get(SystemProcessor);
    const first = await processor.maintenance(now);
    expect(first.stuckReviewsFailed).toBeGreaterThanOrEqual(1);
    expect(first.approvalsExpired).toBeGreaterThanOrEqual(1);
    expect(await prisma.reviewSession.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({
      status: 'FAILED',
      errorCode: 'worker_interrupted',
    });
    expect((await prisma.reviewSession.findUniqueOrThrow({ where: { id: active.id } })).status).toBe('RUNNING');
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('EXPIRED');

    // Idempotent: nothing left to change for these records.
    await processor.maintenance(now);
    expect((await prisma.reviewSession.findUniqueOrThrow({ where: { id: active.id } })).status).toBe('RUNNING');
  });
});
