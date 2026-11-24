import { type AiProviderName, type AiReviewer, type AiReviewResult, type ReviewPrompt } from '@acra/ai-providers-core';
import { type ReviewerFactory } from '@acra/ai-providers-factory';
import { loadEnv } from '@acra/configuration';
import { ConnectionStore, ReviewStore } from '@acra/database';
import { FakeGitHub, type FakeGhRepo } from '@acra/testing';
import { type INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { REVIEWER_FACTORY, WorkerConfigSchema } from '../worker-config';
import { WorkerModule } from '../worker.module';
import { MergeRequestReviewService, PermanentReviewError } from './merge-request-review.service';

const sha = (c: string) => c.repeat(40);
const BASE = sha('a');
const BUGGY = sha('d');
const FIXED = sha('e');

const BUGGY_FILE =
  'export function total(items: Item[]) {\n  let sum = 0;\n  for (let i = 0; i <= items.length; i++) sum += items[i].price;\n  return sum;\n}\n';
const BUGGY_PATCH =
  '@@ -1,3 +1,5 @@\n export function total(items: Item[]) {\n-  return 0;\n+  let sum = 0;\n+  for (let i = 0; i <= items.length; i++) sum += items[i].price;\n+  return sum;\n }';
const FIXED_FILE =
  'export function total(items: Item[]) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n';
const FIXED_PATCH =
  '@@ -1,3 +1,3 @@\n export function total(items: Item[]) {\n-  return 0;\n+  return items.reduce((sum, item) => sum + item.price, 0);\n }';

/** Fake AI: reports the off-by-one only when the buggy loop is in the prompt. */
class FakeReviewer implements AiReviewer {
  readonly model = 'fake-model';
  constructor(readonly provider: AiProviderName) {}
  async review(prompt: ReviewPrompt): Promise<AiReviewResult> {
    const buggy = prompt.user.includes('i <= items.length');
    const finding = {
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
    return {
      provider: this.provider,
      model: this.model,
      servedByModel: this.model,
      output: { findings: buggy ? [finding] : [], summary: buggy ? 'One bug.' : 'Looks good.' },
      usage: { inputTokens: 500, outputTokens: 50 },
      costUsd: 0.001,
      latencyMs: 5,
    };
  }
}
const fakeFactory: ReviewerFactory = (_env, providers) => ({
  reviewers: [...providers].filter((p) => p !== 'ollama').map((p) => new FakeReviewer(p)),
  skipped: [],
  destinations: [],
});

describe('GitHub pull request review (worker + PostgreSQL + fake GitHub App)', () => {
  let github: FakeGitHub;
  let repo: FakeGhRepo;
  let app: INestApplicationContext;
  let service: MergeRequestReviewService;
  let organizationId: string;
  let repositoryId: string;
  const installationId = 4000 + Math.floor(Math.random() * 1_000_000);

  const job = (headSha: string, provider: 'github' | 'gitlab' = 'github') => ({
    organizationId,
    repositoryId,
    provider,
    requestId: 7,
    headSha,
    deliveryId: randomUUID(),
    trigger: 'webhook' as const,
  });

  beforeAll(async () => {
    github = await new FakeGitHub().start();
    github.addInstallation(installationId, 'acme');
    repo = github.addRepo('acme/shop', installationId);
    github.addRepo('acme/other', installationId);
    github.addPull(repo, {
      number: 7,
      title: 'Cart totals',
      head: { sha: BUGGY, ref: 'feature' },
      base: { sha: BASE, ref: 'main' },
      mergeBase: BASE,
      files: [{ filename: 'src/cart.ts', status: 'modified', additions: 3, deletions: 1, patch: BUGGY_PATCH }],
    });
    repo.files.set(`${BUGGY}:src/cart.ts`, BUGGY_FILE);

    const config = loadEnv(WorkerConfigSchema, {
      ...process.env,
      GITHUB_APP_ID: github.appId,
      GITHUB_APP_PRIVATE_KEY: github.privateKeyPem,
      GITHUB_APP_PRIVATE_KEY_PATH: undefined, // ignore a real key path from a developer .env
      GITHUB_API_URL: github.baseUrl,
      GITHUB_ALLOWED_HOSTS: '127.0.0.1',
      GITHUB_ALLOW_PRIVATE_NETWORK: 'true',
    });
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.forRoot(config)] })
      .overrideProvider(REVIEWER_FACTORY)
      .useValue(fakeFactory)
      .compile();
    app = await moduleRef.init();
    service = app.get(MergeRequestReviewService);

    // Seed as `admin connect-github` does: installation connection + synced repositories.
    const connections = app.get(ConnectionStore);
    const tenant = await connections.ensureOrganization(`gh-${randomUUID().slice(0, 8)}`, 'GitHub Org');
    organizationId = tenant.organizationId;
    const connection = await connections.saveGitHubConnection(tenant, {
      installationId,
      accountLogin: 'acme',
      apiBaseUrl: github.baseUrl,
    });
    await connections.syncGitHubRepositories(
      tenant,
      connection.id,
      [{ id: repo.id, fullName: repo.full_name, defaultBranch: 'main', webUrl: repo.html_url }],
      { exclusive: true },
    );
    const found = await connections.findGitHubConnection(installationId);
    expect(found?.organizationId).toBe(organizationId);
    repositoryId = (await app.get(ReviewStore).findGitHubRepository(installationId, repo.id))?.id ?? '';
    expect(repositoryId).not.toBe('');
  });

  afterAll(async () => {
    await app?.close();
    await github?.stop();
  });

  it('reviews the PR with a repository-scoped token: one review comment on the line, one summary comment', async () => {
    const outcome = await service.run(job(BUGGY));
    expect(outcome).toMatchObject({ status: 'completed', findings: 1, inlineComments: 1 });

    expect(repo.threads).toHaveLength(1);
    expect(repo.threads[0]?.comment).toMatchObject({ path: 'src/cart.ts', line: 3, commitId: BUGGY });
    expect(repo.threads[0]?.comment.body).toMatch(/<!-- acra:finding fp=[0-9a-f]+ -->/);
    expect(repo.issueComments).toHaveLength(1);
    expect(repo.issueComments[0]?.login).toBe('acra-review[bot]');

    const grants = [...github.tokens.values()];
    expect(grants.every((g) => g.installationId === installationId)).toBe(true);
    expect(grants.every((g) => JSON.stringify(g.repositoryIds) === JSON.stringify([repo.id]))).toBe(true);
  });

  it('is idempotent for the same head commit', async () => {
    expect(await service.run(job(BUGGY))).toMatchObject({ status: 'duplicate' });
    expect(repo.threads).toHaveLength(1);
    expect(repo.issueComments).toHaveLength(1);
  });

  it('skips a stale job when a newer commit was pushed', async () => {
    expect(await service.run(job(sha('9')))).toMatchObject({ status: 'superseded' });
  });

  it('resolves the review thread and posts a new summary for the fixed commit', async () => {
    const pull = repo.pulls.get(7);
    if (!pull) throw new Error('missing pull');
    pull.head = { sha: FIXED, ref: 'feature' };
    pull.files = [{ filename: 'src/cart.ts', status: 'modified', additions: 1, deletions: 1, patch: FIXED_PATCH }];
    repo.files.set(`${FIXED}:src/cart.ts`, FIXED_FILE);

    expect(await service.run(job(FIXED))).toMatchObject({ status: 'completed', findings: 0, inlineComments: 0 });
    expect(repo.threads[0]?.isResolved).toBe(true);
    expect(repo.issueComments).toHaveLength(2);
    expect(repo.issueComments.at(-1)?.body).toContain(`<!-- acra:summary sha=${FIXED} -->`);
  });

  it('refuses a job whose provider does not match the repository', async () => {
    await expect(service.run(job(FIXED, 'gitlab'))).rejects.toBeInstanceOf(PermanentReviewError);
  });
});
