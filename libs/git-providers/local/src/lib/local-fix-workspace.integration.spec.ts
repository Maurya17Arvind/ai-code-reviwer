import { TempGitRepo } from '@acra/testing';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalFixWorkspace } from './local-fix-workspace';

const PATCH = [
  'diff --git a/src/cart.ts b/src/cart.ts',
  '--- a/src/cart.ts',
  '+++ b/src/cart.ts',
  '@@ -1,3 +1,3 @@',
  ' export function total(items) {',
  '-  return 0;',
  '+  return items.length;',
  ' }',
  '',
].join('\n');

describe('LocalFixWorkspace (real git)', () => {
  let repo: TempGitRepo;
  let remote: string;
  let gitDirectory: string;
  let baseSha: string;
  const fixId = '0195f3c2aaaabbbbccccdddd';
  const branch = 'ai-review/fix-0195f3c2aaaa';

  beforeAll(() => {
    repo = TempGitRepo.create();
    repo.write('src/cart.ts', 'export function total(items) {\n  return 0;\n}\n');
    baseSha = repo.commit('initial');
    remote = realpathSync.native(mkdtempSync(join(tmpdir(), 'acra-remote-')));
    execFileSync('git', ['init', '--quiet', '--bare', remote]);
    repo.git('remote', 'add', 'origin', remote);
    gitDirectory = repo.git('rev-parse', '--absolute-git-dir').trim();
    // Hooks are repository code: none of them may run during approved operations.
    for (const hook of ['pre-commit', 'commit-msg', 'post-checkout', 'pre-push']) {
      const path = join(gitDirectory, 'hooks', hook);
      writeFileSync(path, `#!/bin/sh\necho ran > "${join(repo.root, `hook-${hook}`).replace(/\\/g, '/')}"\n`);
      chmodSync(path, 0o755);
    }
    repo.write('local-change.txt', 'user work in progress\n');
  });

  afterAll(() => {
    repo.dispose();
    rmSync(remote, { recursive: true, force: true });
  });

  it('applies, stages, commits and pushes in an isolated worktree without running hooks', async () => {
    const ws = await LocalFixWorkspace.create({ repoRoot: repo.root, gitDirectory, fixId, branch, baseSha });
    expect(resolve(ws.directory).startsWith(resolve(gitDirectory))).toBe(true);

    await ws.applyPatch(PATCH);
    expect(readFileSync(join(ws.directory, 'src/cart.ts'), 'utf8')).toContain('items.length');
    expect(await ws.changedPaths()).toEqual({ staged: [], unstaged: ['src/cart.ts'] });

    await ws.stage(['src/cart.ts']);
    expect(await ws.changedPaths()).toEqual({ staged: ['src/cart.ts'], unstaged: [] });
    const commit = await ws.commit('fix: off-by-one');
    expect(commit).not.toBe(baseSha);
    await expect(ws.commit('again')).rejects.toThrow();

    await ws.push('origin', commit);
    expect(
      execFileSync('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim(),
    ).toBe(commit);

    // The user's checkout is untouched: same branch, same HEAD, their uncommitted file still there.
    expect(repo.git('symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(baseSha);
    expect(readFileSync(join(repo.root, 'src/cart.ts'), 'utf8')).toContain('return 0');
    expect(existsSync(join(repo.root, 'local-change.txt'))).toBe(true);
    for (const hook of ['pre-commit', 'commit-msg', 'post-checkout', 'pre-push'])
      expect(existsSync(join(repo.root, `hook-${hook}`))).toBe(false);
  });

  it('re-opens the worktree, refuses stale pushes and an existing branch, and discards cleanly', async () => {
    const ws = await LocalFixWorkspace.open({ repoRoot: repo.root, gitDirectory, fixId, branch });
    await expect(ws.push('origin', baseSha)).rejects.toThrow(/approved commit/);
    await expect(ws.push('origin; rm -rf /', await ws.head())).rejects.toThrow(/remote/);
    await expect(
      LocalFixWorkspace.create({ repoRoot: repo.root, gitDirectory, fixId, branch, baseSha }),
    ).rejects.toThrow(/already exists/);
    await expect(
      LocalFixWorkspace.create({ repoRoot: repo.root, gitDirectory, fixId: 'ffffffffffff', branch: 'main', baseSha }),
    ).rejects.toThrow(/fix branch/);

    await ws.discard({ deleteBranch: true });
    expect(existsSync(ws.directory)).toBe(false);
    expect(repo.git('branch', '--list', branch).trim()).toBe('');
  });

  it('refuses a patch that does not apply', async () => {
    const ws = await LocalFixWorkspace.create({
      repoRoot: repo.root,
      gitDirectory,
      fixId: 'abcdef0123456789',
      branch: 'ai-review/fix-abcdef012345',
      baseSha,
    });
    await expect(ws.applyPatch(PATCH.replace('return 0;', 'return 1;'))).rejects.toThrow(/apply failed/);
    await ws.discard({ deleteBranch: true });
  });

  it('control: the planted hooks do run for plain git commands', () => {
    repo.git('commit', '--allow-empty', '--quiet', '-m', 'control');
    expect(existsSync(join(repo.root, 'hook-pre-commit'))).toBe(true);
  });
});
