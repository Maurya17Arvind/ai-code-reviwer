import { type ChangedFile } from './diff.types';

/**
 * Read-side port implemented by every Git provider (local today; GitLab/GitHub in Phases 4–5).
 *
 * The original single `GitProvider` interface from the product brief is split by capability
 * (interface segregation): a local repository cannot publish review comments, and write
 * operations (branch, push, MR/PR creation) are approval-gated and arrive in Phase 6 as a
 * separate `RepositoryWriter` port. See docs/ARCHITECTURE.md §6.
 */

/** Which changes to review. All diffs are computed by the provider, never by callers. */
export type ChangeScope =
  /** Index vs HEAD. */
  | { readonly kind: 'staged' }
  /** Working tree vs index, optionally including untracked (non-ignored) files. */
  | { readonly kind: 'unstaged'; readonly includeUntracked: boolean }
  /** Commits on the current branch: merge-base(base, HEAD)..HEAD. */
  | { readonly kind: 'committed'; readonly base: string }
  /** Commits on another branch without checking it out: merge-base(base, head)..head. */
  | { readonly kind: 'branch'; readonly base: string; readonly head: string }
  /** Everything not yet in base: merge-base(base, HEAD) vs working tree (+ staged, + untracked). */
  | { readonly kind: 'all'; readonly base: string; readonly includeUntracked: boolean };

/** A concrete revision whose file contents can be read. */
export type Revision =
  { readonly kind: 'commit'; readonly sha: string } | { readonly kind: 'index' } | { readonly kind: 'worktree' };

export interface RepositoryInfo {
  /** Absolute path of the repository root (forward slashes). */
  readonly rootPath: string;
  /** Current branch, or null when HEAD is detached. */
  readonly currentBranch: string | null;
  /** HEAD commit, or null in a repository without commits. */
  readonly headSha: string | null;
  /** Best guess for the integration branch (origin/HEAD, then main/master/develop/trunk). */
  readonly defaultBaseBranch: string | null;
  /** `origin` URL with any embedded credentials masked, or null. */
  readonly remoteUrl: string | null;
}

export interface ChangeSet {
  readonly scope: ChangeScope;
  /** Revision the changes are compared against (old side). */
  readonly base: Revision;
  /** Revision that contains the changes (new side). */
  readonly head: Revision;
  readonly files: readonly ChangedFile[];
}

export interface FileContent {
  readonly path: string;
  readonly revision: Revision;
  readonly sizeBytes: number;
  readonly isBinary: boolean;
  /** Text content; empty for binary files and files over the size limit. */
  readonly content: string;
  /** True when the file exceeded the reader's size limit and `content` was not loaded. */
  readonly tooLarge: boolean;
}

export interface CommitDetails {
  readonly sha: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authoredAt: string;
  readonly subject: string;
  readonly body: string;
}

export interface GetChangeSetOptions {
  /** Unchanged lines around each change in the diff itself (`git diff -U<n>`). Default 3. */
  readonly diffContextLines?: number;
}

/** Narrow read capability used by domain services (e.g. repository context building). */
export interface FileContentReader {
  /** Returns null when the path does not exist in that revision. */
  readFile(path: string, revision: Revision): Promise<FileContent | null>;
}

export interface RepositoryReader extends FileContentReader {
  getRepositoryInfo(): Promise<RepositoryInfo>;
  getChangeSet(scope: ChangeScope, options?: GetChangeSetOptions): Promise<ChangeSet>;
  getCommitDetails(ref: string): Promise<CommitDetails>;
}
