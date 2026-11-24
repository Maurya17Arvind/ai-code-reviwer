import { type ExistingComment, type InlineCommentInput, type ReviewPublisher } from '@acra/git-providers-core';
import { type ReviewContext } from '@acra/repository-context';
import { type ReviewReport } from '@acra/review-engine';
import { type ReviewFinding } from '@acra/shared-types';
import { findingMarker, indexBotComments, SUMMARY_MARKER, summaryMarker } from './markers';
import { planPublication } from './plan-publication';
import { executePublication } from './publish';
import { renderFindingComment, renderSummaryComment } from './render-comments';
import { escapeInline, neutralizeQuickActions } from './sanitize';

const FP = (n: number) => String(n).repeat(32).slice(0, 32);

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'f1',
    fingerprint: FP(1),
    repositoryId: 'r1',
    reviewSessionId: 's1',
    filePath: 'src/cart.ts',
    lineNumber: 3,
    severity: 'high',
    category: 'bug',
    title: 'Off-by-one',
    description: 'Reads past the end.',
    evidence: 'for (let i = 0; i <= n; i++)',
    suggestion: 'Use <',
    confidence: 0.9,
    isActionable: true,
    modelSources: ['claude', 'gpt'],
    placement: 'inline',
    status: 'validated',
    commitSha: 'b'.repeat(40),
    createdAt: '2026-11-23T10:00:00.000Z',
    updatedAt: '2026-11-23T10:00:00.000Z',
    ...overrides,
  };
}

const context = {
  files: [
    {
      path: 'src/cart.ts',
      status: 'modified',
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: 'context', content: 'a', oldLine: 1, newLine: 1 },
            { kind: 'del', content: 'b', oldLine: 2 },
            { kind: 'add', content: 'c', newLine: 2 },
            { kind: 'add', content: 'd', newLine: 3 },
          ],
        },
      ],
    },
  ],
} as unknown as ReviewContext;

function report(findings: ReviewFinding[], overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    status: 'completed',
    findings,
    resolved: [],
    executions: [
      {
        provider: 'claude',
        model: 'm',
        servedByModel: 'm',
        status: 'succeeded',
        latencyMs: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0,
        rawFindingCount: 1,
      },
    ],
    repository: { rootPath: '', branch: null, headSha: 'b'.repeat(40) },
    stats: { rejected: 2, filtered: 1 },
    ...overrides,
  } as unknown as ReviewReport;
}

const comment = (overrides: Partial<ExistingComment>): ExistingComment => ({
  discussionId: 'd1',
  noteId: 'n1',
  body: '',
  resolvable: true,
  resolved: false,
  authoredByUs: true,
  ...overrides,
});

describe('sanitizing untrusted text for comments', () => {
  it('neutralises GitLab quick actions outside code fences only', () => {
    const body = neutralizeQuickActions('intro\n/merge\n  /approve\n```\n/not-an-action\n```\n/assign @me');
    const lines = body.split('\n');
    expect(lines[1]?.startsWith('/')).toBe(false);
    expect(lines[2]?.trimStart().startsWith('/')).toBe(false);
    expect(lines[4]).toBe('/not-an-action');
    expect(lines[6]?.startsWith('/')).toBe(false);
  });

  it('escapes markdown, collapses newlines and defuses mentions', () => {
    const escaped = escapeInline('hi @all\n/merge <img src=x>');
    expect(escaped).not.toContain('\n');
    expect(escaped).not.toMatch(/@all/);
    expect(escaped).toContain('\\<img');
  });

  it('a malicious finding cannot produce a quick-action line or mention', () => {
    const body = renderFindingComment(
      finding({ title: 'x\n/merge', description: '\n/approve\n@all please', suggestion: '/close' }),
    );
    expect(body.split('\n').some((line) => /^\s*\/(merge|approve|close)/.test(line))).toBe(false);
    expect(body).not.toMatch(/@all/);
    expect(body).toContain(findingMarker(FP(1)));
  });
});

