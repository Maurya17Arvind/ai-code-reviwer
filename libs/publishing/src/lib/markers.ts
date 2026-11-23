import { type ExistingComment } from '@acra/git-providers-core';

/**
 * Hidden markers identify the bot's own comments so re-reviews never duplicate them.
 * Markers are trusted ONLY on comments authored by the bot's own account — anyone can type
 * a marker into a comment, and honouring it would let a user silently suppress a finding.
 */
export const SUMMARY_MARKER = '<!-- acra:summary -->';

export function findingMarker(fingerprint: string): string {
  return `<!-- acra:finding fp=${fingerprint} -->`;
}

const FINDING_MARKER = /<!-- acra:finding fp=([0-9a-f]{16,64}) -->/;

export interface BotCommentIndex {
  /** fingerprint → the bot's existing inline comment for it */
  readonly findings: ReadonlyMap<string, ExistingComment>;
  /** the bot's existing summary note, if any */
  readonly summary?: ExistingComment;
}

export function indexBotComments(comments: readonly ExistingComment[]): BotCommentIndex {
  const findings = new Map<string, ExistingComment>();
  let summary: ExistingComment | undefined;
  for (const comment of comments) {
    if (!comment.authoredByUs) continue;
    if (comment.body.includes(SUMMARY_MARKER)) {
      summary ??= comment;
      continue;
    }
    const fingerprint = FINDING_MARKER.exec(comment.body)?.[1];
    if (fingerprint && !findings.has(fingerprint)) findings.set(fingerprint, comment);
  }
  return summary ? { findings, summary } : { findings };
}
