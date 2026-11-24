import { approvalCode } from '@acra/approvals';
import { loadEnv } from '@acra/configuration';
import { ApprovalStore, ConnectionStore, createPrismaClient, type PrismaClient, ReviewStore } from '@acra/database';
import { createRedisConnectionOptions, enqueueApprovalExecution, QueueName } from '@acra/queue';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod';
import { addMember, type ApprovalAdminDeps, decideApproval, listApprovals, requestApproval } from './approvals-admin';

const HEAD = '3'.repeat(40);
const PATCH = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

describe('approval administration (PostgreSQL + Redis)', () => {
  let prisma: PrismaClient;
  let queue: Queue;
  let deps: ApprovalAdminDeps;
  let slug: string;
  let organizationId: string;
  let repositoryId: string;
  let sessionId: string;
  let fixId: string;

  beforeAll(async () => {
    const env = loadEnv(z.object({ DATABASE_URL: z.string(), REDIS_URL: z.string() }), process.env);
    prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL, poolMax: 2 });
    queue = new Queue(QueueName.Approvals, { connection: createRedisConnectionOptions(env.REDIS_URL, 'producer') });
    deps = {
      approvals: new ApprovalStore(prisma),
      reviews: new ReviewStore(prisma),
      connections: new ConnectionStore(prisma),
      enqueue: (job) => enqueueApprovalExecution(queue, job),
    };

    // Seed what a reviewed GitLab MR with one fix proposal looks like.
    slug = `adm-${randomUUID().slice(0, 8)}`;
    const org = await deps.connections.ensureOrganization(slug, 'Admin Org');
    organizationId = org.organizationId;
    const connection = await prisma.providerConnection.create({
      data: {
        id: randomUUID(),
        organizationId,
        provider: 'GITLAB',
        name: 'x',
        baseUrl: 'https://gitlab.example',
        encryptedToken: { v: 1 },
        tokenKeyId: 'k',
      },
    });
    repositoryId = (
      await deps.connections.upsertRepository(org, {
        connectionId: connection.id,
        provider: 'GITLAB',
        externalId: '42',
        fullName: 'acme/shop',
        defaultBranch: 'main',
        webUrl: 'https://gitlab.example/acme/shop',
      })
    ).id;
    sessionId = (
      await prisma.reviewSession.create({
        data: {
          organizationId,
          repositoryId,
          requestId: 5,
          headSha: HEAD,
          status: 'COMPLETED',
          idempotencyKey: `t:${randomUUID()}`,
        },
      })
    ).id;
    const finding = await prisma.reviewFinding.create({
      data: {
        id: randomUUID(),
        organizationId,
        repositoryId,
        requestId: 5,
        fingerprint: 'fp1',
        lastSessionId: sessionId,
        filePath: 'src/a.ts',
        severity: 'high',
        category: 'bug',
        title: 'Bug',
        description: 'd',
        evidence: 'e',
        confidence: 0.9,
        sources: ['claude'],
        placement: 'inline',
        status: 'PUBLISHED',
        firstSeenSha: HEAD,
        lastSeenSha: HEAD,
      },
    });
    fixId = randomUUID();
    await deps.approvals.saveProposedFix(org, {
      id: fixId,
      repositoryId,
      reviewSessionId: sessionId,
      findingId: finding.id,
      requestId: 5,
      fingerprint: 'fp1',
      filePath: 'src/a.ts',
      baseSha: HEAD,
      targetBranch: 'feature',
      explanation: 'x',
      changes: [],
      patch: PATCH,
      patchSha256: hash(PATCH),
      originalSha256: hash('a\n'),
      resultSha256: hash('b\n'),
      additions: 1,
      deletions: 1,
      provider: 'claude',
      model: 'm',
      costUsd: 0.01,
      branch: `ai-review/fix-${fixId.replace(/-/g, '').slice(0, 12)}`,
    });
    await addMember(deps, { organization: { slug }, email: 'Owner@Example.com', displayName: 'Owner', role: 'OWNER' });
    await addMember(deps, {
      organization: { slug },
      email: 'viewer@example.com',
      displayName: 'Viewer',
      role: 'VIEWER',
    });
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    await prisma?.$disconnect();
  });

  it('only organization members can request; MR/PR creation needs a pushed fix first', async () => {
    await expect(
      requestApproval(deps, { organization: { slug }, fixId, step: 'push', requestedBy: 'stranger@example.com' }),
    ).rejects.toThrow(/not a member/);
    await expect(
      requestApproval(deps, { organization: { slug: 'nope' }, fixId, step: 'push', requestedBy: 'owner@example.com' }),
    ).rejects.toThrow(/not found/);
    await expect(
      requestApproval(deps, { organization: { slug }, fixId, step: 'open', requestedBy: 'owner@example.com' }),
    ).rejects.toThrow(/Push the fix/);
  });

  it('creates a bound pending request, refuses VIEWER approval, approves once and queues execution', async () => {
    const { request, description } = await requestApproval(deps, {
      organization: { slug },
      fixId,
      step: 'push',
      requestedBy: 'owner@example.com',
    });
    expect(request).toMatchObject({ status: 'pending', headSha: HEAD, patchSha256: hash(PATCH) });
    expect(request.operation).toMatchObject({
      kind: 'commit_and_push_fix',
      message: expect.stringMatching(/^fix: Bug/),
    });
    expect(description.join(' ')).toMatch(/one remote write; no force/);
    expect(approvalCode(request)).toHaveLength(12);

    await expect(
      decideApproval(deps, {
        organization: { slug },
        approvalId: request.id,
        decidedBy: 'viewer@example.com',
        decision: 'approve',
      }),
    ).rejects.toThrow(/VIEWER/);
    const approved = await decideApproval(deps, {
      organization: { slug },
      approvalId: request.id,
      decidedBy: 'owner@example.com',
      decision: 'approve',
    });
    expect(approved).toMatchObject({ request: { status: 'approved' }, jobId: `approval_${request.id}` });
    expect((await queue.getJob(`approval_${request.id}`))?.data).toEqual({ organizationId, approvalId: request.id });
    await expect(
      decideApproval(deps, {
        organization: { slug },
        approvalId: request.id,
        decidedBy: 'owner@example.com',
        decision: 'approve',
      }),
    ).rejects.toThrow(/approved/);

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row).toMatchObject({ status: 'APPROVED', operationKind: 'COMMIT_AND_PUSH_FIX' });
    const audit = await prisma.auditLog.findMany({
      where: { organizationId, targetId: request.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(['approval.requested', 'approval.approved']);
    expect(audit.every((a) => a.actorType === 'USER' && a.actorUserId)).toBe(true);
  });

  it('rejects requests, and refuses approval once a newer commit was reviewed', async () => {
    const first = await requestApproval(deps, {
      organization: { slug },
      fixId,
      step: 'push',
      requestedBy: 'owner@example.com',
    });
    const rejected = await decideApproval(deps, {
      organization: { slug },
      approvalId: first.request.id,
      decidedBy: 'owner@example.com',
      decision: 'reject',
      reason: 'not now',
    });
    expect(rejected.request).toMatchObject({ status: 'rejected', reason: 'not now' });
    expect(rejected.jobId).toBeUndefined();

    const second = await requestApproval(deps, {
      organization: { slug },
      fixId,
      step: 'push',
      requestedBy: 'owner@example.com',
    });
    await prisma.reviewSession.create({
      data: {
        organizationId,
        repositoryId,
        requestId: 5,
        headSha: '4'.repeat(40),
        status: 'COMPLETED',
        idempotencyKey: `t:${randomUUID()}`,
      },
    });
    await expect(
      decideApproval(deps, {
        organization: { slug },
        approvalId: second.request.id,
        decidedBy: 'owner@example.com',
        decision: 'approve',
      }),
    ).rejects.toThrow(/reviewed commit changed/);
    await expect(
      requestApproval(deps, { organization: { slug }, fixId, step: 'push', requestedBy: 'owner@example.com' }),
    ).rejects.toThrow(/newer commit/);
    expect((await listApprovals(deps, { organization: { slug }, all: true })).length).toBe(3);
  });

  it('enforces approval invariants in the database as well', async () => {
    await expect(
      prisma.approvalRequest.updateMany({ where: { organizationId, status: 'PENDING' }, data: { status: 'APPROVED' } }),
    ).rejects.toThrow(/approval_requests_decision_chk/);
  });
});