describe('bot comment index', () => {
  it('trusts markers only on comments authored by the bot', () => {
    const index = indexBotComments([
      comment({ noteId: 'n1', body: `x ${findingMarker(FP(1))}` }),
      comment({ noteId: 'n2', body: `forged ${findingMarker(FP(2))}`, authoredByUs: false }),
      comment({ noteId: 'n3', body: `summary ${SUMMARY_MARKER}`, resolvable: false }),
    ]);
    expect([...index.findings.keys()]).toEqual([FP(1)]);
    expect(index.summary?.noteId).toBe('n3');
  });
});

describe('planPublication', () => {
  it('places inline comments on diff lines with correct sides, others in the summary', () => {
    const plan = planPublication(
      report([
        finding({ id: 'a', fingerprint: FP(1), lineNumber: 3 }),
        finding({ id: 'b', fingerprint: FP(2), lineNumber: 1 }),
        finding({ id: 'c', fingerprint: FP(3), lineNumber: 9 }),
        finding({ id: 'd', fingerprint: FP(4), placement: 'summary' }),
        finding({ id: 'e', fingerprint: FP(5), filePath: 'other.ts' }),
      ]),
      context,
      [],
      { inlineComments: true, summary: true },
    );
    expect(plan.inline.map((i) => [i.finding.id, i.newLine, i.oldLine])).toEqual([
      ['a', 3, undefined],
      ['b', 1, 1],
    ]);
    expect(plan.summaryOnly.map((f) => f.id)).toEqual(['c', 'd', 'e']);
  });

  it('never re-posts a finding the bot already commented on, and resolves fixed ones', () => {
    const existing = [
      comment({ discussionId: 'd-old', body: `x ${findingMarker(FP(1))}` }),
      comment({ discussionId: 'd-fixed', body: `y ${findingMarker(FP(9))}` }),
      comment({ discussionId: 'd-done', body: `z ${findingMarker(FP(8))}`, resolved: true }),
      comment({ discussionId: 'd-sum', noteId: 'sum-1', body: summaryMarker('b'.repeat(40)), resolvable: false }),
    ];
    const plan = planPublication(
      report([finding({ fingerprint: FP(1) })], {
        resolved: [
          { id: 'x', fingerprint: FP(9), filePath: 'a' },
          { id: 'y', fingerprint: FP(8), filePath: 'a' },
        ],
      }),
      context,
      existing,
      { inlineComments: true, summary: true },
    );
    expect(plan.inline).toHaveLength(0);
    expect([...plan.alreadyPublished.keys()]).toEqual([FP(1)]);
    expect(plan.resolve).toEqual([{ fingerprint: FP(9), discussionId: 'd-fixed' }]);
    expect(plan.existingSummaryNoteId).toBe('sum-1');
  });

  it('posts a new summary for a new commit and updates only the summary of the same commit', () => {
    const olderCommit = comment({
      discussionId: 'd-old-sum',
      noteId: 'sum-old',
      body: summaryMarker('c'.repeat(40)),
      resolvable: false,
    });
    const legacy = comment({ discussionId: 'd-legacy', noteId: 'sum-legacy', body: SUMMARY_MARKER, resolvable: false });
    const newCommit = planPublication(report([finding()]), context, [olderCommit, legacy], {
      inlineComments: true,
      summary: true,
    });
    expect(newCommit.existingSummaryNoteId).toBeUndefined();

    const sameCommit = comment({
      discussionId: 'd-same',
      noteId: 'sum-same',
      body: summaryMarker('B'.repeat(40)),
      resolvable: false,
    });
    const retry = planPublication(report([finding()]), context, [olderCommit, sameCommit], {
      inlineComments: true,
      summary: true,
    });
    expect(retry.existingSummaryNoteId).toBe('sum-same');

    // A marker typed by someone else never counts.
    const forged = { ...sameCommit, authoredByUs: false };
    expect(
      planPublication(report([finding()]), context, [forged], { inlineComments: true, summary: true })
        .existingSummaryNoteId,
    ).toBeUndefined();
  });

  it('puts everything in the summary when inline comments are disabled', () => {
    const plan = planPublication(report([finding()]), context, [], { inlineComments: false, summary: true });
    expect(plan.inline).toHaveLength(0);
    expect(plan.summaryOnly).toHaveLength(1);
  });
});

