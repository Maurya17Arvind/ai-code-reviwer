import { type AiProviderName, type AiReviewer, type AiReviewResult, type ReviewPrompt } from '@acra/ai-providers-core';
import { type ReviewerFactory } from '@acra/ai-providers-factory';
import { GitLabClient, GitLabProvider } from '@acra/git-providers-gitlab';
import { FakeGitLab, TempGitRepo } from '@acra/testing';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HostWriterFactory } from './commands/fix.command';
import { runCli } from './testing/run-cli';

const BUGGY = 'export function name(id: string) {\n  const user = findUser(id);\n  return user.name;\n}\n';

const finding = {
  filePath: 'src/user.service.ts',
  lineStart: 3,
  lineEnd: 3,
  severity: 'high',
  category: 'bug',
  title: 'Null dereference when user is missing',
  description: 'findUser returns undefined for unknown ids, so user.name throws.',
  evidence: 'return user.name;',
  suggestion: 'Use optional chaining.',
  confidence: 0.9,
};

/** Fake AI: answers review prompts with one finding and fix prompts with a one-line patch. */
class FakeAi implements AiReviewer {
  static fixPrompts: ReviewPrompt[] = [];
  readonly model: string;
  constructor(readonly provider: AiProviderName) {
    this.model = `${provider}-fake`;
  }
  async review(prompt: ReviewPrompt): Promise<AiReviewResult> {
    let output: unknown;
    if (prompt.output?.name === 'code_fix') {
      FakeAi.fixPrompts.push(prompt);
      output = {
        canFix: true,
        explanation: 'Return a fallback when the user is missing. @all /merge',
        edits: [{ startLine: 3, endLine: 3, replacement: '  return user?.name ?? "unknown";' }],
      };
    } else {
      output = { findings: prompt.user.includes('return user.name;') ? [finding] : [], summary: 'ok' };
    }
    return {
      provider: this.provider,
      model: this.model,
      servedByModel: this.model,
      output,
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0,
      latencyMs: 1,
    };
  }
}

const fakeAi: ReviewerFactory = (_env, providers) => ({
  reviewers: [...providers].map((p) => new FakeAi(p)),
  skipped: [],
  destinations: [...providers].map((p) => ({ provider: p, model: `${p}-fake`, host: 'fake.invalid', local: false })),
});

