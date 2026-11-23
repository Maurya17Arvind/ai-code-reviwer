import {
  type ChangedFile,
  type ChangeScope,
  type ChangeSet,
  type DiffHunk,
  type FileChangeStatus,
  type FileContentReader,
  type Revision,
} from '@acra/git-providers-core';
import { detectLanguage } from './language';
import { createPathFilter } from './path-filter';
import { sha256Hex, stableStringify } from './stable-hash';

export interface ContextBudget {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly surroundingLines: number;
  readonly maxTotalBytes: number;
}

export interface BuildReviewContextOptions {
  /** Built-in plus repository exclusion globs. */
  readonly exclude: readonly string[];
  readonly budget: ContextBudget;
}

export type OmissionReason = 'excluded' | 'binary' | 'too_large' | 'max_files' | 'budget_exceeded' | 'unreadable';

export interface ContextSnippet {
  /** `new` = lines of the changed revision; `old` = lines of the base revision (deleted files). */
  readonly side: 'new' | 'old';
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface ContextFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: FileChangeStatus;
  readonly language: string;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
  /** Surrounding source around each hunk (merged windows). */
  readonly snippets: readonly ContextSnippet[];
  readonly bytes: number;
  /** Number of lines in the version the snippets were read from (`new` side, or `old` for deletions); null if not read. */
  readonly lineCount: number | null;
}

export interface OmittedFile {
  readonly path: string;
  readonly status: FileChangeStatus;
  readonly reason: OmissionReason;
  readonly detail?: string;
}

export interface ReviewContext {
  readonly schemaVersion: 1;
  readonly scope: ChangeScope;
  readonly base: Revision;
  readonly head: Revision;
  readonly files: readonly ContextFile[];
  readonly omitted: readonly OmittedFile[];
  readonly stats: {
    readonly changedFiles: number;
    readonly includedFiles: number;
    readonly omittedFiles: number;
    readonly hunks: number;
    readonly additions: number;
    readonly deletions: number;
    readonly contextBytes: number;
  };
  /**
   * SHA-256 over the canonical serialisation of base, head and included files. Every AI reviewer
   * in a session must receive context with the same hash (byte-identical input).
   */
  readonly contextHash: string;
}

/**
 * Builds the bounded, deterministic review context for a change set. Domain logic only: file
 * access goes through the FileContentReader port. Files are processed in path order, so the
 * same repository state always produces the same context and hash.
 */
export async function buildReviewContext(
  changeSet: ChangeSet,
  reader: FileContentReader,
  options: BuildReviewContextOptions,
): Promise<ReviewContext> {
  const filter = createPathFilter(options.exclude);
  const { budget } = options;
  const files: ContextFile[] = [];
  const omitted: OmittedFile[] = [];
  let totalBytes = 0;

  const sorted = [...changeSet.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const file of sorted) {
    const omit = (reason: OmissionReason, detail?: string) =>
      omitted.push({ path: file.path, status: file.status, reason, ...(detail ? { detail } : {}) });

    const filtered = filter.check(file.path);
    if (filtered.excluded) {
      omit('excluded', filtered.pattern);
      continue;
    }
    if (file.isBinary) {
      omit('binary');
      continue;
    }
    if (file.diffUnavailable) {
      omit('too_large', 'diff not provided by the Git provider');
      continue;
    }
    if (files.length >= budget.maxFiles) {
      omit('max_files', `limit ${budget.maxFiles}`);
      continue;
    }

    const built = await buildContextFile(file, changeSet, reader, budget);
    if ('reason' in built) {
      omit(built.reason, built.detail);
      continue;
    }
    if (totalBytes + built.bytes > budget.maxTotalBytes) {
      omit('budget_exceeded', `${built.bytes} bytes would exceed ${budget.maxTotalBytes}`);
      continue;
    }
    totalBytes += built.bytes;
    files.push(built);
  }

  const contextHash = sha256Hex(
    stableStringify({ schemaVersion: 1, base: changeSet.base, head: changeSet.head, files }),
  );

  return {
    schemaVersion: 1,
    scope: changeSet.scope,
    base: changeSet.base,
    head: changeSet.head,
    files,
    omitted,
    stats: {
      changedFiles: changeSet.files.length,
      includedFiles: files.length,
      omittedFiles: omitted.length,
      hunks: files.reduce((sum, f) => sum + f.hunks.length, 0),
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      contextBytes: totalBytes,
    },
    contextHash,
  };
}

async function buildContextFile(
  file: ChangedFile,
  changeSet: ChangeSet,
  reader: FileContentReader,
  budget: ContextBudget,
): Promise<ContextFile | { reason: OmissionReason; detail?: string }> {
  const side: 'new' | 'old' = file.status === 'deleted' ? 'old' : 'new';
  let snippets: ContextSnippet[] = [];
  let lineCount: number | null = null;

  if (file.hunks.length > 0) {
    const revision = side === 'old' ? changeSet.base : changeSet.head;
    const content = await reader.readFile(file.path, revision);
    if (content === null) return { reason: 'unreadable', detail: 'not found in revision' };
    if (content.isBinary) return { reason: 'binary' };
    if (content.tooLarge || content.sizeBytes > budget.maxFileBytes) {
      return { reason: 'too_large', detail: `${content.sizeBytes} bytes > ${budget.maxFileBytes}` };
    }
    const lines = splitLines(content.content);
    lineCount = lines.length;
    snippets = extractSnippets(lines, file.hunks, side, budget.surroundingLines);
  }

  const hunkBytes = file.hunks.reduce(
    (sum, hunk) => sum + hunk.lines.reduce((s, line) => s + Buffer.byteLength(line.content, 'utf8') + 2, 0),
    0,
  );
  const snippetBytes = snippets.reduce((sum, snippet) => sum + Buffer.byteLength(snippet.text, 'utf8'), 0);

  return {
    path: file.path,
    ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
    status: file.status,
    language: detectLanguage(file.path),
    additions: file.additions,
    deletions: file.deletions,
    hunks: file.hunks,
    snippets,
    lineCount,
    bytes: hunkBytes + snippetBytes,
  };
}

/** Merged line windows (1-based, inclusive) around every hunk on the given side. */
export function computeWindows(
  hunks: readonly DiffHunk[],
  side: 'new' | 'old',
  surroundingLines: number,
  totalLines: number,
): Array<{ start: number; end: number }> {
  if (totalLines === 0) return [];
  const raw = hunks
    .map((hunk) => {
      const start = side === 'new' ? hunk.newStart : hunk.oldStart;
      const count = side === 'new' ? hunk.newLines : hunk.oldLines;
      const first = Math.max(1, start);
      const last = count === 0 ? first : start + count - 1;
      return {
        start: Math.max(1, first - surroundingLines),
        end: Math.min(totalLines, last + surroundingLines),
      };
    })
    .filter((window) => window.start <= window.end)
    .sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const window of raw) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end + 1) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }
  return merged;
}

function extractSnippets(
  lines: readonly string[],
  hunks: readonly DiffHunk[],
  side: 'new' | 'old',
  surroundingLines: number,
): ContextSnippet[] {
  return computeWindows(hunks, side, surroundingLines, lines.length).map(({ start, end }) => ({
    side,
    startLine: start,
    endLine: end,
    text: lines.slice(start - 1, end).join('\n'),
  }));
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
