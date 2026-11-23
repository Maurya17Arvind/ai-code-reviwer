import { type ChangeSet, type FileContentReader } from './repository-reader';

/**
 * Ports for hosted Git providers (GitLab now, GitHub in Phase 5). Split by capability (ADR-019):
 * reading merge/pull requests and publishing review comments. Write operations (branch, push,
 * create MR/PR) are a separate approval-gated port in Phase 6.
 */

export interface ReviewRequestRefs {
  /** Merge-base the provider diffs against. */
  readonly baseSha: string;
  /** Target branch commit when the diff was computed (GitLab `start_sha`). */
  readonly startSha: string;
  /** Source branch head. */
  readonly headSha: string;
}

export interface ReviewRequest {
  /** Provider-visible number (GitLab MR iid, GitHub PR number). */
  readonly id: number;
  readonly title: string;
  readonly description: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly state: 'opened' | 'closed' | 'merged' | 'locked';
  readonly draft: boolean;
  readonly webUrl: string;
  readonly refs: ReviewRequestRefs;
}

/** A comment already present on the review request (any author). */
export interface ExistingComment {
  readonly discussionId: string;
  readonly noteId: string;
  readonly body: string;
  readonly resolvable: boolean;
  readonly resolved: boolean;
  /** True when the note was written with the configured bot credentials. */
  readonly authoredByUs: boolean;
}

export interface InlineCommentInput {
  readonly requestId: number;
  readonly body: string;
  readonly refs: ReviewRequestRefs;
  readonly path: string;
  readonly oldPath: string;
  /** New-side line (added or unchanged). */
  readonly newLine: number;
  /** Old-side line, required by GitLab for unchanged (context) lines. */
  readonly oldLine?: number;
}

export interface ReviewRequestSource {
  getReviewRequest(id: number): Promise<ReviewRequest>;
  /** Changed files of the review request, diffed between refs.baseSha and refs.headSha. */
  getReviewRequestChanges(request: ReviewRequest): Promise<ChangeSet>;
}

export interface ReviewPublisher {
  listComments(requestId: number): Promise<ExistingComment[]>;
  publishInlineComment(input: InlineCommentInput): Promise<{ discussionId: string; noteId: string }>;
  /** Creates the summary note, or updates it in place when `existingNoteId` is given. */
  upsertSummary(requestId: number, body: string, existingNoteId?: string): Promise<{ noteId: string }>;
  resolveDiscussion(requestId: number, discussionId: string): Promise<void>;
}

/**
 * Approval-gated write operations on a hosted repository (Phase 6). Implementations perform exactly
 * one change each and never force, delete existing branches, approve or merge. Callers must have
 * verified the human approval for the exact values passed.
 */
export interface RepositoryWriter {
  /**
   * Creates `branch` at `baseSha` with one commit that replaces `path` with `content`.
   * Fails if the branch already exists. Returns the new commit id.
   */
  commitFileToNewBranch(input: {
    readonly branch: string;
    readonly baseSha: string;
    readonly path: string;
    readonly content: string;
    readonly message: string;
  }): Promise<{ commitSha: string }>;
  /** Opens a merge/pull request. It is never merged by the platform. */
  createReviewRequest(input: {
    readonly sourceBranch: string;
    readonly targetBranch: string;
    readonly title: string;
    readonly description: string;
  }): Promise<{ id: number; webUrl: string }>;
  /** Current commit of a branch, or null when it does not exist. */
  branchHead(branch: string): Promise<string | null>;
}

/** Everything the review worker needs from a hosted provider for one repository. */
export type HostedGitProvider = ReviewRequestSource & ReviewPublisher & FileContentReader;
