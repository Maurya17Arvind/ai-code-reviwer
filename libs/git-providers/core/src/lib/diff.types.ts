/**
 * Provider-neutral diff model. Produced by the unified-diff parser in @acra/repository-context
 * from local `git diff` output today, and from GitLab/GitHub diffs in Phases 4–5.
 * Line numbers are 1-based. Paths are repository-relative and always use forward slashes.
 */

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Line text without the leading diff marker and without the line terminator. */
  readonly content: string;
  /** Line number in the old file (context and deleted lines). */
  readonly oldLine?: number;
  /** Line number in the new file (context and added lines). */
  readonly newLine?: number;
  /** True when git reported "\ No newline at end of file" for this line. */
  readonly noNewlineAtEof?: boolean;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Optional section heading git prints after the second `@@` (e.g. a function signature). */
  readonly section?: string;
  readonly lines: readonly DiffLine[];
}

export interface ChangedFile {
  /** Path in the new revision (for deletions: the deleted path). */
  readonly path: string;
  /** Previous path for renames/copies. */
  readonly oldPath?: string;
  readonly status: FileChangeStatus;
  readonly isBinary: boolean;
  readonly additions: number;
  readonly deletions: number;
  /** Rename/copy similarity index (0–100) when reported. */
  readonly similarity?: number;
  readonly oldMode?: string;
  readonly newMode?: string;
  readonly hunks: readonly DiffHunk[];
}
