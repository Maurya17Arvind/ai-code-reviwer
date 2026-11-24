import { type AiProviderName, type AiReviewer, type AiReviewResult, type ReviewPrompt } from '@acra/ai-providers-core';
import { type ReviewerFactory } from '@acra/ai-providers-factory';
import { loadEnv } from '@acra/configuration';
import { ConnectionStore, createPrismaClient, type PrismaClient } from '@acra/database';
import { connectionSecretContext } from '@acra/git-providers-gitlab';
import { createRedisConnectionOptions, QueueName, ReviewQueueProducer, reviewJobId } from '@acra/queue';
import { encryptSecret, parseMasterKey } from '@acra/security';
import { FakeGitLab } from '@acra/testing';
import { type INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue, QueueEvents } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { REVIEWER_FACTORY, WorkerConfigSchema } from '../worker-config';
import { WorkerModule } from '../worker.module';
import { MergeRequestReviewService, PermanentReviewError } from './merge-request-review.service';

const sha = (c: string) => c.repeat(40);
const BASE = sha('a');
const BUGGY = sha('b');
const FIXED = sha('c');

const BUGGY_FILE =
  'export function total(items: Item[]) {\n  let sum = 0;\n  for (let i = 0; i <= items.length; i++) sum += items[i].price;\n  return sum;\n}\n';
const BUGGY_DIFF =
  '@@ -1,3 +1,5 @@\n export function total(items: Item[]) {\n-  return 0;\n+  let sum = 0;\n+  for (let i = 0; i <= items.length; i++) sum += items[i].price;\n+  return sum;\n }\n';
const FIXED_FILE =
  'export function total(items: Item[]) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n';
const FIXED_DIFF =
  '@@ -1,3 +1,3 @@\n export function total(items: Item[]) {\n-  return 0;\n+  return items.reduce((sum, item) => sum + item.price, 0);\n }\n';

const offByOne = {
  filePath: 'src/cart.ts',
  lineStart: 3,
  lineEnd: 3,
  severity: 'high',
  category: 'bug',
  title: 'Off-by-one reads past the end of items',
  description: 'The loop condition uses <= so items[items.length] is undefined and .price throws.',
  evidence: 'for (let i = 0; i <= items.length; i++) sum += items[i].price;',
  suggestion: 'Use i < items.length.',
  confidence: 0.92,
};

/** Fake AI: reports the off-by-one only when the buggy loop is in the prompt. */
class FakeReviewer implements AiReviewer {
  static calls = 0;
  readonly model = 'fake-model';
  constructor(readonly provider: AiProviderName) {}
  async review(prompt: ReviewPrompt): Promise<AiReviewResult> {
    FakeReviewer.calls++;
    const buggy = prompt.user.includes('i <= items.length');
    return {
      provider: this.provider,
      model: this.model,
      servedByModel: this.model,
      output: { findings: buggy ? [offByOne] : [], summary: buggy ? 'One bug.' : 'Looks good.' },
      usage: { inputTokens: 500, outputTokens: 50 },
      costUsd: 0.001,
      latencyMs: 5,
    };
  }
}
let lastRequestedProviders: string[] = [];
const fakeFactory: ReviewerFactory = (_env, providers) => ({
  reviewers: [...(lastRequestedProviders = [...providers])]
    .filter((p) => p !== 'ollama')
    .map((p) => new FakeReviewer(p)),
  skipped: [],
  destinations: [],
});

