import { type ExistingComment } from '@acra/git-providers-core';
import { type ReviewContext } from '@acra/repository-context';
import { type ReviewReport } from '@acra/review-engine';
import { type ReviewFinding } from '@acra/shared-types';
import { indexBotComments } from './markers';

export interface PlannedInlineComment {
  readonly finding: ReviewFinding;
  readonly path: string;
  readonly oldPath: string;
  readonly newLine: number;
  /** Set for unchanged (context) lines — GitLab requires both sides there. */
  readonly oldLine?: number;
}

export interface PublicationPlan {
  readonly inline: readonly PlannedInlineComment[];
  /** Findings shown only in the summary (not line-mappable, or inline comments disabled). */
  readonly summaryOnly: readonly ReviewFinding[];
  /** Fingerprints that already have a bot comment — never posted twice. */
  readonly alreadyPublished: ReadonlyMap<string, ExistingComment>;
  /** Bot discussions of findings that are now resolved and still open. */
  readonly resolve: ReadonlyArray<{ readonly fingerprint: string; readonly discussionId: string }>;
  readonly existingSummaryNoteId?: string;
}

export interface PlanOptions {
  readonly inlineComments: boolean;
  readonly summary: boolean;
}

/**
 * PUBLISH_VALIDATED_COMMENTS (planning step, pure). Decides what to post without side effects:
 * inline comments only where the line is part of the diff (position derived from the diff, never
 * from model output), no duplicates of the bot's earlier comments, resolutions for fixed findings.
 */
export function planPublication(
  report: ReviewReport,
  context: ReviewContext,
  existing: readonly ExistingComment[],
  options: PlanOptions,
): PublicationPlan {
  const index = indexBotComments(existing);
  // A new commit gets a new summary comment; only a retry of the same commit updates its summary.
  const headSha = report.repository.headSha?.toLowerCase();
  const sameCommitSummary = headSha ? index.summariesByCommit.get(headSha) : undefined;
  const lineMaps = new Map(
    context.files.map((file) => {
      const map = new Map<number, { added: boolean; oldLine?: number }>();
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.newLine === undefined) continue;
          map.set(
            line.newLine,
            line.kind === 'add'
              ? { added: true }
              : { added: false, ...(line.oldLine !== undefined ? { oldLine: line.oldLine } : {}) },
          );
        }
      }
      return [file.path, { file, map }] as const;
    }),
  );

  const inline: PlannedInlineComment[] = [];
  const summaryOnly: ReviewFinding[] = [];
  const alreadyPublished = new Map<string, ExistingComment>();

  for (const finding of report.findings) {
    const existingComment = index.findings.get(finding.fingerprint);
    if (existingComment) {
      alreadyPublished.set(finding.fingerprint, existingComment);
      continue;
    }
    const target = lineMaps.get(finding.filePath);
    const line = finding.lineNumber !== undefined ? target?.map.get(finding.lineNumber) : undefined;
    if (
      !options.inlineComments ||
      finding.placement !== 'inline' ||
      !target ||
      finding.lineNumber === undefined ||
      !line
    ) {
      summaryOnly.push(finding);
      continue;
    }
    inline.push({
      finding,
      path: target.file.path,
      oldPath: target.file.oldPath ?? target.file.path,
      newLine: finding.lineNumber,
      ...(line.added ? {} : line.oldLine !== undefined ? { oldLine: line.oldLine } : {}),
    });
  }

  const resolvedFingerprints = new Set(report.resolved.map((r) => r.fingerprint));
  const resolve = [...index.findings.entries()]
    .filter(
      ([fingerprint, comment]) => resolvedFingerprints.has(fingerprint) && comment.resolvable && !comment.resolved,
    )
    .map(([fingerprint, comment]) => ({ fingerprint, discussionId: comment.discussionId }));

  return {
    inline,
    summaryOnly,
    alreadyPublished,
    resolve,
    ...(options.summary && sameCommitSummary ? { existingSummaryNoteId: sameCommitSummary.noteId } : {}),
  };
}