describe('ai-review fix: propose → approve → apply → stage → commit → push → open (real git, fake AI + GitLab)', () => {
  let repo: TempGitRepo;
  let bare: string;
  let gitlab: FakeGitLab;
  let fixId: string;
  const yes = async () => true;
  const no = async () => false;

  const hostWriter: HostWriterFactory = async ({ provider, projectPath, token }) => {
    expect(provider).toBe('gitlab');
    expect(projectPath).toBe('acme/shop');
    // The fake GitLab "sees" the branches of the bare remote the CLI pushed to.
    for (const line of execFileSync(
      'git',
      ['--git-dir', bare, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')) {
      const [name, sha] = line.split(' ');
      if (name && sha) gitlab.state.branches.set(name, sha);
    }
    const client = new GitLabClient({
      baseUrl: gitlab.baseUrl,
      token,
      policy: { allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true },
    });
    return new GitLabProvider(client, gitlab.state.projectId);
  };
  const run = (
    args: string[],
    options: { confirm?: (q: string) => Promise<boolean>; env?: Record<string, string> } = {},
  ) =>
    runCli(args, repo.root, {
      deps: { createReviewers: fakeAi, hostWriter },
      env: { ...options.env },
      ...(options.confirm ? { confirm: options.confirm } : {}),
    });

  beforeAll(async () => {
    gitlab = await new FakeGitLab().start();
    repo = TempGitRepo.create();
    repo.write(
      'src/user.service.ts',
      'export function name(id: string) {\n  const user = findUser(id);\n  return "unknown";\n}\n',
    );
    repo.write(
      'check.js',
      "const s = require('fs').readFileSync('src/user.service.ts', 'utf8'); process.exit(s.includes('user?.name') ? 0 : 1);\n",
    );
    repo.write('package.json', JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node check.js' } }));
    repo.write('ai-review.yaml', 'version: 1\nfixes:\n  validation:\n    commands:\n      - npm test\n');
    repo.commit('initial');
    bare = realpathSync.native(mkdtempSync(join(tmpdir(), 'acra-bare-')));
    execFileSync('git', ['init', '--quiet', '--bare', bare]);
    repo.git('remote', 'add', 'origin', 'https://gitlab.example/acme/shop.git');
    repo.git('remote', 'set-url', '--push', 'origin', bare);
    repo.git('checkout', '--quiet', '-b', 'feature/users');
    repo.write('src/user.service.ts', BUGGY);
    repo.commit('use user name');
  });

  afterAll(async () => {
    repo.dispose();
    rmSync(bare, { recursive: true, force: true });
    await gitlab.stop();
  });

  it('proposes a fix without changing anything', async () => {
    expect((await run(['review', '--yes', '--base', 'main'])).exitCode).toBe(0);
    const findings = JSON.parse((await run(['findings', '--format', 'json'])).stdout) as {
      findings: Array<{ id: string }>;
    };
    const findingId = findings.findings[0]?.id ?? '';

    const noConsent = await run(['fix', 'propose', findingId.slice(0, 8)]);
    expect(noConsent.exitCode).toBe(2);
    expect(FakeAi.fixPrompts).toHaveLength(0);

    const proposed = await run(['fix', 'propose', findingId.slice(0, 8), '--yes']);
    expect(proposed.exitCode).toBe(0);
    expect(proposed.stdout).toContain('+  return user?.name ?? "unknown";');
    expect(proposed.stdout).toContain('Nothing was changed');
    fixId = /Fix ([0-9a-f]{8})/.exec(proposed.stdout)?.[1] ?? '';
    expect(fixId).toHaveLength(8);
    expect(readFileSync(join(repo.root, 'src/user.service.ts'), 'utf8')).toBe(BUGGY);
  });

  it('never applies without an approval and rejects a wrong approval code', async () => {
    const noTerminal = await run(['fix', 'apply', fixId]);
    expect(noTerminal.exitCode).toBe(4);
    expect(noTerminal.stdout).toMatch(/Apply fix .* on new branch ai-review\/fix-/);
    expect(noTerminal.stdout).toContain('Then run: npm test');
    expect(noTerminal.stderr).toMatch(/--approve [0-9a-f]{12}/);
    expect(repo.git('branch', '--list', 'ai-review/*').trim()).toBe('');

    const wrong = await run(['fix', 'apply', fixId, '--approve', '000000000000']);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toMatch(/does not match/);
    expect(repo.git('branch', '--list', 'ai-review/*').trim()).toBe('');
  });

  it('applies with the shown code in an isolated worktree and runs the approved validation command', async () => {
    const code = /--approve ([0-9a-f]{12})/.exec((await run(['fix', 'apply', fixId])).stderr)?.[1] ?? '';
    const applied = await run(['fix', 'apply', fixId, '--approve', code]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain('✔ passed npm test');
    expect(applied.stdout).toContain('Your checkout was not touched');
    expect(readFileSync(join(repo.root, 'src/user.service.ts'), 'utf8')).toBe(BUGGY);
    expect(repo.git('symbolic-ref', '--short', 'HEAD').trim()).toBe('feature/users');
    // The approval is single-use.
    expect((await run(['fix', 'apply', fixId, '--approve', code])).stderr).toMatch(/is applied/);
  });

  it('asks again for every step; a "no" changes nothing', async () => {
    const declined = await run(['fix', 'stage', fixId], { confirm: no });
    expect(declined.exitCode).toBe(1);
    expect(declined.stderr).toContain('Not approved');
    expect((await run(['fix', 'show', fixId])).stdout).toContain('· applied ·');

    expect((await run(['fix', 'stage', fixId], { confirm: yes })).exitCode).toBe(0);
    const committed = await run(['fix', 'commit', fixId], { confirm: yes });
    expect(committed.exitCode).toBe(0);
    expect(committed.stdout).toContain('Message: fix: Null dereference when user is missing');
    const pushed = await run(['fix', 'push', fixId], { confirm: yes });
    expect(pushed.exitCode).toBe(0);
    expect(pushed.stdout).toMatch(/no force/);
    const branch = /Pushed (ai-review\/fix-[0-9a-f]+)/.exec(pushed.stdout)?.[1] ?? 'missing';
    const remoteHead = execFileSync('git', ['--git-dir', bare, 'rev-parse', `refs/heads/${branch}`], {
      encoding: 'utf8',
    }).trim();
    expect(remoteHead).toMatch(/^[0-9a-f]{40}$/);
  });

  it('opens a merge request with the user token from the environment — never merged', async () => {
    expect((await run(['fix', 'open', fixId], { confirm: yes })).stderr).toMatch(/GITLAB_TOKEN/);
    const opened = await run(['fix', 'open', fixId, '--target', 'main'], {
      confirm: yes,
      env: { GITLAB_TOKEN: gitlab.state.token },
    });
    expect(opened.exitCode).toBe(0);
    expect(opened.stdout).toMatch(/NOT be merged/);
    expect(opened.stdout).toMatch(/Opened https:\/\/gitlab\.example\/acme\/shop\/-\/merge_requests\/\d+/);
    const mr = gitlab.state.createdMergeRequests[0];
    expect(mr).toMatchObject({ target: 'main', title: 'fix: Null dereference when user is missing' });
    expect(mr?.source).toMatch(/^ai-review\/fix-/);
    // Model text in the description cannot trigger quick actions or mentions.
    expect(mr?.description).not.toMatch(/(^|\s)@all\b/);
    expect(mr?.description).toContain('```diff');
    expect(gitlab.state.requests.some((r) => /merge$/.test(r.path))).toBe(false);
  });

  it('keeps an auditable history of every request and decision', async () => {
    const history = await run(['approvals', '--all']);
    for (const op of ['apply_fix', 'stage_changes', 'commit_changes', 'push_branch', 'create_merge_request'])
      expect(history.stdout).toMatch(new RegExp(`executed\\s+${op}`));
    expect(history.stdout).toMatch(/rejected\s+stage_changes/);
    const gitDir = repo.git('rev-parse', '--absolute-git-dir').trim();
    const audit = readFileSync(join(gitDir, 'ai-review', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"action":"approval.executed"');
    expect(readdirSync(join(gitDir, 'ai-review', 'approvals')).length).toBeGreaterThanOrEqual(6);
  });

  it('invalidates approvals when a newer commit is reviewed', async () => {
    const findings = JSON.parse((await run(['findings', '--format', 'json'])).stdout) as {
      findings: Array<{ id: string }>;
    };
    const proposed = await run(['fix', 'propose', (findings.findings[0]?.id ?? '').slice(0, 8), '--yes']);
    const second = /Fix ([0-9a-f]{8})/.exec(proposed.stdout)?.[1] ?? '';
    const pending = await run(['fix', 'apply', second]);
    expect(pending.exitCode).toBe(4);

    repo.write('src/user.service.ts', `${BUGGY}// touched\n`);
    repo.commit('touch');
    expect((await run(['review', '--yes', '--base', 'main'])).exitCode).toBe(0);
    expect((await run(['approvals', '--all'])).stdout).toMatch(/invalidated\s+apply_fix/);
    const stale = await run(['fix', 'apply', second], { confirm: yes });
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toMatch(/newer commit/);
    expect(existsSync(join(repo.root, 'src/user.service.ts'))).toBe(true);
  });
});