describe('GitLab merge request review (worker + PostgreSQL + Redis + fake GitLab)', () => {
  let gitlab: FakeGitLab;
  let app: INestApplicationContext;
  let service: MergeRequestReviewService;
  let prisma: PrismaClient;
  let organizationId: string;
  let repositoryId: string;

  const job = (headSha: string, requestId = 5) => ({
    organizationId,
    repositoryId,
    provider: 'gitlab' as const,
    requestId,
    headSha,
    deliveryId: randomUUID(),
    trigger: 'webhook' as const,
  });

  beforeAll(async () => {
    gitlab = await new FakeGitLab().start();
    const config = loadEnv(WorkerConfigSchema, {
      ...process.env,
      GITLAB_ALLOWED_HOSTS: '127.0.0.1',
      GITLAB_ALLOW_PRIVATE_NETWORK: 'true',
    });
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.forRoot(config)] })
      .overrideProvider(REVIEWER_FACTORY)
      .useValue(fakeFactory)
      .compile();
    app = await moduleRef.init();
    service = app.get(MergeRequestReviewService);
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL, poolMax: 2 });

    // Seed: organization, encrypted GitLab connection, repository (as the admin command does).
    const connections = app.get(ConnectionStore);
    const tenant = await connections.ensureOrganization(`it-${randomUUID().slice(0, 8)}`, 'Integration Org');
    organizationId = tenant.organizationId;
    const connectionId = await connections.connectionIdFor(tenant, 'GITLAB', 'fake');
    const master = parseMasterKey(config.CREDENTIALS_MASTER_KEY);
    await connections.saveConnection(tenant, {
      id: connectionId,
      provider: 'GITLAB',
      name: 'fake',
      baseUrl: gitlab.baseUrl,
      encryptedToken: encryptSecret(gitlab.state.token, master, connectionSecretContext(connectionId)),
      tokenKeyId: master.id,
    });
    repositoryId = (
      await connections.upsertRepository(tenant, {
        connectionId,
        provider: 'GITLAB',
        externalId: String(gitlab.state.projectId),
        fullName: gitlab.state.pathWithNamespace,
        defaultBranch: 'main',
        webUrl: 'https://gitlab.example/acme/shop',
      })
    ).id;

    gitlab.addMergeRequest({
      iid: 5,
      title: 'Cart totals',
      diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: BUGGY },
      diffs: [{ old_path: 'src/cart.ts', new_path: 'src/cart.ts', diff: BUGGY_DIFF }],
    });
    gitlab.setFile(BUGGY, 'src/cart.ts', BUGGY_FILE);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
    await gitlab?.stop();
  });

  it('reviews the MR, posts an inline comment on the right line plus one summary, and persists everything', async () => {
    const outcome = await service.run(job(BUGGY));
    expect(outcome).toMatchObject({ status: 'completed', findings: 1, inlineComments: 1 });

    const notes = gitlab.botNotes(5);
    const inline = notes.find((n) => n.position);
    expect(inline?.position).toMatchObject({ new_path: 'src/cart.ts', new_line: 3, head_sha: BUGGY, base_sha: BASE });
    expect(inline?.body).toContain('Off\\-by\\-one');
    expect(inline?.body).toMatch(/<!-- acra:finding fp=[0-9a-f]+ -->/);
    const summaries = notes.filter((n) => n.body.includes('<!-- acra:summary'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.body).toContain(`<!-- acra:summary sha=${BUGGY} -->`);

    const session = await prisma.reviewSession.findFirstOrThrow({ where: { repositoryId, headSha: BUGGY } });
    expect(session).toMatchObject({ status: 'COMPLETED', requestId: 5, baseSha: BASE });
    expect(await prisma.modelExecution.count({ where: { reviewSessionId: session.id } })).toBe(2);
    const findings = await prisma.reviewFinding.findMany({ where: { repositoryId, requestId: 5 } });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      status: 'PUBLISHED',
      lineNumber: 3,
      firstSeenSha: BUGGY,
      sources: ['claude', 'gpt'],
    });
    expect(await prisma.reviewComment.count({ where: { reviewSessionId: session.id } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { organizationId, action: 'review.published' } })).toBe(1);
  });

  it('is idempotent: the same job again does nothing', async () => {
    const before = gitlab.botNotes(5).length;
    const calls = FakeReviewer.calls;
    expect(await service.run(job(BUGGY))).toMatchObject({ status: 'duplicate' });
    expect(gitlab.botNotes(5)).toHaveLength(before);
    expect(FakeReviewer.calls).toBe(calls);
  });

  it('skips stale jobs for commits that are no longer the MR head', async () => {
    const outcome = await service.run(job(sha('d')));
    expect(outcome).toMatchObject({ status: 'superseded' });
    expect(await prisma.reviewSession.findFirst({ where: { repositoryId, headSha: sha('d') } })).toMatchObject({
      status: 'SUPERSEDED',
    });
  });

  it('re-reviews a new commit: resolves the fixed finding, posts a new summary, never duplicates', async () => {
    const summaryBefore = gitlab.botNotes(5).find((n) => n.body.includes('<!-- acra:summary'));
    const mr = gitlab.state.mergeRequests.get(5);
    if (!mr) throw new Error('missing MR');
    mr.diff_refs = { base_sha: BASE, start_sha: BASE, head_sha: FIXED };
    mr.diffs = [{ old_path: 'src/cart.ts', new_path: 'src/cart.ts', diff: FIXED_DIFF }];
    gitlab.setFile(FIXED, 'src/cart.ts', FIXED_FILE);

    const outcome = await service.run(job(FIXED));
    expect(outcome).toMatchObject({ status: 'completed', findings: 0, inlineComments: 0 });

    const notes = gitlab.botNotes(5);
    expect(notes.filter((n) => n.position)).toHaveLength(1);
    expect(notes.find((n) => n.position)?.resolved).toBe(true);
    // One summary per reviewed commit: the first one is kept as history, the new commit gets its own.
    const summaries = notes.filter((n) => n.body.includes('<!-- acra:summary'));
    expect(summaries).toHaveLength(2);
    expect(summaries.some((s) => s.id === summaryBefore?.id)).toBe(true);
    const latest = summaries.find((s) => s.body.includes(`<!-- acra:summary sha=${FIXED} -->`));
    expect(latest?.body).toContain('1 previously reported finding(s) are resolved');

    // Retrying the same commit updates that commit's summary instead of adding a third one.
    await prisma.reviewSession.updateMany({ where: { repositoryId, headSha: FIXED }, data: { status: 'FAILED' } });
    await service.run(job(FIXED));
    expect(gitlab.botNotes(5).filter((n) => n.body.includes('<!-- acra:summary'))).toHaveLength(2);

    const finding = await prisma.reviewFinding.findFirstOrThrow({ where: { repositoryId, requestId: 5 } });
    expect(finding.status).toBe('RESOLVED');
  });

  it('honours review.enabled: false and fails permanently on an invalid ai-review.yaml', async () => {
    const disabledHead = sha('e');
    gitlab.addMergeRequest({
      iid: 6,
      diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: disabledHead },
      diffs: [{ old_path: 'a.ts', new_path: 'a.ts', diff: BUGGY_DIFF }],
    });
    gitlab.setFile(disabledHead, 'ai-review.yaml', 'version: 1\nreview:\n  enabled: false\n');
    expect(await service.run(job(disabledHead, 6))).toMatchObject({
      status: 'skipped',
      reason: 'review.enabled is false',
    });

    const invalidHead = sha('f');
    gitlab.addMergeRequest({
      iid: 7,
      diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: invalidHead },
      diffs: [{ old_path: 'a.ts', new_path: 'a.ts', diff: BUGGY_DIFF }],
    });
    gitlab.setFile(invalidHead, 'ai-review.yaml', 'version: 1\nreview:\n  approval:\n    merge: enabled\n');
    await expect(service.run(job(invalidHead, 7))).rejects.toBeInstanceOf(PermanentReviewError);
    expect(await prisma.reviewSession.findFirst({ where: { repositoryId, headSha: invalidHead } })).toMatchObject({
      status: 'FAILED',
      errorCode: 'config_invalid',
    });
  });

  it('applies the organization policy: paused reviews are skipped, disallowed providers never run', async () => {
    const pausedHead = sha('7');
    gitlab.addMergeRequest({
      iid: 9,
      diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: pausedHead },
      diffs: [{ old_path: 'src/cart.ts', new_path: 'src/cart.ts', diff: BUGGY_DIFF }],
    });
    gitlab.setFile(pausedHead, 'src/cart.ts', BUGGY_FILE);
    await prisma.organizationSettings.create({ data: { organizationId, reviewsEnabled: false } });
    try {
      expect(await service.run(job(pausedHead, 9))).toMatchObject({
        status: 'skipped',
        reason: 'reviews are paused by the organization policy',
      });

      await prisma.organizationSettings.update({
        where: { organizationId },
        data: { reviewsEnabled: true, allowOpenai: false },
      });
      const nextHead = sha('8');
      gitlab.addMergeRequest({
        iid: 10,
        diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: nextHead },
        diffs: [{ old_path: 'src/cart.ts', new_path: 'src/cart.ts', diff: BUGGY_DIFF }],
      });
      gitlab.setFile(nextHead, 'src/cart.ts', BUGGY_FILE);
      expect(await service.run(job(nextHead, 10))).toMatchObject({ status: 'completed' });
      expect(lastRequestedProviders).not.toContain('gpt');
      expect(lastRequestedProviders).toContain('claude');
    } finally {
      await prisma.organizationSettings.delete({ where: { organizationId } });
    }
  });

  it('rejects jobs whose organization does not own the repository (tenant isolation)', async () => {
    await expect(service.run({ ...job(BUGGY), organizationId: randomUUID() })).rejects.toThrow(/Repository not found/);
  });

  it('processes a job enqueued through BullMQ end to end', async () => {
    const head = sha('9');
    gitlab.addMergeRequest({
      iid: 8,
      diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: head },
      diffs: [{ old_path: 'src/cart.ts', new_path: 'src/cart.ts', diff: BUGGY_DIFF }],
    });
    gitlab.setFile(head, 'src/cart.ts', BUGGY_FILE);

    const connection = createRedisConnectionOptions(process.env['REDIS_URL'] as string, 'worker');
    const events = new QueueEvents(QueueName.Reviews, { connection });
    const queue = new Queue(QueueName.Reviews, { connection });
    try {
      await events.waitUntilReady();
      const { jobId } = await app.get(ReviewQueueProducer).enqueueMergeRequestReview(job(head, 8));
      expect(jobId).toBe(reviewJobId({ provider: 'gitlab', repositoryId, requestId: 8, headSha: head }));
      const result = (await (await queue.getJob(jobId))?.waitUntilFinished(events, 30_000)) as { status: string };
      expect(result.status).toBe('completed');
      expect(gitlab.botNotes(8).some((n) => n.position)).toBe(true);
    } finally {
      await events.close();
      await queue.close();
    }
  });
});
