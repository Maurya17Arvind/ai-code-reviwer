import { FakeGitLab } from '@acra/testing';
import { GitLabApiError, GitLabClient } from './gitlab-client';
import { GitLabProvider, InlinePositionRejectedError, toChangedFile } from './gitlab-provider';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const DIFF = '@@ -1,3 +1,4 @@\n export function total(items) {\n-  return 0;\n+  let sum = 0;\n+  return sum;\n }\n';

describe('GitLabProvider (against a fake GitLab HTTP server)', () => {
  let gitlab: FakeGitLab;
  let provider: GitLabProvider;

  const client = (overrides: Partial<ConstructorParameters<typeof GitLabClient>[0]> = {}) =>
    new GitLabClient({
      baseUrl: gitlab.baseUrl,
      token: gitlab.state.token,
      policy: { allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true },
      ...overrides,
    });

  beforeEach(async () => {
    gitlab = await new FakeGitLab().start();
    gitlab.addMergeRequest({
      iid: 7,
      title: 'Add totals',
      diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: HEAD },
      diffs: [
        { old_path: 'src/cart.ts', new_path: 'src/cart.ts', diff: DIFF },
        {
          old_path: 'logo.png',
          new_path: 'logo.png',
          new_file: true,
          diff: 'Binary files /dev/null and b/logo.png differ\n',
        },
        { old_path: 'big.json', new_path: 'big.json', diff: '', too_large: true },
        { old_path: '../../etc/passwd', new_path: '../../etc/passwd', diff: DIFF },
      ],
    });
    gitlab.setFile(HEAD, 'src/cart.ts', 'export function total(items) {\n  let sum = 0;\n  return sum;\n}\n');
    provider = new GitLabProvider(client(), gitlab.state.projectId);
  });

  afterEach(() => gitlab.stop());

  it('writes an approved fix as one commit on a new fix branch and opens an MR (never merged)', async () => {
    const branch = 'ai-review/fix-0123456789ab';
    expect(await provider.branchHead(branch)).toBeNull();
    const { commitSha } = await provider.commitFileToNewBranch({
      branch,
      baseSha: HEAD,
      path: 'src/cart.ts',
      content: 'fixed\n',
      message: 'fix: totals',
    });
    expect(gitlab.state.commits[0]).toMatchObject({ id: commitSha, branch, startSha: HEAD, content: 'fixed\n' });
    expect(await provider.branchHead(branch)).toBe(commitSha);
    await expect(
      provider.commitFileToNewBranch({ branch, baseSha: HEAD, path: 'src/cart.ts', content: 'x', message: 'm' }),
    ).rejects.toThrow(/already exists/);
    await expect(
      provider.commitFileToNewBranch({
        branch: 'main',
        baseSha: HEAD,
        path: 'src/cart.ts',
        content: 'x',
        message: 'm',
      }),
    ).rejects.toThrow(/fix-\*/);

    const mr = await provider.createReviewRequest({
      sourceBranch: branch,
      targetBranch: 'main',
      title: 'Fix totals',
      description: 'body',
    });
    expect(mr.webUrl).toContain('/merge_requests/');
    expect(gitlab.state.createdMergeRequests).toEqual([
      { iid: mr.id, source: branch, target: 'main', title: 'Fix totals', description: 'body' },
    ]);
    expect(gitlab.state.requests.some((r) => /\/merge$/.test(r.path))).toBe(false);
  });

  it('reads the merge request with its diff refs', async () => {
    const mr = await provider.getReviewRequest(7);
    expect(mr).toMatchObject({
      id: 7,
      title: 'Add totals',
      state: 'opened',
      draft: false,
      refs: { baseSha: BASE, headSha: HEAD },
    });
  });

  it('maps diffs to the shared model, flags binary/unavailable files and drops unsafe paths', async () => {
    const changes = await provider.getReviewRequestChanges(await provider.getReviewRequest(7));
    expect(changes.scope).toEqual({ kind: 'merge_request', provider: 'gitlab', id: 7 });
    expect(changes.head).toEqual({ kind: 'commit', sha: HEAD });
    expect(changes.files.map((f) => f.path)).toEqual(['src/cart.ts', 'logo.png', 'big.json']);
    expect(changes.files[0]).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(changes.files[1]).toMatchObject({ status: 'added', isBinary: true });
    expect(changes.files[2]).toMatchObject({ diffUnavailable: true });
  });

  it('paginates diffs beyond one page', async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ old_path: `f${i}.ts`, new_path: `f${i}.ts`, diff: DIFF }));
    gitlab.addMergeRequest({ iid: 8, diffs: many });
    const changes = await provider.getReviewRequestChanges(await provider.getReviewRequest(8));
    expect(changes.files).toHaveLength(130);
  });

  it('reads files at a commit and returns null for missing files', async () => {
    expect((await provider.readFile('src/cart.ts', { kind: 'commit', sha: HEAD }))?.content).toContain('let sum');
    expect(await provider.readFile('missing.ts', { kind: 'commit', sha: HEAD })).toBeNull();
    await expect(provider.readFile('src/cart.ts', { kind: 'worktree' })).rejects.toThrow(/commit SHA/);
  });

  it('flags files above the size limit without loading them', async () => {
    gitlab.setFile(HEAD, 'huge.txt', 'x'.repeat(5_000));
    const small = new GitLabProvider(client(), gitlab.state.projectId, { maxFileBytes: 1_000 });
    expect(await small.readFile('huge.txt', { kind: 'commit', sha: HEAD })).toMatchObject({
      tooLarge: true,
      content: '',
    });
  });

  it('publishes inline comments on diff lines, and rejects positions outside the diff', async () => {
    const refs = { baseSha: BASE, startSha: BASE, headSha: HEAD };
    const added = await provider.publishInlineComment({
      requestId: 7,
      body: 'added line',
      refs,
      path: 'src/cart.ts',
      oldPath: 'src/cart.ts',
      newLine: 2,
    });
    expect(added.discussionId).toMatch(/^d/);
    await provider.publishInlineComment({
      requestId: 7,
      body: 'context line',
      refs,
      path: 'src/cart.ts',
      oldPath: 'src/cart.ts',
      newLine: 1,
      oldLine: 1,
    });
    await expect(
      provider.publishInlineComment({
        requestId: 7,
        body: 'nope',
        refs,
        path: 'src/cart.ts',
        oldPath: 'src/cart.ts',
        newLine: 40,
      }),
    ).rejects.toBeInstanceOf(InlinePositionRejectedError);
    expect(gitlab.botNotes(7)).toHaveLength(2);
  });

  it('creates then updates one summary note, lists comments with authorship and resolves discussions', async () => {
    const first = await provider.upsertSummary(7, 'summary v1');
    const second = await provider.upsertSummary(7, 'summary v2', first.noteId);
    expect(second.noteId).toBe(first.noteId);
    const inline = await provider.publishInlineComment({
      requestId: 7,
      body: 'x',
      refs: { baseSha: BASE, startSha: BASE, headSha: HEAD },
      path: 'src/cart.ts',
      oldPath: 'src/cart.ts',
      newLine: 3,
    });
    await provider.resolveDiscussion(7, inline.discussionId);

    const comments = await provider.listComments(7);
    expect(comments.find((c) => c.noteId === first.noteId)).toMatchObject({ body: 'summary v2', authoredByUs: true });
    expect(comments.find((c) => c.discussionId === inline.discussionId)).toMatchObject({
      resolved: true,
      resolvable: true,
    });
  });

  it('registers the webhook once and reuses it', async () => {
    const first = await provider.ensureWebhook('https://review.example/api/webhooks/gitlab/r1', 'tok1');
    const again = await provider.ensureWebhook('https://review.example/api/webhooks/gitlab/r1', 'tok2');
    expect(again).toBe(first);
    expect(gitlab.state.hooks).toHaveLength(1);
  });

  it('retries 429 responses honouring Retry-After', async () => {
    gitlab.state.rateLimitNext = 2;
    expect((await provider.getReviewRequest(7)).id).toBe(7);
  });

  it('reports auth failures and missing merge requests without leaking the token', async () => {
    const bad = new GitLabProvider(client({ token: 'wrong-token' }), gitlab.state.projectId);
    const error = await bad.getProject().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitLabApiError);
    expect((error as GitLabApiError).status).toBe(401);
    expect((error as Error).message).not.toContain('wrong-token');
    await expect(provider.getReviewRequest(999)).rejects.toThrow(/not found/);
  });

  it('refuses hosts outside the SSRF policy before sending the token', async () => {
    const blocked = new GitLabProvider(client({ policy: { allowedHosts: ['gitlab.com'] } }), gitlab.state.projectId);
    await expect(blocked.getProject()).rejects.toThrow(/Outbound URL rejected/);
    expect(gitlab.state.requests).toHaveLength(0);
  });

  it('refuses to follow redirects', async () => {
    const redirecting = (() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
      )) as unknown as typeof fetch;
    const redirected = new GitLabProvider(client({ fetchImpl: redirecting }), gitlab.state.projectId);
    await expect(redirected.getProject()).rejects.toThrow(/redirect/);
  });
});

describe('toChangedFile', () => {
  it('maps rename and delete flags', () => {
    expect(toChangedFile({ old_path: 'a.ts', new_path: 'b.ts', renamed_file: true, diff: '' })).toMatchObject({
      path: 'b.ts',
      oldPath: 'a.ts',
      status: 'renamed',
    });
    expect(
      toChangedFile({ old_path: 'gone.ts', new_path: 'gone.ts', deleted_file: true, diff: '@@ -1 +0,0 @@\n-x\n' }),
    ).toMatchObject({
      path: 'gone.ts',
      status: 'deleted',
      deletions: 1,
    });
  });
});
