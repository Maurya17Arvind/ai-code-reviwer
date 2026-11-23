import { parseHunks, parseUnifiedDiff, unquotePath } from './unified-diff-parser';

const lines = (...l: string[]) => l.join('\n') + '\n';

describe('parseUnifiedDiff', () => {
  it('parses a modified file with line numbers on both sides', () => {
    const [file] = parseUnifiedDiff(
      lines(
        'diff --git a/src/app.ts b/src/app.ts',
        'index 83db48f..bf269f4 100644',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -10,4 +10,5 @@ export class App {',
        '   constructor() {}',
        '-  old() {}',
        '+  renamed() {}',
        '+  added() {}',
        '   other() {}',
        ' }',
      ),
    );
    expect(file).toMatchObject({ path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1, isBinary: false });
    const hunk = file?.hunks[0];
    expect(hunk).toMatchObject({ oldStart: 10, oldLines: 4, newStart: 10, newLines: 5, section: 'export class App {' });
    expect(hunk?.lines).toEqual([
      { kind: 'context', content: '  constructor() {}', oldLine: 10, newLine: 10 },
      { kind: 'del', content: '  old() {}', oldLine: 11 },
      { kind: 'add', content: '  renamed() {}', newLine: 11 },
      { kind: 'add', content: '  added() {}', newLine: 12 },
      { kind: 'context', content: '  other() {}', oldLine: 12, newLine: 13 },
      { kind: 'context', content: '}', oldLine: 13, newLine: 14 },
    ]);
  });

  it('parses added and deleted files', () => {
    const files = parseUnifiedDiff(
      lines(
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        'index 0000000..e69de29',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1,2 @@',
        '+line 1',
        '+line 2',
        'diff --git a/gone.ts b/gone.ts',
        'deleted file mode 100644',
        'index e69de29..0000000',
        '--- a/gone.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-bye',
      ),
    );
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: 'new.ts', status: 'added', additions: 2, newMode: '100644' });
    expect(files[0]?.hunks[0]?.lines[1]).toEqual({ kind: 'add', content: 'line 2', newLine: 2 });
    expect(files[1]).toMatchObject({ path: 'gone.ts', status: 'deleted', deletions: 1 });
    expect(files[1]?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 });
  });

  it('parses renames with and without content changes', () => {
    const files = parseUnifiedDiff(
      lines(
        'diff --git a/old name.ts b/new name.ts',
        'similarity index 100%',
        'rename from old name.ts',
        'rename to new name.ts',
        'diff --git a/a.ts b/b.ts',
        'similarity index 80%',
        'rename from a.ts',
        'rename to b.ts',
        'index 1..2 100644',
        '--- a/a.ts',
        '+++ b/b.ts',
        '@@ -1 +1 @@',
        '-x',
        '+y',
      ),
    );
    expect(files[0]).toMatchObject({ path: 'new name.ts', oldPath: 'old name.ts', status: 'renamed', similarity: 100 });
    expect(files[0]?.hunks).toEqual([]);
    expect(files[1]).toMatchObject({ path: 'b.ts', oldPath: 'a.ts', status: 'renamed', additions: 1, deletions: 1 });
  });

  it('parses copies', () => {
    const [file] = parseUnifiedDiff(
      lines('diff --git a/a.ts b/c.ts', 'similarity index 95%', 'copy from a.ts', 'copy to c.ts'),
    );
    expect(file).toMatchObject({ path: 'c.ts', oldPath: 'a.ts', status: 'copied' });
  });

  it('marks binary files and mode-only changes', () => {
    const files = parseUnifiedDiff(
      lines(
        'diff --git a/logo.png b/logo.png',
        'index 1..2 100644',
        'Binary files a/logo.png and b/logo.png differ',
        'diff --git a/run.sh b/run.sh',
        'old mode 100644',
        'new mode 100755',
      ),
    );
    expect(files[0]).toMatchObject({ path: 'logo.png', isBinary: true, hunks: [] });
    expect(files[1]).toMatchObject({ path: 'run.sh', status: 'modified', oldMode: '100644', newMode: '100755' });
  });

  it('handles "no newline at end of file" and CRLF output', () => {
    const [file] = parseUnifiedDiff(
      'diff --git a/a.txt b/a.txt\r\n--- a/a.txt\r\n+++ b/a.txt\r\n@@ -1 +1 @@\r\n-old\r\n\\ No newline at end of file\r\n+new\r\n\\ No newline at end of file\r\n',
    );
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: 'del', content: 'old', oldLine: 1, noNewlineAtEof: true },
      { kind: 'add', content: 'new', newLine: 1, noNewlineAtEof: true },
    ]);
  });

  it('decodes quoted paths', () => {
    const [file] = parseUnifiedDiff(
      lines(
        'diff --git "a/tab\\there.ts" "b/tab\\there.ts"',
        '--- "a/tab\\there.ts"',
        '+++ "b/tab\\there.ts"',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ),
    );
    expect(file?.path).toBe('tab\there.ts');
  });

  it('handles multiple hunks and empty context lines stripped of their leading space', () => {
    const [file] = parseUnifiedDiff(
      lines(
        'diff --git a/x b/x',
        '--- a/x',
        '+++ b/x',
        '@@ -1,3 +1,3 @@',
        ' a',
        '',
        '-c',
        '+C',
        '@@ -20 +20,2 @@',
        ' z',
        '+zz',
      ),
    );
    expect(file?.hunks).toHaveLength(2);
    expect(file?.hunks[0]?.lines[1]).toEqual({ kind: 'context', content: '', oldLine: 2, newLine: 2 });
    expect(file?.hunks[1]?.lines.at(-1)).toEqual({ kind: 'add', content: 'zz', newLine: 21 });
  });

  it('skips combined diffs and tolerates garbage', () => {
    const files = parseUnifiedDiff(
      lines(
        'warning: something',
        'diff --cc conflicted.ts',
        'index 1,2..3',
        '@@@ -1,1 -1,1 +1,1 @@@',
        'diff --git a/ok.ts b/ok.ts',
        '--- a/ok.ts',
        '+++ b/ok.ts',
        '@@ -1 +1 @@',
        '-1',
        '+2',
      ),
    );
    expect(files.map((f) => f.path)).toEqual(['ok.ts']);
  });

  it('stops at truncated hunks without mis-numbering', () => {
    const [file] = parseUnifiedDiff(lines('diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,5 +1,5 @@', ' a', '+b'));
    expect(file?.hunks[0]?.lines).toHaveLength(2);
  });
});

describe('parseHunks', () => {
  it('parses provider-style hunk-only diffs', () => {
    const hunks = parseHunks('@@ -1,2 +1,2 @@\n a\n-b\n+B\n');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines.map((l) => l.kind)).toEqual(['context', 'del', 'add']);
  });
});

describe('unquotePath', () => {
  it('decodes octal-escaped UTF-8 bytes', () => {
    expect(unquotePath('"caf\\303\\251.ts"')).toBe('café.ts');
  });

  it('returns unquoted input unchanged', () => {
    expect(unquotePath('plain/path.ts')).toBe('plain/path.ts');
  });
});
