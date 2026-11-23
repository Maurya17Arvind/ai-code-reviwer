import { type ContextFile, type ReviewContext } from '@acra/repository-context';

/** Per-file lookup structures used by the deterministic validators. */
export interface FileIndex {
  readonly file: ContextFile;
  /** New-side lines that were added. */
  readonly addedLines: ReadonlySet<number>;
  /** New-side lines inside hunks (added + context) — the lines Git providers accept inline comments on. */
  readonly commentableLines: ReadonlySet<number>;
  /** Snippet windows (new side), i.e. the surrounding code the reviewers saw. */
  readonly windows: ReadonlyArray<{ start: number; end: number }>;
  /** Whitespace-normalised text of every line the reviewers saw, for evidence matching. */
  readonly searchableText: string;
}

export function indexContext(context: ReviewContext): Map<string, FileIndex> {
  const index = new Map<string, FileIndex>();
  for (const file of context.files) {
    const addedLines = new Set<number>();
    const commentableLines = new Set<number>();
    const texts: string[] = [];
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        texts.push(line.content);
        if (line.newLine === undefined) continue;
        commentableLines.add(line.newLine);
        if (line.kind === 'add') addedLines.add(line.newLine);
      }
    }
    for (const snippet of file.snippets) texts.push(snippet.text);
    index.set(file.path, {
      file,
      addedLines,
      commentableLines,
      windows: file.snippets.filter((s) => s.side === 'new').map((s) => ({ start: s.startLine, end: s.endLine })),
      searchableText: normalizeCode(texts.join('\n')),
    });
  }
  return index;
}

/** Collapses whitespace and strips diff markers / line-number prefixes models sometimes copy. */
export function normalizeCode(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*[+-]?\s*\d+\s*\|\s?/, '').replace(/^[+-](?=\s)/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
