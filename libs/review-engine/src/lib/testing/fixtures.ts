import { type ContextFile, type ReviewContext } from '@acra/repository-context';
import { type CandidateFinding } from '../candidate';

/** Builds a context file whose lines 1..total exist, with `changed` lines added in one hunk. */
export function contextFile(
  path: string,
  lines: readonly string[],
  changed: readonly number[],
  overrides: Partial<ContextFile> = {},
): ContextFile {
  const first = Math.min(...changed);
  const last = Math.max(...changed);
  const hunkStart = Math.max(1, first - 1);
  const hunkEnd = Math.min(lines.length, last + 1);
  const hunkLines = [];
  for (let n = hunkStart; n <= hunkEnd; n++) {
    hunkLines.push(
      changed.includes(n)
        ? { kind: 'add' as const, content: lines[n - 1] ?? '', newLine: n }
        : { kind: 'context' as const, content: lines[n - 1] ?? '', oldLine: n, newLine: n },
    );
  }
  return {
    path,
    status: 'modified',
    language: path.endsWith('.ts') ? 'typescript' : 'text',
    additions: changed.length,
    deletions: 0,
    hunks: [
      {
        oldStart: hunkStart,
        oldLines: hunkEnd - hunkStart + 1,
        newStart: hunkStart,
        newLines: hunkEnd - hunkStart + 1,
        lines: hunkLines,
      },
    ],
    snippets: [{ side: 'new', startLine: 1, endLine: lines.length, text: lines.join('\n') }],
    bytes: 100,
    lineCount: lines.length,
    ...overrides,
  };
}

export function reviewContext(files: ContextFile[]): ReviewContext {
  return {
    schemaVersion: 1,
    scope: { kind: 'staged' },
    base: { kind: 'commit', sha: 'a'.repeat(40) },
    head: { kind: 'index' },
    files,
    omitted: [],
    stats: {
      changedFiles: files.length,
      includedFiles: files.length,
      omittedFiles: 0,
      hunks: files.length,
      additions: 1,
      deletions: 0,
      contextBytes: 100,
    },
    contextHash: 'c'.repeat(64),
  };
}

export function candidate(overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    source: 'claude',
    filePath: 'src/user.service.ts',
    lineStart: 5,
    lineEnd: 5,
    severity: 'high',
    category: 'bug',
    title: 'Null dereference of user',
    description: 'user can be undefined when the lookup misses, which throws.',
    evidence: 'return user.name;',
    suggestion: 'Return null when the user is not found.',
    confidence: 0.9,
    ...overrides,
  };
}

/** 30-line file where line 5 is `return user.name;` and lines 5–6 changed. */
export function userServiceContext(): ReviewContext {
  const lines = Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`);
  lines[4] = 'return user.name;';
  lines[5] = 'const key = "AKIAABCDEFGHIJKLMNOP";';
  const file = contextFile('src/user.service.ts', lines, [5, 6]);
  return reviewContext([
    { ...file, snippets: [{ side: 'new', startLine: 1, endLine: 12, text: lines.slice(0, 12).join('\n') }] },
  ]);
}
