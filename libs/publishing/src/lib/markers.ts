import { type ExistingComment } from '@acra/git-providers-core';

/**
 * Hidden markers identify the bot's own comments so re-reviews never duplicate them.
 * Markers are trusted ONLY on comments authored by the bot's own account — anyone can type
 * a marker into a comment, and honouring it would let a user silently suppress a finding.
 */
export const SUMMARY_MARKER = '<!-- acra:summary -->';

/**
 * Summary marker bound to the reviewed commit. Every reviewed commit gets its own summary comment
 * (review history stays visible on the MR/PR); a retry of the same commit updates that commit's
 * summary instead of posting a duplicate.
 */
export function summaryMarker(headSha: string): string {
  return /^[0-9a-f]{7,64}$/i.test(headSha) ? `<!-- acra:summary sha=${headSha.toLowerCase()} -->` : SUMMARY_MARKER;
}

const SUMMARY_PATTERN = /<!-- acra:summary(?: sha=([0-9a-f]{7,64}))? -->/;

export function findingMarker(fingerprint: string): string {
  return `<!-- acra:finding fp=${fingerprint} -->`;
}

const FINDING_MARKER = /<!-- acra:finding fp=([0-9a-f]{16,64}) -->/;

export interface BotCommentIndex {
  /** fingerprint → the bot's existing inline comment for it */
  readonly findings: ReadonlyMap<string, ExistingComment>;
  /** the bot's most recent summary note, if any */
  readonly summary?: ExistingComment;
  /** reviewed commit SHA → the bot's summary for that commit */
  readonly summariesByCommit: ReadonlyMap<string, ExistingComment>;
}

export function indexBotComments(comments: readonly ExistingComment[]): BotCommentIndex {
  const findings = new Map<string, ExistingComment>();
  const summariesByCommit = new Map<string, ExistingComment>();
  let summary: ExistingComment | undefined;
  for (const comment of comments) {
    if (!comment.authoredByUs) continue;
    const summaryMatch = SUMMARY_PATTERN.exec(comment.body);
    if (summaryMatch) {
      summary = comment;
      const sha = summaryMatch[1]?.toLowerCase();
      if (sha && !summariesByCommit.has(sha)) summariesByCommit.set(sha, comment);
      continue;
    }
    const fingerprint = FINDING_MARKER.exec(comment.body)?.[1];
    if (fingerprint && !findings.has(fingerprint)) findings.set(fingerprint, comment);
  }
  return summary ? { findings, summary, summariesByCommit } : { findings, summariesByCommit };
}
