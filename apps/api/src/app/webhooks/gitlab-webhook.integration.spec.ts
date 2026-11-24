import { loadEnv } from '@acra/configuration';
import { ConnectionStore, createPrismaClient, type PrismaClient, ReviewStore } from '@acra/database';
import { createRedisConnectionOptions, QueueName, reviewJobId } from '@acra/queue';
import { generateMasterKey, parseMasterKey } from '@acra/security';
import { FakeGitLab } from '@acra/testing';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { connectGitLabProject } from '../../admin/connect-gitlab';
import { AppModule } from '../app.module';
import { APP_OPTIONS, configureApp } from '../configure-app';
import { ApiConfigSchema } from '../api-config';

const HEAD = 'c'.repeat(40);

describe('GitLab webhook intake + connect-gitlab (API + PostgreSQL + Redis + fake GitLab)', () => {
  let gitlab: FakeGitLab;
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaClient;
  let queue: Queue;
  let repositoryId: string;
  let webhookToken: string;
  const masterKey = parseMasterKey(generateMasterKey());

  const connect = (slug: string) =>
    connectGitLabProject(
      {
        connections: new ConnectionStore(prisma),
        reviews: new ReviewStore(prisma),
        masterKey,
        policy: { allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true },
      },
      {
        organizationSlug: slug,
        organizationName: 'Webhook Org',
        connectionName: 'default',
        baseUrl: gitlab.baseUrl,
        project: gitlab.state.pathWithNamespace,
        token: gitlab.state.token,
        webhookBaseUrl: 'https://review.example.com',
        registerWebhook: true,
      },
    );

  const payload = (overrides: Record<string, unknown> = {}, attributes: Record<string, unknown> = {}) => ({
    object_kind: 'merge_request',
    project: { id: gitlab.state.projectId },
    object_attributes: {
      iid: 3,
      action: 'open',
      state: 'opened',
      last_commit: { id: HEAD },
      title: 'Hello',
      ...attributes,
    },
    ...overrides,
  });

  const post = (body: unknown, headers: Record<string, string> = {}, repo = repositoryId) =>
    fetch(`${baseUrl}/api/webhooks/gitlab/${repo}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-event': 'Merge Request Hook',
        'x-gitlab-token': webhookToken,
        'x-gitlab-event-uuid': randomUUID(),
        ...headers,
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    gitlab = await new FakeGitLab().start();
    const config = loadEnv(ApiConfigSchema, { ...process.env, API_CORS_ORIGINS: 'http://localhost:4300' });
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL, poolMax: 2 });
    app = await NestFactory.create(AppModule.forRoot(config), APP_OPTIONS);
    configureApp(app, config);
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    queue = new Queue(QueueName.Reviews, { connection: createRedisConnectionOptions(config.REDIS_URL, 'producer') });

    const result = await connect(`wh-${randomUUID().slice(0, 8)}`);
    repositoryId = result.repositoryId;
    webhookToken = gitlab.state.hooks[0]?.token ?? '';
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    await app?.close();
    await prisma?.$disconnect();
    await gitlab?.stop();
  });

  it('connect-gitlab registers the hook and stores only an encrypted token and a token hash', async () => {
    expect(gitlab.state.hooks).toHaveLength(1);
    expect(gitlab.state.hooks[0]).toMatchObject({
      url: `https://review.example.com/api/webhooks/gitlab/${repositoryId}`,
      merge_requests_events: true,
    });
    const repo = await prisma.repository.findUniqueOrThrow({
      where: { id: repositoryId },
      include: { connection: true },
    });
    expect(repo).toMatchObject({
      provider: 'GITLAB',
      externalId: String(gitlab.state.projectId),
      fullName: 'acme/shop',
    });
    expect(repo.webhookSecretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(repo.connection?.encryptedToken)).not.toContain(gitlab.state.token);
    expect(JSON.stringify(repo)).not.toContain(webhookToken);
  });

  it('queues a review for a new merge request (202) and deduplicates the same delivery', async () => {
    const deliveryId = randomUUID();
    const first = await post(payload(), { 'x-gitlab-event-uuid': deliveryId });
    expect(first.status).toBe(202);
    const body = (await first.json()) as { status: string; jobId: string };
    expect(body.status).toBe('queued');
    expect(body.jobId).toBe(reviewJobId({ provider: 'gitlab', repositoryId, requestId: 3, headSha: HEAD }));
    const job = await queue.getJob(body.jobId);
    expect(job?.data).toMatchObject({ repositoryId, requestId: 3, headSha: HEAD, trigger: 'webhook' });
    expect(JSON.stringify(job?.data)).not.toContain('Hello'); // no payload text is forwarded

    const replay = await post(payload(), { 'x-gitlab-event-uuid': deliveryId });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ status: 'duplicate' });
  });

  it('rejects bad tokens, unknown repositories and project mismatches with the same 401', async () => {
    for (const response of [
      await post(payload(), { 'x-gitlab-token': 'wrong' }),
      await post(payload(), {}, randomUUID()),
      await post(payload(), {}, 'not-a-uuid'),
      await post(payload({ project: { id: 999 } })),
    ]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ statusCode: 401, message: 'Invalid webhook token' });
    }
  });

  it('ignores events that do not change code', async () => {
    const note = await post({ object_kind: 'note' }, { 'x-gitlab-event': 'Note Hook' });
    expect(await note.json()).toEqual({ status: 'ignored', reason: 'unsupported event' });
    const titleEdit = await post(payload({}, { action: 'update' }));
    expect(((await titleEdit.json()) as { status: string }).status).toBe('ignored');
    const closed = await post(payload({}, { action: 'close', state: 'closed' }));
    expect(((await closed.json()) as { status: string }).status).toBe('ignored');
  });

  it('queues re-reviews for pushes to an open MR (update with oldrev)', async () => {
    const response = await post(
      payload({}, { action: 'update', oldrev: 'b'.repeat(40), last_commit: { id: 'd'.repeat(40) } }),
    );
    expect(response.status).toBe(202);
  });

  it('accepts large GitLab payloads (above the 100 kB default body limit)', async () => {
    const response = await post(payload({}, { description: 'x'.repeat(300_000), last_commit: { id: 'e'.repeat(40) } }));
    expect(response.status).toBe(202);
  });

  it('re-connecting is idempotent and rotates the webhook token', async () => {
    const slug = (
      await prisma.organization.findFirstOrThrow({ where: { repositories: { some: { id: repositoryId } } } })
    ).slug;
    const oldToken = webhookToken;
    const again = await connect(slug);
    expect(again.repositoryId).toBe(repositoryId);
    expect(gitlab.state.hooks).toHaveLength(1);
    webhookToken = gitlab.state.hooks[0]?.token ?? '';
    expect(webhookToken).not.toBe(oldToken);
    expect(
      (await post(payload({}, { last_commit: { id: 'f'.repeat(40) } }), { 'x-gitlab-token': oldToken })).status,
    ).toBe(401);
    expect((await post(payload({}, { last_commit: { id: 'f'.repeat(40) } }))).status).toBe(202);
  });

  it('refuses to connect hosts outside the SSRF policy', async () => {
    await expect(
      connectGitLabProject(
        {
          connections: new ConnectionStore(prisma),
          reviews: new ReviewStore(prisma),
          masterKey,
          policy: { allowedHosts: ['gitlab.com'] },
        },
        {
          organizationSlug: 'ssrf-test',
          organizationName: 'x',
          connectionName: 'default',
          baseUrl: 'http://169.254.169.254',
          project: '1',
          token: 'glpat-xxxxxxxxxxxx',
          registerWebhook: false,
        },
      ),
    ).rejects.toThrow(/Outbound URL rejected/);
  });
});
