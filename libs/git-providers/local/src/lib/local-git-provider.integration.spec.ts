import { type ChangedFile, GitProviderError } from '@acra/git-providers-core';
import { buildReviewContext } from '@acra/repository-context';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TempGitRepo } from '@acra/testing';
import { LocalGitProvider } from './local-git-provider';

const paths = (files: readonly ChangedFile[]) => files.map((f) => f.path).sort();
const expectCode = async (promise: Promise<unknown>, code: GitProviderError['code']) => {
  await expect(promise).rejects.toBeInstanceOf(GitProviderError);
  await expect(promise).rejects.toMatchObject({ code });
};

describe('LocalGitProvider (real git)', () => {
  const repos: TempGitRepo[] = [];
  const repo = (branch?: string) => {
    const created = TempGitRepo.create(branch ? { initialBranch: branch } : {});
    repos.push(created);
    return created;
  };

  afterAll(() => repos.forEach((r) => r.dispose()));

  describe('opening repositories', () => {
    it('rejects directories that are not repositories', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'acra-norepo-'));
      try {
        await expectCode(LocalGitProvider.open(dir), 'NOT_A_REPOSITORY');
        await expectCode(LocalGitProvider.open(join(dir, 'missing')), 'NOT_A_REPOSITORY');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('opens from a sub-directory and reports repository info', async () => {
      const r = repo();
      r.write('src/app.ts', 'export const a = 1;\n');
      const head = r.commit('initial');
      r.git('remote', 'add', 'origin', 'https://user:s3cret-token@github.com/acme/app.git');
      mkdirSync(join(r.root, 'src', 'nested'), { recursive: true });

      const provider = await LocalGitProvider.open(join(r.root, 'src', 'nested'));
      const info = await provider.getRepositoryInfo();
      expect(info.rootPath.toLowerCase()).toBe(r.root.replace(/\\/g, '/').toLowerCase());
      expect(info).toMatchObject({ currentBranch: 'main', headSha: head, defaultBaseBranch: 'main' });
      expect(info.remoteUrl).toBe('https://***:***@github.com/acme/app.git');
    });

    it('handles repositories without commits and detached HEAD', async () => {
      const empty = repo();
      const emptyInfo = await (await LocalGitProvider.open(empty.root)).getRepositoryInfo();
      expect(emptyInfo).toMatchObject({ headSha: null, currentBranch: 'main', defaultBaseBranch: null });

      const detached = repo();
      detached.write('a.txt', '1\n');
      const sha = detached.commit('one');
      detached.git('checkout', '--quiet', '--detach', sha);
      expect((await (await LocalGitProvider.open(detached.root)).getRepositoryInfo()).currentBranch).toBeNull();
    });
  });

  describe('change scopes', () => {
    let r: TempGitRepo;
    let provider: LocalGitProvider;

    beforeAll(async () => {
      r = repo();
      r.write('src/staged.ts', 'export const s = 1;\n').write('src/unstaged.ts', 'export const u = 1;\n');
      r.commit('initial');
      r.git('checkout', '--quiet', '-b', 'feature/graphql');
      r.write('src/feature.ts', 'export const f = 1;\n');
      r.commit('feature work');
      r.git('checkout', '--quiet', 'main');
      r.write('src/main-only.ts', 'export const m = 1;\n');
      r.commit('main moved on');
      r.git('checkout', '--quiet', 'feature/graphql');
      r.write('src/staged.ts', 'export const s = 2;\n');
      r.git('add', 'src/staged.ts');
      r.write('src/unstaged.ts', 'export const u = 2;\n');
      r.write('src/untracked.ts', 'line one\nline two');
      r.write('.gitignore', 'ignored.log\n').write('ignored.log', 'noise');
      provider = await LocalGitProvider.open(r.root);
    });

    it('staged: index vs HEAD only', async () => {
      const set = await provider.getChangeSet({ kind: 'staged' });
      expect(paths(set.files)).toEqual(['src/staged.ts']);
      expect(set.head).toEqual({ kind: 'index' });
      expect(set.files[0]?.hunks[0]?.lines.map((l) => [l.kind, l.content])).toEqual([
        ['del', 'export const s = 1;'],
        ['add', 'export const s = 2;'],
      ]);
    });

    it('unstaged: working tree vs index, untracked optional, ignored files never', async () => {
      const withUntracked = await provider.getChangeSet({ kind: 'unstaged', includeUntracked: true });
      expect(paths(withUntracked.files)).toEqual(['.gitignore', 'src/unstaged.ts', 'src/untracked.ts']);
      const untracked = withUntracked.files.find((f) => f.path === 'src/untracked.ts');
      expect(untracked).toMatchObject({ status: 'added', additions: 2 });
      expect(untracked?.hunks[0]?.lines.at(-1)).toMatchObject({
        content: 'line two',
        newLine: 2,
        noNewlineAtEof: true,
      });

      const trackedOnly = await provider.getChangeSet({ kind: 'unstaged', includeUntracked: false });
      expect(paths(trackedOnly.files)).toEqual(['src/unstaged.ts']);
    });

    it('committed: only commits since the merge-base, not later base commits', async () => {
      const set = await provider.getChangeSet({ kind: 'committed', base: 'main' });
      expect(paths(set.files)).toEqual(['src/feature.ts']);
      expect(set.base.kind).toBe('commit');
    });

    it('branch: compares another branch without checking it out', async () => {
      const other = repo();
      other.write('a.ts', 'a\n');
      other.commit('base');
      other.git('branch', 'feature/x');
      other.git('checkout', '--quiet', 'feature/x');
      other.write('b.ts', 'b\n');
      other.commit('on feature');
      other.git('checkout', '--quiet', 'main');

      const set = await (
        await LocalGitProvider.open(other.root)
      ).getChangeSet({ kind: 'branch', base: 'main', head: 'feature/x' });
      expect(paths(set.files)).toEqual(['b.ts']);
      expect(other.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    });

    it('all: committed + staged + unstaged + untracked against the merge-base', async () => {
      const set = await provider.getChangeSet({ kind: 'all', base: 'main', includeUntracked: true });
      expect(paths(set.files)).toEqual([
        '.gitignore',
        'src/feature.ts',
        'src/staged.ts',
        'src/unstaged.ts',
        'src/untracked.ts',
      ]);
      expect(set.head).toEqual({ kind: 'worktree' });
    });

    it('never modifies the repository', async () => {
      const before = r.git('status', '--porcelain=v1', '--untracked-files=all');
      await provider.getChangeSet({ kind: 'all', base: 'main', includeUntracked: true });
      await provider.readFile('src/staged.ts', { kind: 'index' });
      expect(r.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(before);
    });
  });

  describe('diff details', () => {
    it('detects renames, binary files and staged changes in a repo without commits', async () => {
      const fresh = repo();
      fresh.write('first.ts', 'x\n');
      fresh.git('add', 'first.ts');
      const initial = await (await LocalGitProvider.open(fresh.root)).getChangeSet({ kind: 'staged' });
      expect(initial.files).toMatchObject([{ path: 'first.ts', status: 'added', additions: 1 }]);

      const r = repo();
      r.write('src/old-name.ts', Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
      r.commit('initial');
      r.git('mv', 'src/old-name.ts', 'src/new-name.ts');
      r.write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]));
      r.git('add', '-A');
      const set = await (await LocalGitProvider.open(r.root)).getChangeSet({ kind: 'staged' });
      expect(set.files.find((f) => f.path === 'src/new-name.ts')).toMatchObject({
        status: 'renamed',
        oldPath: 'src/old-name.ts',
      });
      expect(set.files.find((f) => f.path === 'logo.png')).toMatchObject({ status: 'added', isBinary: true });
    });

    it('handles paths with spaces and unicode', async () => {
      const r = repo();
      r.write('docs/my file.md', 'a\n').write('src/café.ts', 'a\n');
      r.commit('initial');
      r.write('docs/my file.md', 'b\n').write('src/café.ts', 'b\n');
      const set = await (
        await LocalGitProvider.open(r.root)
      ).getChangeSet({ kind: 'unstaged', includeUntracked: false });
      expect(paths(set.files)).toEqual(['docs/my file.md', 'src/café.ts']);
    });
  });

  describe('reading files', () => {
    let r: TempGitRepo;
    let provider: LocalGitProvider;
    let firstSha: string;

    beforeAll(async () => {
      r = repo();
      r.write('a.ts', 'v1\n');
      firstSha = r.commit('one');
      r.write('a.ts', 'v2\n');
      r.git('add', 'a.ts');
      r.write('a.ts', 'v3\n');
      r.write('big.txt', 'x'.repeat(2_000));
      provider = await LocalGitProvider.open(r.root, { maxFileBytes: 1_000 });
    });

    it('reads the commit, index and working-tree versions separately', async () => {
      expect((await provider.readFile('a.ts', { kind: 'commit', sha: firstSha }))?.content).toBe('v1\n');
      expect((await provider.readFile('a.ts', { kind: 'index' }))?.content).toBe('v2\n');
      expect((await provider.readFile('a.ts', { kind: 'worktree' }))?.content).toBe('v3\n');
    });

    it('returns null for missing files and flags large files without loading them', async () => {
      expect(await provider.readFile('missing.ts', { kind: 'worktree' })).toBeNull();
      expect(await provider.readFile('missing.ts', { kind: 'commit', sha: firstSha })).toBeNull();
      expect(await provider.readFile('big.txt', { kind: 'worktree' })).toMatchObject({ tooLarge: true, content: '' });
    });

    it('rejects path traversal and malformed commit ids', async () => {
      await expectCode(provider.readFile('../outside.txt', { kind: 'worktree' }), 'UNSAFE_PATH');
      await expectCode(provider.readFile('/etc/passwd', { kind: 'index' }), 'UNSAFE_PATH');
      await expectCode(provider.readFile('a.ts', { kind: 'commit', sha: 'HEAD' }), 'UNSAFE_REF');
    });
  });

  describe('revisions and safety', () => {
    let r: TempGitRepo;
    let provider: LocalGitProvider;

    beforeAll(async () => {
      r = repo();
      r.write('a.ts', '1\n');
      r.commit('feat: first commit\n\nBody text.');
      provider = await LocalGitProvider.open(r.root);
    });

    it('rejects option injection and unknown refs', async () => {
      await expectCode(provider.getChangeSet({ kind: 'committed', base: '--upload-pack=touch pwned' }), 'UNSAFE_REF');
      await expectCode(provider.getChangeSet({ kind: 'committed', base: 'does-not-exist' }), 'UNKNOWN_REF');
      expect(existsSync(join(r.root, 'pwned'))).toBe(false);
    });

    it('reports unrelated histories', async () => {
      r.git('checkout', '--quiet', '--orphan', 'unrelated');
      r.git('rm', '-rf', '--quiet', '.');
      r.write('z.ts', 'z\n');
      r.commit('orphan');
      r.git('checkout', '--quiet', 'main');
      await expectCode(provider.getChangeSet({ kind: 'branch', base: 'main', head: 'unrelated' }), 'NO_MERGE_BASE');
    });

    it('reads commit details', async () => {
      const details = await provider.getCommitDetails('HEAD');
      expect(details).toMatchObject({ subject: 'feat: first commit', body: 'Body text.', authorName: 'Test User' });
      expect(details.sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('does not execute a core.fsmonitor command from the repository config', async () => {
      const hostile = repo();
      hostile.write('a.ts', '1\n');
      hostile.commit('initial');
      hostile.git('config', 'core.fsmonitor', 'echo pwned > fsmonitor-ran.txt');
      hostile.write('a.ts', '2\n');
      const hostileProvider = await LocalGitProvider.open(hostile.root);
      await hostileProvider.getChangeSet({ kind: 'all', base: 'main', includeUntracked: true });
      await hostileProvider.getRepositoryInfo();
      expect(existsSync(join(hostile.root, 'fsmonitor-ran.txt'))).toBe(false);
    });
  });

  it('feeds buildReviewContext end to end', async () => {
    const r = repo();
    r.write('src/service.ts', Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    r.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    r.commit('initial');
    r.write(
      'src/service.ts',
      Array.from({ length: 50 }, (_, i) => (i === 24 ? 'CHANGED' : `line ${i + 1}`)).join('\n') + '\n',
    );
    r.write('pnpm-lock.yaml', 'lockfileVersion: 10\n');

    const provider = await LocalGitProvider.open(r.root);
    const changeSet = await provider.getChangeSet({ kind: 'unstaged', includeUntracked: true });
    const context = await buildReviewContext(changeSet, provider, {
      exclude: ['**/pnpm-lock.yaml'],
      budget: { maxFiles: 10, maxFileBytes: 100_000, surroundingLines: 5, maxTotalBytes: 1_000_000 },
    });
    expect(context.files.map((f) => f.path)).toEqual(['src/service.ts']);
    expect(context.omitted).toMatchObject([{ path: 'pnpm-lock.yaml', reason: 'excluded' }]);
    const snippet = context.files[0]?.snippets[0];
    expect(snippet).toMatchObject({ side: 'new', startLine: 17, endLine: 33 });
    expect(snippet?.text).toContain('CHANGED');
  });
});