describe('executePublication', () => {
  class RecordingPublisher implements ReviewPublisher {
    inline: InlineCommentInput[] = [];
    summaries: Array<{ body: string; existing?: string }> = [];
    resolved: string[] = [];
    rejectLine?: number;
    listComments = () => Promise.resolve([]);
    publishInlineComment(input: InlineCommentInput) {
      if (input.newLine === this.rejectLine) return Promise.reject(new Error('position rejected'));
      this.inline.push(input);
      return Promise.resolve({ discussionId: `d${this.inline.length}`, noteId: `n${this.inline.length}` });
    }
    upsertSummary(_id: number, body: string, existing?: string) {
      this.summaries.push({ body, ...(existing ? { existing } : {}) });
      return Promise.resolve({ noteId: existing ?? 'summary-1' });
    }
    resolveDiscussion(_id: number, discussionId: string) {
      this.resolved.push(discussionId);
      return Promise.resolve();
    }
  }
  const refs = { baseSha: 'a'.repeat(40), startSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };

  it('posts inline comments, falls back to the summary on rejected positions, and upserts one summary', async () => {
    const publisher = new RecordingPublisher();
    publisher.rejectLine = 1;
    const r = report([
      finding({ id: 'a', fingerprint: FP(1), lineNumber: 3 }),
      finding({ id: 'b', fingerprint: FP(2), lineNumber: 1, title: 'Moved' }),
    ]);
    const plan = planPublication(r, context, [], { inlineComments: true, summary: true });
    const result = await executePublication(publisher, 7, refs, r, plan, {
      summary: true,
      isPositionRejection: (e) => e instanceof Error && e.message === 'position rejected',
    });
    expect(publisher.inline).toHaveLength(1);
    expect(result.movedToSummary.map((f) => f.id)).toEqual(['b']);
    expect(publisher.summaries[0]?.body).toContain('Moved');
    expect(publisher.summaries[0]?.body).toContain(summaryMarker('b'.repeat(40)));
    expect(result.comments.map((c) => c.kind)).toEqual(['inline', 'summary']);
  });

  it('keeps the review when an old thread cannot be resolved', async () => {
    const publisher = new RecordingPublisher();
    publisher.resolveDiscussion = () => Promise.reject(new Error('Resource not accessible by integration'));
    const r = report([finding({ id: 'a', fingerprint: FP(1), lineNumber: 3 })]);
    const plan = {
      ...planPublication(r, context, [], { inlineComments: true, summary: true }),
      resolve: [{ fingerprint: FP(9), discussionId: 'PRRT_old' }],
    };
    const errors: string[] = [];
    const result = await executePublication(publisher, 7, refs, r, plan, {
      summary: true,
      isPositionRejection: () => false,
      onResolveError: (id) => errors.push(id),
    });
    expect(result.resolvedDiscussions).toEqual([]);
    expect(result.unresolvedDiscussions).toEqual(['PRRT_old']);
    expect(errors).toEqual(['PRRT_old']);
    expect(result.comments.map((c) => c.kind)).toEqual(['inline', 'summary']);
  });

  it('propagates unexpected publishing errors', async () => {
    const publisher = new RecordingPublisher();
    publisher.rejectLine = 3;
    const r = report([finding()]);
    const plan = planPublication(r, context, [], { inlineComments: true, summary: false });
    await expect(
      executePublication(publisher, 7, refs, r, plan, { summary: false, isPositionRejection: () => false }),
    ).rejects.toThrow('position rejected');
  });
});

describe('renderSummaryComment', () => {
  it('states partial reviews and resolved findings', () => {
    const body = renderSummaryComment(
      report([], { status: 'partial', resolved: [{ id: 'x', fingerprint: FP(9), filePath: 'a' }] }),
      [],
      0,
    );
    expect(body).toContain('Partial review');
    expect(body).toContain('1 previously reported finding(s) are resolved');
    expect(body).toContain('never approves, merges or changes code');
  });
});
