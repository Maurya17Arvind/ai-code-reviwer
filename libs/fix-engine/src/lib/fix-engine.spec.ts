import { type AiReviewer, type AiReviewResult, AiProviderError, type ReviewPrompt } from '@acra/ai-providers-core';
import { sha256Hex } from '@acra/repository-context';
import { type FixTarget } from './fix-prompt';
import { applyProposal, generateFix } from './generate-fix';
import { isProtectedPath } from './protected-paths';
import { applyChanges, joinLines, splitLines, toChanges } from './text-lines';
import { createUnifiedDiff } from './unified-diff';

const FILE = [
  'export function total(items: Item[]) {',
  '  let sum = 0;',
  '  for (let i = 0; i <= items.length; i++) sum += items[i].price;',
  '  return sum;',
  '}',
  '',
].join('\n');

const target: FixTarget = {
  id: 'f-1',
  fingerprint: 'fp1',
  filePath: 'src/cart.ts',
  lineNumber: 3,
  endLineNumber: 3,
  severity: 'high',
  category: 'bug',
  title: 'Off-by-one',
  description: 'Loop reads past the end.',
  evidence: 'i <= items.length',
};

class ScriptedReviewer implements AiReviewer {
  readonly provider = 'claude' as const;
  readonly model = 'fake';
  prompts: ReviewPrompt[] = [];
  constructor(private readonly output: unknown | (() => never)) {}
  async review(prompt: ReviewPrompt): Promise<AiReviewResult> {
    this.prompts.push(prompt);
    if (typeof this.output === 'function') (this.output as () => never)();
    return {
      provider: 'claude',
      model: 'fake',
      servedByModel: 'fake',
      output: this.output,
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0,
      latencyMs: 1,
    };
  }
}

const fix = (output: unknown, overrides: Partial<{ content: string; target: FixTarget }> = {}) =>
  generateFix({
    reviewer: new ScriptedReviewer(output),
    target: overrides.target ?? target,
    content: overrides.content ?? FILE,
    baseSha: 'a'.repeat(40),
    signal: new AbortController().signal,
    now: () => new Date('2026-11-23T10:00:00Z'),
  });

const goodOutput = {
  canFix: true,
  explanation: 'Use < so the loop stops at the last element.',
  edits: [{ startLine: 3, endLine: 3, replacement: '  for (let i = 0; i < items.length; i++) sum += items[i].price;' }],
};

