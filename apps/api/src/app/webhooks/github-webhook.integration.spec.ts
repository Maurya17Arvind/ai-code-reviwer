import { loadEnv } from '@acra/configuration';
import { ConnectionStore, createPrismaClient, type PrismaClient } from '@acra/database';
import { createRedisConnectionOptions, QueueName, reviewJobId } from '@acra/queue';
import { signWebhookPayload } from '@acra/security';
import { FakeGitHub, type FakeGhRepo } from '@acra/testing';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { connectGitHubInstallation } from '../../admin/connect-github';
import { ApiConfigSchema } from '../api-config';
import { AppModule } from '../app.module';
import { APP_OPTIONS, configureApp } from '../configure-app';

const HEAD = 'f'.repeat(40);
const SECRET = `whsec-${randomUUID()}`;

describe('GitHub App webhook intake + connect-github (API + PostgreSQL + Redis + fake GitHub)', () => {
  let github: FakeGitHub;
  let shop: FakeGhRepo;
  let docs: FakeGhRepo;
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaClient;
  let queue: Queue;
  let organizationId: string;
  const installationId = 5_000_000 + Math.floor(Math.random() * 1_000_000);

  const pullRequest = (overrides: Record<string, unknown> = {}, repo = shop) => ({
    action: 'opened',
    installation: { id: installationId },
    repository: { id: repo.id, full_name: repo.full_name, default_branch: 'main', html_url: repo.html_url },
    pull_request: { number: 4, state: 'open', title: 'Hello', head: { sha: HEAD } },
    ...overrides,
  });

  const post = (body: unknown, event = 'pull_request', headers: Record<string, string> = {}) => {
    const raw = JSON.stringify(body);
    return fetch(`${baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': signWebhookPayload(SECRET, raw),
        ...headers,
      },
      body: raw,
    });
  };

  const repoRow = (externalId: number) =>
    prisma.repository.findFirst({ where: { organizationId, provider: 'GITHUB', externalId: String(externalId) } });

  beforeAll(async () => {
    github = await new FakeGitHub().start();
    github.addInstallation(installationId, 'acme');
    shop = github.addRepo('acme/shop', installationId);
    docs = github.addRepo('acme/docs', installationId);

    const config = loadEnv(ApiConfigSchema, {
      ...process.env,
      API_CORS_ORIGINS: 'http://localhost:4300',
      GITHUB_WEBHOOK_SECRET: SECRET,
    });
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL, poolMax: 2 });
    app = await NestFactory.create(AppModule.forRoot(config), APP_OPTIONS);
    configureApp(app, config);
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    queue = new Queue(QueueName.Reviews, { connection: createRedisConnectionOptions(config.REDIS_URL, 'producer') });

    const result = await connectGitHubInstallation(
      {
        connections: new ConnectionStore(prisma),
        app: {
          appId: github.appId,
          privateKey: github.privateKeyPem,
          apiBaseUrl: github.baseUrl,
          policy: { allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true },
        },
      },
      { organizationSlug: `gh-${randomUUID().slice(0, 8)}`, organizationName: 'GitHub Org', installationId },
    );
    organizationId = result.organizationId;
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    await app?.close();
    await prisma?.$disconnect();
    await github?.stop();
  });

  it('connect-github verifies the installation and registers its repositories without storing a secret', async () => {
    const connection = await prisma.providerConnection.findFirstOrThrow({
      where: { provider: 'GITHUB', installationId: String(installationId) },
    });
    expect(connection).toMatchObject({ organizationId, accountLogin: 'acme', encryptedToken: null, tokenKeyId: null });
    expect(await repoRow(shop.id)).toMatchObject({ fullName: 'acme/shop', isActive: true });
    expect(await repoRow(docs.id)).toMatchObject({ fullName: 'acme/docs', isActive: true });
  });

  it('refuses to connect an installation already owned by another organization', async () => {
    await expect(
      connectGitHubInstallation(
        {
          connections: new ConnectionStore(prisma),
          app: {
            appId: github.appId,
            privateKey: github.privateKeyPem,
            apiBaseUrl: github.baseUrl,
            policy: { allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true },
          },
        },
        { organizationSlug: `other-${randomUUID().slice(0, 8)}`, organizationName: 'Other', installationId },
      ),
    ).rejects.toThrow(/another organization/);
  });

  it('queues a review for a signed pull_request event (202) and deduplicates redeliveries', async () => {
    const delivery = randomUUID();
    const first = await post(pullRequest(), 'pull_request', { 'x-github-delivery': delivery });
    expect(first.status).toBe(202);
    const body = (await first.json()) as { status: string; jobId: string };
    const repositoryId = (await repoRow(shop.id))?.id ?? '';
    expect(body.jobId).toBe(reviewJobId({ provider: 'github', repositoryId, requestId: 4, headSha: HEAD }));
    const job = await queue.getJob(body.jobId);
    expect(job?.data).toMatchObject({ provider: 'github', organizationId, repositoryId, requestId: 4, headSha: HEAD });
    expect(JSON.stringify(job?.data)).not.toContain('Hello');

    const replay = await post(pullRequest(), 'pull_request', { 'x-github-delivery': delivery });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ status: 'duplicate' });
  });

  it('rejects missing, wrong and re-serialised signatures with 401', async () => {
    const raw = JSON.stringify(pullRequest());
    const send = (signature: string | null, body = raw) =>
      fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': randomUUID(),
          ...(signature ? { 'x-hub-signature-256': signature } : {}),
        },
        body,
      });
    for (const response of [
      await send(null),
      await send(signWebhookPayload('wrong-secret', raw)),
      // Same JSON, different bytes: the signature covers the raw body, not the parsed object.
      await send(signWebhookPayload(SECRET, raw), JSON.stringify(pullRequest(), null, 2)),
    ]) {
      expect(response.status).toBe(401);
    }
  });

  it('ignores ping, non-code actions, closed PRs and unknown installations', async () => {
    const expectIgnored = async (response: Response, reason: RegExp) => {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ignored', reason: expect.stringMatching(reason) });
    };
    await expectIgnored(await post({ zen: 'Keep it simple.', hook_id: 1 }, 'ping'), /ping/);
    await expectIgnored(await post(pullRequest({ action: 'edited' })), /does not change code/);
    await expectIgnored(
      await post(pullRequest({ pull_request: { number: 4, state: 'closed', head: { sha: HEAD } } })),
      /closed/,
    );
    await expectIgnored(await post(pullRequest({ installation: { id: 1 } })), /installation not connected/);
    await expectIgnored(await post({ action: 'created' }, 'issues'), /unsupported event/);
  });

  it('auto-registers a new repository of a connected installation on its first pull request', async () => {
    const fresh = github.addRepo('acme/fresh', installationId);
    const response = await post(pullRequest({}, fresh));
    expect(response.status).toBe(202);
    expect(await repoRow(fresh.id)).toMatchObject({ fullName: 'acme/fresh', isActive: true });
  });

  it('syncs installation_repositories and deactivates everything when the app is uninstalled', async () => {
    const removed = await post(
      {
        action: 'removed',
        installation: { id: installationId },
        repositories_added: [],
        repositories_removed: [{ id: docs.id, full_name: docs.full_name }],
      },
      'installation_repositories',
    );
    expect(removed.status).toBe(200);
    expect(await repoRow(docs.id)).toMatchObject({ isActive: false });
    const ignored = await post(pullRequest({}, docs));
    expect(await ignored.json()).toMatchObject({ status: 'ignored', reason: 'repository inactive' });

    const added = await post(
      {
        action: 'added',
        installation: { id: installationId },
        repositories_added: [{ id: docs.id, full_name: docs.full_name }],
        repositories_removed: [],
      },
      'installation_repositories',
    );
    expect(added.status).toBe(200);
    expect(await repoRow(docs.id)).toMatchObject({ isActive: true, defaultBranch: 'main' });

    const deleted = await post({ action: 'deleted', installation: { id: installationId } }, 'installation');
    expect(await deleted.json()).toMatchObject({ status: 'ignored', reason: expect.stringMatching(/deleted/) });
    expect(await repoRow(shop.id)).toMatchObject({ isActive: false });
    const after = await post(pullRequest());
    expect(await after.json()).toMatchObject({ status: 'ignored', reason: 'installation not connected' });
  });
});
