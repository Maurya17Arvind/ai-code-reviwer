import { parseReviewConfig } from '@acra/configuration';
import { TempGitRepo } from '@acra/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from './testing/run-cli';

/** End-to-end CLI behaviour against real temporary Git repositories. */
describe('ai-review CLI (real git)', () => {
  const repos: TempGitRepo[] = [];
  const repo = () => {
    const created = TempGitRepo.create();
    repos.push(created);
    return created;
  };
  afterAll(() => repos.forEach((r) => r.dispose()));

  function angularFeatureRepo(): TempGitRepo {
    const r = repo();
    r.write(
      'package.json',
      JSON.stringify({ dependencies: { '@angular/core': '22.3.0' }, devDependencies: { typescript: '6.0.3' } }),
    );
    r.write('src/app/user.service.ts', Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
    r.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    r.commit('initial');
    r.git('checkout', '--quiet', '-b', 'feature/users');
    r.write(
      'src/app/user.service.ts',
      Array.from({ length: 30 }, (_, i) => (i === 14 ? 'export const changed = true;' : `// line ${i + 1}`)).join(
        '\n',
      ) + '\n',
    );
    r.commit('feature');
    r.write('src/app/new.component.ts', 'export class NewComponent {}\n');
    r.write('pnpm-lock.yaml', 'lockfileVersion: 10\n');
    return r;
  }

  describe('init', () => {
    it('creates a valid ai-review.yaml with detected framework, without staging it', async () => {
      const r = angularFeatureRepo();
      const result = await runCli(['init'], r.root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Created ai-review.yaml (angular, typescript)');

      const config = parseReviewConfig(readFileSync(join(r.root, 'ai-review.yaml'), 'utf8'));
      expect(config.project).toEqual({ framework: 'angular', language: 'typescript' });
      expect(config.review.approval.merge).toBe('disabled');
      expect(r.git('diff', '--cached', '--name-only').trim()).toBe('');
    });

    it('refuses to overwrite without --force', async () => {
      const r = repo();
      r.write('ai-review.yaml', 'version: 1\n');
      const refused = await runCli(['init'], r.root);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('already exists');
      expect(readFileSync(join(r.root, 'ai-review.yaml'), 'utf8')).toBe('version: 1\n');
      expect((await runCli(['init', '--force'], r.root)).exitCode).toBe(0);
    });

    it('fails cleanly outside a repository', async () => {
      const result = await runCli(['init'], join(repo().root, '..'));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/Not a Git repository/);
    });
  });

  describe('status', () => {
    it('reports branch, base, config and change counts', async () => {
      const r = angularFeatureRepo();
      r.write('src/app/user.service.ts', 'staged edit\n');
      r.git('add', 'src/app/user.service.ts');
      const result = await runCli(['status', '--format', 'json'], r.root);
      const status = JSON.parse(result.stdout) as {
        repository: { currentBranch: string; defaultBaseBranch: string };
        config: { status: string };
        changes: { staged: number; unstaged: number; untracked: number };
      };
      expect(status.repository).toMatchObject({ currentBranch: 'feature/users', defaultBaseBranch: 'main' });
      expect(status.config.status).toBe('default');
      expect(status.changes).toEqual({ staged: 1, unstaged: 1, untracked: 1 });
    });

    it('flags an invalid ai-review.yaml', async () => {
      const r = repo();
      r.write('a.ts', '1\n');
      r.commit('initial');
      r.write('ai-review.yaml', 'version: 1\nreview:\n  approval:\n    merge: enabled\n');
      const result = await runCli(['status'], r.root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ai-review.yaml is invalid');
      expect(result.stdout).toContain('merging is never automated');
    });
  });

  describe('changes', () => {
    it('defaults to all changes against the detected base, applying exclusions', async () => {
      const r = angularFeatureRepo();
      const result = await runCli(['changes', '--format', 'json'], r.root);
      expect(result.exitCode).toBe(0);
      const { context } = JSON.parse(result.stdout) as {
        context: {
          scope: { kind: string; base: string };
          files: Array<{ path: string }>;
          omitted: Array<{ path: string; reason: string }>;
          contextHash: string;
        };
      };
      expect(context.scope).toMatchObject({ kind: 'all', base: 'main' });
      expect(context.files.map((f) => f.path)).toEqual(['src/app/new.component.ts', 'src/app/user.service.ts']);
      expect(context.omitted).toEqual([expect.objectContaining({ path: 'pnpm-lock.yaml', reason: 'excluded' })]);
      expect(context.contextHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('supports --base (committed only), --staged, --unstaged and --branch', async () => {
      const r = angularFeatureRepo();
      const paths = async (...args: string[]) => {
        const out = await runCli(['changes', '--format', 'json', ...args], r.root);
        expect(out.exitCode).toBe(0);
        return (JSON.parse(out.stdout) as { context: { files: Array<{ path: string }> } }).context.files.map(
          (f) => f.path,
        );
      };
      expect(await paths('--base', 'main')).toEqual(['src/app/user.service.ts']);
      expect(await paths('--staged')).toEqual([]);
      expect(await paths('--unstaged')).toEqual(['src/app/new.component.ts']);
      expect(await paths('--unstaged', '--no-untracked')).toEqual([]);
      r.git('checkout', '--quiet', '-b', 'other', 'main');
      expect(await paths('--branch', 'feature/users', '--base', 'main')).toEqual(['src/app/user.service.ts']);
    });

    it('honours ai-review.yaml exclusions and context limits', async () => {
      const r = angularFeatureRepo();
      r.write(
        'ai-review.yaml',
        'version: 1\nreview:\n  exclude: ["**/*.component.ts"]\n  context:\n    surroundingLines: 1\n',
      );
      const result = await runCli(['changes', '--format', 'json', '--base', 'main', '--diff-context', '0'], r.root);
      const { context, configSource } = JSON.parse(result.stdout) as {
        configSource: string;
        context: { files: Array<{ snippets: Array<{ startLine: number; endLine: number }> }> };
      };
      expect(configSource).toBe('file');
      expect(context.files[0]?.snippets[0]).toMatchObject({ startLine: 14, endLine: 16 });
    });

    it('prints a readable text summary and works with --repo from another directory', async () => {
      const r = angularFeatureRepo();
      const result = await runCli(['--repo', r.root, 'changes', '--show-context'], join(r.root, '..'));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Included files \(2\)/);
      expect(result.stdout).toMatch(/A {2}src\/app\/new\.component\.ts/);
      expect(result.stdout).toContain('pnpm-lock.yaml  excluded');
      expect(result.stdout).toContain('export const changed = true;');
      expect(result.stdout).toContain('nothing was sent to any AI provider');
    });

    it('reports usage and git errors with exit codes, and never changes the repository', async () => {
      const r = angularFeatureRepo();
      const before = r.git('status', '--porcelain=v1', '--untracked-files=all');

      const conflict = await runCli(['changes', '--staged', '--unstaged'], r.root);
      expect(conflict.exitCode).toBe(2);
      const injection = await runCli(['changes', '--base', '--upload-pack=evil'], r.root);
      expect(injection.exitCode).toBe(1);
      expect(injection.stderr).toMatch(/Invalid git reference/);
      const unknown = await runCli(['changes', '--base', 'nope'], r.root);
      expect(unknown.stderr).toContain('Unknown revision: nope');

      expect(r.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(before);
    });
  });
});
