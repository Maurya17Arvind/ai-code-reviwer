import { InlinePositionRejectedError } from '@acra/git-providers-core';
import { FakeGitHub, type FakeGhRepo } from '@acra/testing';
import { generateKeyPairSync } from 'node:crypto';
import { createAppJwt, GitHubAppAuth, WRITE_TOKEN_PERMISSIONS } from './github-app-auth';
import { GitHubApiError } from './github-client';
import { GitHubProvider, toChangedFile } from './github-provider';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const PATCH = '@@ -1,3 +1,4 @@\n export function total(items) {\n-  return 0;\n+  let sum = 0;\n+  return sum;\n }';

describe('GitHub App adapter (against a fake GitHub server)', () => {
  let github: FakeGitHub;
  let repo: FakeGhRepo;
  let other: FakeGhRepo;
  let auth: GitHubAppAuth;
  let provider: GitHubProvider;

  beforeEach(async () => {
    github = await new FakeGitHub().start();
    github.addInstallation(77, 'acme');
    repo = github.addRepo('acme/shop', 77);
    other = github.addRepo('acme/secret', 77);
    github.addPull(repo, {
      number: 12,
      title: 'Totals',
      head: { sha: HEAD, ref: 'feature' },
      base: { sha: BASE, ref: 'main' },
      mergeBase: BASE,
      files: [
        { filename: 'src/cart.ts', status: 'modified', additions: 2, deletions: 1, patch: PATCH },
        { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
        { filename: 'huge.json', status: 'modified', additions: 5000, deletions: 10 },
        { filename: 'new.ts', previous_filename: 'old.ts', status: 'renamed', additions: 0, deletions: 0 },
      ],
    });
    repo.files.set(`${HEAD}:src/cart.ts`, 'export function total(items) {\n  let sum = 0;\n  return sum;\n}\n');
    auth = new GitHubAppAuth({
      appId: github.appId,
      privateKey: github.privateKeyPem,
      apiBaseUrl: github.baseUrl,
      policy: { allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true },
    });
    provider = new GitHubProvider(auth.installationClient(77, [repo.id]), 'acme/shop', {
      botLogin: await auth.botLogin(),
    });
  });

  afterEach(() => github.stop());

  it('writes an approved fix only with a write-scoped token, then opens a PR (never merged)', async () => {
    const branch = 'ai-review/fix-0123456789ab';
    const input = { branch, baseSha: HEAD, path: 'src/cart.ts', content: 'fixed\n', message: 'fix: totals' };
    // The review token (contents:read) cannot write.
    await expect(provider.commitFileToNewBranch(input)).rejects.toThrow(/403/);

    const writer = new GitHubProvider(auth.installationClient(77, [repo.id], WRITE_TOKEN_PERMISSIONS), 'acme/shop', {
      botLogin: 'acra-review[bot]',
    });
    expect(await writer.branchHead(branch)).toBeNull();
    const { commitSha } = await writer.commitFileToNewBranch(input);
    expect(repo.commits[0]).toMatchObject({ sha: commitSha, branch, content: 'fixed\n' });
    expect(await writer.branchHead(branch)).toBe(commitSha);
    await expect(writer.commitFileToNewBranch(input)).rejects.toThrow(/422/);
    expect([...github.tokens.values()].some((t) => (t.permissions as { contents: string }).contents === 'write')).toBe(
      true,
    );

    const pr = await writer.createReviewRequest({
      sourceBranch: branch,
      targetBranch: 'main',
      title: 'Fix',
      description: 'b',
    });
    expect(pr.webUrl).toContain(`/pull/${pr.id}`);
    expect(repo.createdPulls).toEqual([{ number: pr.id, head: branch, base: 'main', title: 'Fix', body: 'b' }]);
    expect(github.requests.some((r) => /\/merge$/.test(r.path))).toBe(false);
  });

  it('authenticates as the app (RS256 JWT) and requests repository-scoped, least-privilege tokens', async () => {
    expect(await auth.botLogin()).toBe('acra-review[bot]');
    await provider.getReviewRequest(12);
    const grants = [...github.tokens.values()];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      installationId: 77,
      repositoryIds: [repo.id],
      permissions: { contents: 'read', pull_requests: 'write' },
    });
  });

  it('caches installation tokens', async () => {
    await provider.getReviewRequest(12);
    await provider.getReviewRequest(12);
    expect(github.tokens.size).toBe(1);
  });

  it('cannot read repositories outside the token scope', async () => {
    const outside = new GitHubProvider(auth.installationClient(77, [repo.id]), 'acme/secret', { botLogin: 'x' });
    github.addPull(other, { number: 1 });
    await expect(outside.getReviewRequest(1)).rejects.toThrow(/not found/);
  });

  it('reads the pull request with the merge base as diff base', async () => {
    expect(await provider.getReviewRequest(12)).toMatchObject({
      id: 12,
      state: 'opened',
      refs: { baseSha: BASE, startSha: BASE, headSha: HEAD },
    });
  });

  it('maps PR files: patch hunks, binary, withheld diffs and renames', async () => {
    const changes = await provider.getReviewRequestChanges(await provider.getReviewRequest(12));
    expect(changes.scope).toEqual({ kind: 'merge_request', provider: 'github', id: 12 });
    expect(changes.files.find((f) => f.path === 'src/cart.ts')).toMatchObject({ status: 'modified', additions: 2 });
    expect(changes.files.find((f) => f.path === 'src/cart.ts')?.hunks).toHaveLength(1);
    expect(changes.files.find((f) => f.path === 'logo.png')).toMatchObject({ isBinary: true });
    expect(changes.files.find((f) => f.path === 'huge.json')).toMatchObject({ diffUnavailable: true });
    expect(changes.files.find((f) => f.path === 'new.ts')).toMatchObject({
      status: 'renamed',
      oldPath: 'old.ts',
      isBinary: false,
    });
  });

  it('reads raw files at a commit', async () => {
    expect((await provider.readFile('src/cart.ts', { kind: 'commit', sha: HEAD }))?.content).toContain('let sum');
    expect(await provider.readFile('missing.ts', { kind: 'commit', sha: HEAD })).toBeNull();
  });

  it('posts review comments on diff lines, rejects others, and resolves threads via GraphQL', async () => {
    const refs = { baseSha: BASE, startSha: BASE, headSha: HEAD };
    await provider.publishInlineComment({
      requestId: 12,
      body: 'b1',
      refs,
      path: 'src/cart.ts',
      oldPath: 'src/cart.ts',
      newLine: 2,
    });
    await expect(
      provider.publishInlineComment({
        requestId: 12,
        body: 'x',
        refs,
        path: 'src/cart.ts',
        oldPath: 'src/cart.ts',
        newLine: 40,
      }),
    ).rejects.toBeInstanceOf(InlinePositionRejectedError);

    const comments = await provider.listComments(12);
    const thread = comments.find((c) => c.body === 'b1');
    expect(thread).toMatchObject({ authoredByUs: true, resolvable: true, resolved: false });
    expect(thread?.discussionId).toMatch(/^PRRT_/);
    await provider.resolveDiscussion(12, thread?.discussionId ?? '');
    expect(repo.threads[0]?.isResolved).toBe(true);
  });

  it('creates and then updates a single summary issue comment', async () => {
    const first = await provider.upsertSummary(12, 'v1');
    const second = await provider.upsertSummary(12, 'v2', first.noteId);
    expect(second.noteId).toBe(first.noteId);
    expect(repo.issueComments).toHaveLength(1);
    expect((await provider.listComments(12)).find((c) => c.noteId === first.noteId)).toMatchObject({
      body: 'v2',
      authoredByUs: true,
      resolvable: false,
    });
  });

  it('retries rate limits and refuses hosts outside the SSRF policy', async () => {
    github.rateLimitNext = 2;
    expect((await provider.getReviewRequest(12)).id).toBe(12);
    const blocked = new GitHubAppAuth({
      appId: github.appId,
      privateKey: github.privateKeyPem,
      apiBaseUrl: github.baseUrl,
      policy: { allowedHosts: ['api.github.com'] },
    });
    await expect(blocked.botLogin()).rejects.toThrow(/Outbound URL rejected/);
  });

  it('rejects JWTs signed with the wrong key and invalid repository names', async () => {
    const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const impostor = new GitHubAppAuth({
      appId: github.appId,
      privateKey: wrongKey,
      apiBaseUrl: github.baseUrl,
      policy: { allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true },
    });
    const error = await impostor.botLogin().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(401);
    expect(() => new GitHubProvider(auth.installationClient(77), '../etc/passwd', { botLogin: 'x' })).toThrow(
      /Invalid GitHub repository/,
    );
    expect(createAppJwt('1', generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey).split('.')).toHaveLength(
      3,
    );
  });
});

describe('toChangedFile', () => {
  it('ignores unchanged files and drops unsafe paths', () => {
    expect(toChangedFile({ filename: 'a.ts', status: 'unchanged', additions: 0, deletions: 0 })).toBeNull();
    expect(
      toChangedFile({ filename: '../x.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+x' }),
    ).toBeNull();
    expect(
      toChangedFile({
        filename: 'gone.ts',
        status: 'removed',
        additions: 0,
        deletions: 2,
        patch: '@@ -1,2 +0,0 @@\n-a\n-b',
      }),
    ).toMatchObject({ status: 'deleted', deletions: 2 });
  });
});