describe('generateFix', () => {
  it('turns line edits into a minimal, hashed unified diff', async () => {
    const result = await fix(goodOutput);
    if (result.status !== 'proposed') throw new Error(result.reason);
    const { proposal } = result;
    expect(proposal.patch).toBe(
      [
        'diff --git a/src/cart.ts b/src/cart.ts',
        '--- a/src/cart.ts',
        '+++ b/src/cart.ts',
        '@@ -1,5 +1,5 @@',
        ' export function total(items: Item[]) {',
        '   let sum = 0;',
        '-  for (let i = 0; i <= items.length; i++) sum += items[i].price;',
        '+  for (let i = 0; i < items.length; i++) sum += items[i].price;',
        '   return sum;',
        ' }',
        '',
      ].join('\n'),
    );
    expect(proposal).toMatchObject({ additions: 1, deletions: 1, filePath: 'src/cart.ts', baseSha: 'a'.repeat(40) });
    expect(proposal.patchSha256).toBe(sha256Hex(proposal.patch));
    expect(proposal.originalSha256).toBe(sha256Hex(FILE));
    expect(applyProposal(proposal, FILE)).toContain('i < items.length');
  });

  it('sends the fix schema and keeps the finding inside the untrusted block', async () => {
    const reviewer = new ScriptedReviewer(goodOutput);
    await generateFix({
      reviewer,
      target,
      content: FILE,
      baseSha: 'a'.repeat(40),
      signal: new AbortController().signal,
    });
    const prompt = reviewer.prompts[0];
    expect(prompt?.output?.name).toBe('code_fix');
    const user = prompt?.user ?? '';
    expect(user.indexOf('Off-by-one')).toBeGreaterThan(user.indexOf('<<<UNTRUSTED_'));
    expect(user).toContain('3 |   for (let i = 0; i <= items.length; i++)');
  });

  it('refuses protected files before calling the model', async () => {
    const reviewer = new ScriptedReviewer(goodOutput);
    const result = await generateFix({
      reviewer,
      target: { ...target, filePath: '.github/workflows/ci.yml' },
      content: FILE,
      baseSha: 'a'.repeat(40),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: 'rejected', code: 'protected_path' });
    expect(reviewer.prompts).toHaveLength(0);
    for (const path of ['package.json', 'apps/x/package.json', '.husky/pre-commit', 'ai-review.yaml', '.env.local'])
      expect(isProtectedPath(path)).toBe(true);
    expect(isProtectedPath('src/package-utils.ts')).toBe(false);
  });

  it.each([
    [{ ...goodOutput, canFix: false, edits: [] }, 'model_declined'],
    [{ canFix: true, explanation: 'x', edits: [{ startLine: 3, endLine: 3 }] }, 'invalid_output'],
    [{ ...goodOutput, edits: [{ startLine: 4, endLine: 3, replacement: 'x' }] }, 'invalid_edits'],
    [{ ...goodOutput, edits: [{ startLine: 1, endLine: 9, replacement: 'x' }] }, 'invalid_edits'],
    [
      {
        ...goodOutput,
        edits: [
          { startLine: 2, endLine: 3, replacement: 'a' },
          { startLine: 3, endLine: 4, replacement: 'b' },
        ],
      },
      'invalid_edits',
    ],
    [{ ...goodOutput, edits: [{ startLine: 3, endLine: 3, replacement: '3 |   oops' }] }, 'invalid_edits'],
    [{ ...goodOutput, edits: [{ startLine: 2, endLine: 2, replacement: '  let sum = 0;' }] }, 'no_change'],
  ])('rejects unusable model output (%#)', async (output, code) => {
    expect(await fix(output)).toMatchObject({ status: 'rejected', code });
  });

  it('never lets a model touch or reintroduce redacted secrets', async () => {
    const content = `const key = "AKIAIOSFODNN7EXAMPLE";\nconst a = 1;\n`;
    const reviewer = new ScriptedReviewer({
      canFix: true,
      explanation: 'x',
      edits: [{ startLine: 1, endLine: 1, replacement: 'const key = process.env.KEY;' }],
    });
    const result = await generateFix({
      reviewer,
      target: { ...target, lineNumber: 1 },
      content,
      baseSha: 'a'.repeat(40),
      signal: new AbortController().signal,
    });
    expect(reviewer.prompts[0]?.user).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).toMatchObject({ status: 'rejected', code: 'invalid_edits' });
  });

  it('reports provider failures as rejections', async () => {
    const result = await fix(() => {
      throw new AiProviderError('claude', 'quota_exceeded', 'no credit');
    });
    expect(result).toMatchObject({ status: 'rejected', code: 'provider_error', reason: 'quota_exceeded: no credit' });
  });

  it('refuses to apply when the file or the stored patch changed', async () => {
    const result = await fix(goodOutput);
    if (result.status !== 'proposed') throw new Error(result.reason);
    expect(() => applyProposal(result.proposal, `${FILE}// edited\n`)).toThrow(/changed since/);
    expect(() => applyProposal({ ...result.proposal, patch: `${result.proposal.patch} ` }, FILE)).toThrow(/hash/);
  });
});

describe('unified diff edge cases', () => {
  const diff = (content: string, edits: Array<{ startLine: number; endLine: number; added: string[] }>) => {
    const text = splitLines(content);
    const changes = toChanges(text.lines, edits);
    return { patch: createUnifiedDiff('f.txt', text, changes), result: joinLines(applyChanges(text, changes)) };
  };

  it('marks a missing final newline', () => {
    const { patch, result } = diff('a\nb', [{ startLine: 2, endLine: 2, added: ['c'] }]);
    expect(result).toBe('a\nc');
    expect(patch).toContain('-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n');
  });

  it('keeps CRLF line endings', () => {
    const { patch, result } = diff('a\r\nb\r\n', [{ startLine: 1, endLine: 1, added: ['x'] }]);
    expect(result).toBe('x\r\nb\r\n');
    expect(patch).toContain('-a\r\n+x\r\n b\r\n');
  });

  it('merges nearby changes into one hunk and splits distant ones', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const near = diff(lines, [
      { startLine: 5, endLine: 5, added: ['five'] },
      { startLine: 9, endLine: 9, added: ['nine'] },
    ]);
    expect(near.patch.match(/^@@/gm)).toHaveLength(1);
    const far = diff(lines, [
      { startLine: 5, endLine: 5, added: ['five', 'five-b'] },
      { startLine: 30, endLine: 31, added: [] },
    ]);
    expect(far.patch).toContain('@@ -2,7 +2,8 @@');
    expect(far.patch).toContain('@@ -27,8 +28,6 @@');
  });
});
