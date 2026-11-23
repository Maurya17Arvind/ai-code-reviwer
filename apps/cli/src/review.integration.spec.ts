import {
  type AiProviderName,
  type AiReviewer,
  type AiReviewResult,
  AiProviderError,
  type ReviewPrompt,
} from '@acra/ai-providers-core';
import { ReviewReportSchema } from '@acra/review-engine';
import { TempGitRepo } from '@acra/testing';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type ReviewerFactory } from './core/reviewers';
import { runCli } from './testing/run-cli';

/** Fake AI reviewer: records prompts, returns a scripted answer. No network. */
class ScriptedReviewer implements AiReviewer {
  static prompts: ReviewPrompt[] = [];
  readonly model: string;
  constructor(
    readonly provider: AiProviderName,
    private readonly answer: (prompt: ReviewPrompt) => unknown,
  ) {
    this.model = `${provider}-fake`;
  }
  async review(prompt: ReviewPrompt): Promise<AiReviewResult> {
    ScriptedReviewer.prompts.push(prompt);
    const output = this.answer(prompt);
    if (output instanceof Error) throw output;
    return {
      provider: this.provider,
      model: this.model,
      servedByModel: this.model,
      output,
      usage: { inputTokens: 1_000, outputTokens: 100 },
      costUsd: 0.0123,
      latencyMs: 10,
    };
  }
}

const nullDereference = {
  filePath: 'src/user.service.ts',
  lineStart: 3,
  lineEnd: 3,
  severity: 'high',
  category: 'bug',
  title: 'Null dereference when user is missing',
  description: 'findUser returns undefined for unknown ids, so user.name throws.',
  evidence: 'return user.name;',
  suggestion: 'Return null when the user is not found.',
  confidence: 0.9,
};

function factory(answer: (provider: AiProviderName) => unknown): ReviewerFactory {
  return (_env, providers) => ({
    reviewers: [...providers].map((p) => new ScriptedReviewer(p, () => answer(p))),
    skipped: [],
    destinations: [...providers].map((p) => ({ provider: p, model: `${p}-fake`, host: 'fake.invalid' })),
  });
}

const both = factory(() => ({ findings: [nullDereference], summary: 'One real bug.' }));

