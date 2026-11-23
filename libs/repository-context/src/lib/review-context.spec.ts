import {
  type ChangedFile,
  type ChangeSet,
  type FileContent,
  type FileContentReader,
  type Revision,
} from '@acra/git-providers-core';
import { buildReviewContext, computeWindows, type ContextBudget } from './review-context';

const budget: ContextBudget = { maxFiles: 10, maxFileBytes: 10_000, surroundingLines: 2, maxTotalBytes: 100_000 };
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function modified(path: string, newStart: number, newLines = 1): ChangedFile {
  return {
    path,
    status: 'modified',
    isBinary: false,
    additions: 1,
    deletions: 1,
    hunks: [
      {
        oldStart: newStart,
        oldLines: newLines,
        newStart,
        newLines,
        lines: [
          { kind: 'del', content: 'old', oldLine: newStart },
          { kind: 'add', content: 'new', newLine: newStart },
        ],
      },
    ],
  };
}

class FakeReader implements FileContentReader {
  readonly reads: Array<{ path: string; revision: Revision }> = [];
  constructor(private readonly files: Record<string, Partial<FileContent> & { content: string }>) {}
  async readFile(path: string, revision: Revision): Promise<FileContent | null> {
    this.reads.push({ path, revision });
    const file = this.files[path];
    if (!file) return null;
    return {
      path,
      revision,
      sizeBytes: Buffer.byteLength(file.content),
      isBinary: false,
      tooLarge: false,
      ...file,
    };
  }
}

const changeSet = (files: ChangedFile[]): ChangeSet => ({
  scope: { kind: 'staged' },
  base: { kind: 'commit', sha: 'a'.repeat(40) },
  head: { kind: 'index' },
  files,
});

describe('computeWindows', () => {
  it('adds surrounding lines, clips to file bounds and merges overlaps', () => {
    const hunk = (newStart: number, newLines: number) => ({
      oldStart: newStart,
      oldLines: newLines,
      newStart,
      newLines,
      lines: [],
    });
    expect(computeWindows([hunk(1, 1), hunk(5, 2), hunk(30, 1)], 'new', 2, 31)).toEqual([
      { start: 1, end: 8 },
      { start: 28, end: 31 },
    ]);
    expect(computeWindows([hunk(1, 1)], 'new', 2, 0)).toEqual([]);
  });

  it('uses the hunk position for pure deletions (0 new lines)', () => {
    expect(computeWindows([{ oldStart: 10, oldLines: 2, newStart: 9, newLines: 0, lines: [] }], 'new', 1, 20)).toEqual([
      { start: 8, end: 10 },
    ]);
  });
});

describe('buildReviewContext', () => {
  it('includes surrounding source from the head revision', async () => {
    const reader = new FakeReader({ 'src/a.ts': { content: numbered(20) } });
    const context = await buildReviewContext(changeSet([modified('src/a.ts', 10)]), reader, { exclude: [], budget });

    expect(reader.reads).toEqual([{ path: 'src/a.ts', revision: { kind: 'index' } }]);
    expect(context.files[0]).toMatchObject({ path: 'src/a.ts', language: 'typescript' });
    expect(context.files[0]?.snippets).toEqual([
      { side: 'new', startLine: 8, endLine: 12, text: 'line 8\nline 9\nline 10\nline 11\nline 12' },
    ]);
    expect(context.stats).toMatchObject({ changedFiles: 1, includedFiles: 1, hunks: 1 });
  });

  it('reads deleted files from the base revision', async () => {
    const reader = new FakeReader({ 'gone.ts': { content: numbered(3) } });
    const deleted: ChangedFile = {
      path: 'gone.ts',
      status: 'deleted',
      isBinary: false,
      additions: 0,
      deletions: 3,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 0, newLines: 0, lines: [] }],
    };
    const context = await buildReviewContext(changeSet([deleted]), reader, { exclude: [], budget });
    expect(reader.reads[0]?.revision).toEqual({ kind: 'commit', sha: 'a'.repeat(40) });
    expect(context.files[0]?.snippets[0]).toMatchObject({ side: 'old', startLine: 1, endLine: 3 });
  });

  it('records omissions with reasons instead of silently dropping files', async () => {
    const reader = new FakeReader({
      'src/big.ts': { content: 'x', sizeBytes: 50_000, tooLarge: true },
      'src/ok.ts': { content: numbered(5) },
    });
    const files: ChangedFile[] = [
      modified('pnpm-lock.yaml', 1),
      { ...modified('logo.png', 1), isBinary: true, hunks: [] },
      modified('src/big.ts', 1),
      modified('src/missing.ts', 1),
      modified('src/ok.ts', 1),
    ];
    const context = await buildReviewContext(changeSet(files), reader, { exclude: ['**/pnpm-lock.yaml'], budget });

    expect(context.files.map((f) => f.path)).toEqual(['src/ok.ts']);
    expect(context.omitted.map((o) => [o.path, o.reason])).toEqual([
      ['logo.png', 'binary'],
      ['pnpm-lock.yaml', 'excluded'],
      ['src/big.ts', 'too_large'],
      ['src/missing.ts', 'unreadable'],
    ]);
    expect(context.omitted[1]?.detail).toBe('**/pnpm-lock.yaml');
  });

  it('enforces file count and total size budgets deterministically', async () => {
    const reader = new FakeReader({
      'a.ts': { content: numbered(5) },
      'b.ts': { content: numbered(5) },
      'c.ts': { content: numbered(5) },
    });
    const byCount = await buildReviewContext(
      changeSet([modified('c.ts', 1), modified('a.ts', 1), modified('b.ts', 1)]),
      reader,
      {
        exclude: [],
        budget: { ...budget, maxFiles: 2 },
      },
    );
    expect(byCount.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(byCount.omitted).toEqual([{ path: 'c.ts', status: 'modified', reason: 'max_files', detail: 'limit 2' }]);

    const bySize = await buildReviewContext(changeSet([modified('a.ts', 1), modified('b.ts', 1)]), reader, {
      exclude: [],
      budget: { ...budget, maxTotalBytes: 40 },
    });
    expect(bySize.files).toHaveLength(1);
    expect(bySize.omitted[0]?.reason).toBe('budget_exceeded');
  });

  it('includes renames without content changes without reading files', async () => {
    const reader = new FakeReader({});
    const renamed: ChangedFile = {
      path: 'new.ts',
      oldPath: 'old.ts',
      status: 'renamed',
      isBinary: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    };
    const context = await buildReviewContext(changeSet([renamed]), reader, { exclude: [], budget });
    expect(context.files[0]).toMatchObject({ path: 'new.ts', oldPath: 'old.ts', snippets: [] });
    expect(reader.reads).toHaveLength(0);
  });

  it('produces a stable hash that changes when content changes', async () => {
    const build = (content: string) =>
      buildReviewContext(changeSet([modified('a.ts', 2)]), new FakeReader({ 'a.ts': { content } }), {
        exclude: [],
        budget,
      });
    const first = await build(numbered(5));
    const second = await build(numbered(5));
    const changed = await build(numbered(6).replace('line 3', 'LINE 3'));
    expect(first.contextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.contextHash).toBe(first.contextHash);
    expect(changed.contextHash).not.toBe(first.contextHash);
  });
});
