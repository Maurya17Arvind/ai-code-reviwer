import { type ChangeSet } from './repository-reader';

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