describe('ai-review review / findings / report / dismiss (real git, fake AI)', () => {
  const repos: TempGitRepo[] = [];
  afterAll(() => repos.forEach((r) => r.dispose()));
  beforeEach(() => {
    ScriptedReviewer.prompts = [];
  });

  function featureRepo(): TempGitRepo {
    const r = TempGitRepo.create();
    repos.push(r);
    r.write(
      'src/user.service.ts',
      'export function name(id: string) {\n  const user = findUser(id);\n  return "unknown";\n}\n',
    );
    r.commit('initial');
    r.git('checkout', '--quiet', '-b', 'feature/users');
    r.write(
      'src/user.service.ts',
      'export function name(id: string) {\n  const user = findUser(id);\n  return user.name;\n}\nconst apiKey = "AKIAABCDEFGHIJKLMNOP";\n',
    );
    return r;
  }

  it('refuses to send code without consent when no terminal is available', async () => {
    const r = featureRepo();
    const result = await runCli(['review'], r.root, { deps: { createReviewers: both } });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(
      /About to send 1 file\(s\)[\s\S]*claude \(claude-fake via fake\.invalid\)[\s\S]*--yes/,
    );
    expect(ScriptedReviewer.prompts).toHaveLength(0);
  });

  it('does nothing when the interactive consent is declined', async () => {
    const r = featureRepo();
    const result = await runCli(['review'], r.root, {
      deps: { createReviewers: both },
      confirm: () => Promise.resolve(false),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Cancelled. Nothing was sent.');
    expect(ScriptedReviewer.prompts).toHaveLength(0);
  });

  it('reviews with consent: merged findings, redacted secrets, stored report, unchanged repository', async () => {
    const r = featureRepo();
    const before = r.git('status', '--porcelain=v1', '--untracked-files=all');
    const result = await runCli(['review', '--yes', '--verbose'], r.root, { deps: { createReviewers: both } });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Review      completed');
    expect(result.stdout).toMatch(/HIGH\s+src\/user\.service\.ts:3\s+Null dereference when user is missing/);
    expect(result.stdout).toContain('claude+gpt');
    expect(result.stdout).toMatch(/CRITICAL\s+src\/user\.service\.ts:5\s+Hard-coded secret/);

    // Both providers received one identical prompt, with the secret redacted.
    expect(ScriptedReviewer.prompts).toHaveLength(2);
    expect(ScriptedReviewer.prompts[0]?.promptHash).toBe(ScriptedReviewer.prompts[1]?.promptHash);
    expect(ScriptedReviewer.prompts[0]?.user).not.toContain('AKIAABCDEFGHIJKLMNOP');

    // Stored inside .git (never in the working tree); working tree unchanged.
    const store = join(r.root, '.git', 'ai-review');
    expect(existsSync(join(store, 'latest.json'))).toBe(true);
    expect(readdirSync(join(store, 'reports'))).toHaveLength(1);
    expect(
      ReviewReportSchema.parse(JSON.parse(readFileSync(join(store, 'latest.json'), 'utf8'))).findings,
    ).toHaveLength(2);
    expect(r.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(before);
  });

  it('gates CI with --fail-on (exit code 3)', async () => {
    const r = featureRepo();
    const result = await runCli(['review', '--yes', '--fail-on', 'critical'], r.root, {
      deps: { createReviewers: both },
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('1 finding(s) at or above critical');
  });

  it('keeps the other provider’s results when one fails, and fails when all fail', async () => {
    const r = featureRepo();
    const partial = factory((p) =>
      p === 'gpt' ? new AiProviderError('gpt', 'rate_limited', 'limit') : { findings: [nullDereference], summary: 's' },
    );
    const result = await runCli(['review', '--yes'], r.root, { deps: { createReviewers: partial } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Review\s+partial/);
    expect(result.stdout).toContain('gpt ✗ rate_limited');

    const none = factory(() => new AiProviderError('claude', 'authentication', 'bad key'));
    const failed = await runCli(['review', '--yes'], r.root, { deps: { createReviewers: none } });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('No AI reviewer completed successfully');
  });

  it('lists findings, renders reports and honours dismissals in later reviews', async () => {
    const r = featureRepo();
    await runCli(['review', '--yes'], r.root, { deps: { createReviewers: both } });

    const listed = JSON.parse(
      (await runCli(['findings', '--format', 'json', '--severity', 'high'], r.root)).stdout,
    ) as {
      findings: Array<{ id: string; title: string; category: string }>;
    };
    expect(listed.findings).toHaveLength(2);
    const bug = listed.findings.find((f) => f.category === 'bug');

    const markdown = await runCli(['report', '--format', 'markdown'], r.root);
    expect(markdown.stdout).toContain('# AI Code Review');
    expect(markdown.stdout).toContain('Null dereference when user is missing');
    expect(markdown.stdout).not.toContain('AKIAABCDEFGHIJKLMNOP');

    const dismissed = await runCli(
      ['dismiss', (bug?.id ?? '').slice(0, 8), '--false-positive', '--reason', 'guarded upstream'],
      r.root,
    );
    expect(dismissed.stdout).toContain('as false positive');

    const again = await runCli(['review', '--yes', '--format', 'json'], r.root, { deps: { createReviewers: both } });
    const report = ReviewReportSchema.parse(JSON.parse(again.stdout));
    expect(report.findings.some((f) => f.category === 'bug')).toBe(false);
    expect(report.filtered).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'false_positive' })]));
  });

  it('marks findings resolved once the code is fixed', async () => {
    const r = featureRepo();
    await runCli(['review', '--yes'], r.root, { deps: { createReviewers: both } });
    r.write(
      'src/user.service.ts',
      'export function name(id: string) {\n  const user = findUser(id);\n  return user?.name ?? null;\n}\n',
    );
    const quiet = factory(() => ({ findings: [], summary: 'Fine.' }));
    const result = await runCli(['review', '--yes', '--format', 'json'], r.root, { deps: { createReviewers: quiet } });
    const report = ReviewReportSchema.parse(JSON.parse(result.stdout));
    expect(report.resolved.length).toBeGreaterThanOrEqual(1);
  });

  it('explains when there is nothing to review or reviews are disabled', async () => {
    const r = TempGitRepo.create();
    repos.push(r);
    r.write('a.ts', 'x\n');
    r.commit('initial');
    expect((await runCli(['review', '--yes'], r.root, { deps: { createReviewers: both } })).stdout).toContain(
      'Nothing to review',
    );
    r.write('ai-review.yaml', 'version: 1\nreview:\n  enabled: false\n');
    r.write('a.ts', 'y\n');
    expect((await runCli(['review', '--yes'], r.root, { deps: { createReviewers: both } })).stdout).toContain(
      'Reviews are disabled',
    );
  });

  it('reports missing history for findings/report', async () => {
    const r = featureRepo();
    const result = await runCli(['findings'], r.root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Run `ai-review review` first');
  });
});
