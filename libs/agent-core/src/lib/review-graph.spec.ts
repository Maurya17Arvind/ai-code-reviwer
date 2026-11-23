import {
  AiProviderError,
  type AiProviderName,
  type AiReviewer,
  type AiReviewResult,
  type ReviewPrompt,
} from '@acra/ai-providers-core';
import { type ContextFile, type ReviewContext } from '@acra/repository-context';
import { ReviewReportSchema } from '@acra/review-engine';
import { disableThirdPartyTracing } from './tracing-guard';
import { runReview, type ReviewRunInput } from './review-graph';

const lines = Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`);
lines[4] = 'return user.name;';
lines[5] = 'const key = "AKIAABCDEFGHIJKLMNOP";';

const file: ContextFile = {
  path: 'src/user.service.ts',
  status: 'modified',
  language: 'typescript',
  additions: 2,
  deletions: 0,
  hunks: [
    {
      oldStart: 4,
      oldLines: 1,
      newStart: 4,
      newLines: 3,
      lines: [
        { kind: 'context', content: lines[3] ?? '', oldLine: 4, newLine: 4 },
        { kind: 'add', content: lines[4] ?? '', newLine: 5 },
        { kind: 'add', content: lines[5] ?? '', newLine: 6 },
      ],
    },
  ],
  snippets: [{ side: 'new', startLine: 1, endLine: 20, text: lines.join('\n') }],
  bytes: 500,
  lineCount: 20,
};

const context: ReviewContext = {
  schemaVersion: 1,
  scope: { kind: 'staged' },
  base: { kind: 'commit', sha: 'a'.repeat(40) },
  head: { kind: 'index' },
  files: [file],
  omitted: [],
  stats: {
    changedFiles: 1,
    includedFiles: 1,
    omittedFiles: 0,
    hunks: 1,
    additions: 2,
    deletions: 0,
    contextBytes: 500,
  },
  contextHash: 'c'.repeat(64),
};

const finding = {
  filePath: 'src/user.service.ts',
  lineStart: 5,
  lineEnd: 5,
  severity: 'high',
  category: 'bug',
  title: 'Null dereference of user',
  description: 'user is undefined when the lookup misses.',
  evidence: 'return user.name;',
  suggestion: 'Guard against a missing user.',
  confidence: 0.85,
};

class FakeReviewer implements AiReviewer {
  readonly prompts: ReviewPrompt[] = [];
  constructor(
    readonly provider: AiProviderName,
    private readonly behaviour: (signal: AbortSignal) => Promise<unknown>,
    readonly model = `${provider}-model`,
  ) {}
  async review(prompt: ReviewPrompt, signal: AbortSignal): Promise<AiReviewResult> {
    this.prompts.push(prompt);
    const output = await this.behaviour(signal);
    return {
      provider: this.provider,
      model: this.model,
      servedByModel: this.model,
      output,
      usage: { inputTokens: 100, outputTokens: 20 },
      costUsd: 0.01,
      latencyMs: 5,
    };
  }
}

const ok =
  (findings: unknown[] = [finding]) =>
  () =>
    Promise.resolve({ findings, summary: 'Looks risky.' });

function input(reviewers: AiReviewer[], overrides: Partial<ReviewRunInput> = {}): ReviewRunInput {
  return {
    context,
    reviewers,
    settings: {
      categories: ['bug', 'security', 'performance', 'maintainability'],
      minimumSeverity: 'medium',
      minimumConfidence: 0.8,
      framework: 'angular',
      providerTimeoutMs: 1_000,
    },
    repository: { rootPath: '/repo', branch: 'feature/x', headSha: 'b'.repeat(40), repositoryId: null },
    reviewId: 'review-1',
    now: () => new Date('2026-11-23T10:00:00.000Z'),
    ...overrides,
  };
}

describe('review graph (LangGraph pipeline)', () => {
  it('runs both reviewers in parallel on the identical prompt and merges agreeing findings', async () => {
    const claude = new FakeReviewer('claude', ok());
    const gpt = new FakeReviewer('gpt', ok());
    const report = await runReview(input([claude, gpt]));

    expect(ReviewReportSchema.parse(report)).toBeTruthy();
    expect(claude.prompts[0]?.promptHash).toBe(gpt.prompts[0]?.promptHash);
    expect(report.promptHash).toBe(claude.prompts[0]?.promptHash);
    expect(report.status).toBe('completed');

    const bug = report.findings.find((f) => f.category === 'bug');
    expect(bug).toMatchObject({
      modelSources: ['claude', 'gpt'],
      confidence: 0.9,
      placement: 'inline',
      status: 'validated',
      lineNumber: 5,
    });
    const secret = report.findings.find((f) => f.title.startsWith('Hard-coded secret'));
    expect(secret).toMatchObject({ severity: 'critical', modelSources: ['static'], lineNumber: 6 });

    expect(report.trace.map((t) => t.node)).toEqual(
      expect.arrayContaining([
        'prepare',
        'ai_review:claude',
        'ai_review:gpt',
        'aggregate',
        'validate',
        'deduplicate',
        'finalize',
      ]),
    );
    expect(report.stats.totalCostUsd).toBeCloseTo(0.02, 6);
  });

  it('never sends secrets to providers', async () => {
    const claude = new FakeReviewer('claude', ok([]));
    const report = await runReview(input([claude]));
    expect(claude.prompts[0]?.user).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(claude.prompts[0]?.user).toContain('[REDACTED:aws_access_key]');
    expect(report.secretsRedacted).toBeGreaterThan(0);
  });

  it('keeps the successful provider’s findings when the other fails (partial)', async () => {
    const claude = new FakeReviewer('claude', ok());
    const gpt = new FakeReviewer('gpt', () =>
      Promise.reject(new AiProviderError('gpt', 'rate_limited', 'OpenAI rate limit reached', true)),
    );
    const report = await runReview(input([claude, gpt]));
    expect(report.status).toBe('partial');
    expect(report.executions.find((e) => e.provider === 'gpt')).toMatchObject({
      status: 'failed',
      errorKind: 'rate_limited',
    });
    expect(report.findings.find((f) => f.category === 'bug')?.modelSources).toEqual(['claude']);
  });

  it('treats schema-invalid output as a failed execution and ignores its findings', async () => {
    const claude = new FakeReviewer('claude', () => Promise.resolve({ findings: [{ hacked: true }], summary: 1 }));
    const report = await runReview(input([claude]));
    expect(report.status).toBe('failed');
    expect(report.executions[0]).toMatchObject({ status: 'failed', errorKind: 'invalid_output' });
    expect(report.findings.every((f) => f.modelSources.includes('static'))).toBe(true);
  });

  it('times out slow providers via AbortSignal', async () => {
    const slow = new FakeReviewer(
      'gpt',
      (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new AiProviderError('gpt', 'timeout', 'Review timed out'))),
        ),
    );
    const report = await runReview(input([slow], { settings: { ...input([]).settings, providerTimeoutMs: 50 } }));
    expect(report.executions[0]).toMatchObject({ status: 'failed', errorKind: 'timeout' });
  });

  it('rejects hallucinated findings, records skipped providers and honours dismissals', async () => {
    const hallucinated = { ...finding, filePath: 'src/does-not-exist.ts', title: 'Ghost' };
    const claude = new FakeReviewer('claude', ok([finding, hallucinated]));
    const first = await runReview(
      input([claude], {
        skippedProviders: [{ provider: 'gpt', model: '(unset)', reason: 'OPENAI_REVIEW_MODEL is not set' }],
      }),
    );
    expect(first.rejected).toEqual([expect.objectContaining({ title: 'Ghost', reason: 'unknown_file' })]);
    expect(first.executions.find((e) => e.provider === 'gpt')?.status).toBe('skipped');

    const bug = first.findings.find((f) => f.category === 'bug');
    const second = await runReview(
      input([new FakeReviewer('claude', ok([finding]))], {
        priorFindings: [
          {
            id: bug?.id ?? '',
            fingerprint: bug?.fingerprint ?? '',
            filePath: bug?.filePath ?? '',
            status: 'false_positive',
            createdAt: first.createdAt,
          },
        ],
      }),
    );
    expect(second.findings.some((f) => f.category === 'bug')).toBe(false);
    expect(second.filtered).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'false_positive' })]));
  });

  it('runs static analysis alone when no AI reviewer is available', async () => {
    const report = await runReview(input([]));
    expect(report.status).toBe('failed');
    expect(report.findings.some((f) => f.modelSources.includes('static'))).toBe(true);
  });
});

describe('disableThirdPartyTracing', () => {
  it('turns LangSmith tracing off unless explicitly allowed', () => {
    const env: NodeJS.ProcessEnv = { LANGSMITH_TRACING: 'true' };
    expect(disableThirdPartyTracing(env)).toMatch(/disabled/);
    expect(env['LANGSMITH_TRACING']).toBe('false');
    const allowed: NodeJS.ProcessEnv = { LANGSMITH_TRACING: 'true', ACRA_ALLOW_LANGSMITH_TRACING: 'true' };
    expect(disableThirdPartyTracing(allowed)).toBeNull();
    expect(allowed['LANGSMITH_TRACING']).toBe('true');
  });
});
