import { type ReviewPublisher, type ReviewRequestRefs } from '@acra/git-providers-core';
import { type ReviewReport } from '@acra/review-engine';
import { type ReviewFinding } from '@acra/shared-types';
import { type PublicationPlan } from './plan-publication';
import { renderFindingComment, renderSummaryComment } from './render-comments';

export interface PublishedComment {
  readonly kind: 'inline' | 'summary';
  readonly fingerprint?: string;
  readonly findingId?: string;
  readonly discussionId?: string;
  readonly noteId: string;
}

export interface PublicationResult {
  readonly comments: PublishedComment[];
  /** Inline positions the provider rejected; those findings were moved to the summary. */
  readonly movedToSummary: ReviewFinding[];
  readonly resolvedDiscussions: string[];
  /** Threads that should have been resolved but the provider refused (logged, not fatal). */
  readonly unresolvedDiscussions: string[];
  readonly summaryNoteId?: string;
}

/**
 * Executes a publication plan. Inline comments the provider rejects (e.g. the diff changed under
 * us) fall back to the summary instead of being dropped or re-positioned.
 */
export async function executePublication(
  publisher: ReviewPublisher,
  requestId: number,
  refs: ReviewRequestRefs,
  report: ReviewReport,
  plan: PublicationPlan,
  options: {
    readonly summary: boolean;
    readonly isPositionRejection: (error: unknown) => boolean;
    /** Called when an old thread could not be resolved; publishing continues. */
    readonly onResolveError?: (discussionId: string, error: unknown) => void;
  },
): Promise<PublicationResult> {
  const comments: PublishedComment[] = [];
  const movedToSummary: ReviewFinding[] = [];

  for (const item of plan.inline) {
    try {
      const posted = await publisher.publishInlineComment({
        requestId,
        refs,
        body: renderFindingComment(item.finding),
        path: item.path,
        oldPath: item.oldPath,
        newLine: item.newLine,
        ...(item.oldLine !== undefined ? { oldLine: item.oldLine } : {}),
      });
      comments.push({ kind: 'inline', fingerprint: item.finding.fingerprint, findingId: item.finding.id, ...posted });
    } catch (error) {
      if (!options.isPositionRejection(error)) throw error;
      movedToSummary.push(item.finding);
    }
  }

  // Resolving old threads is cosmetic (finding status is tracked in the database), so a failure here
  // must never discard the review that was just published.
  const resolvedDiscussions: string[] = [];
  const unresolvedDiscussions: string[] = [];
  for (const { discussionId } of plan.resolve) {
    try {
      await publisher.resolveDiscussion(requestId, discussionId);
      resolvedDiscussions.push(discussionId);
    } catch (error) {
      unresolvedDiscussions.push(discussionId);
      options.onResolveError?.(discussionId, error);
    }
  }

  let summaryNoteId: string | undefined;
  if (options.summary) {
    const inlineCount = comments.length + plan.alreadyPublished.size;
    const body = renderSummaryComment(report, [...plan.summaryOnly, ...movedToSummary], inlineCount);
    summaryNoteId = (await publisher.upsertSummary(requestId, body, plan.existingSummaryNoteId)).noteId;
    comments.push({ kind: 'summary', noteId: summaryNoteId });
  }

  return {
    comments,
    movedToSummary,
    resolvedDiscussions,
    unresolvedDiscussions,
    ...(summaryNoteId ? { summaryNoteId } : {}),
  };
}
