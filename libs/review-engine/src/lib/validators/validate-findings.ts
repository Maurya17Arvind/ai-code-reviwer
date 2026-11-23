import { type ReviewContext } from '@acra/repository-context';
import { type FindingPlacement, type ReviewCategory } from '@acra/shared-types';
import { type CandidateFinding } from '../candidate';
import { type FileIndex, indexContext, normalizeCode } from './context-index';

export type RejectionReason =
  | 'unknown_file'
  | 'category_disabled'
  | 'invalid_line'
  | 'unrelated_to_change'
  | 'no_evidence'
  | 'speculative'
  | 'style_only';

export interface ValidatedCandidate {
  readonly candidate: CandidateFinding;
  readonly placement: FindingPlacement;
  /** Confidence after deterministic adjustments (before agreement bonus). */
  readonly confidence: number;
  readonly evidenceFound: boolean;
  readonly suggestion: string | null;
  readonly notes: readonly string[];
}

export interface ValidationOutcome {
  readonly accepted: ValidatedCandidate[];
  readonly rejected: Array<{ readonly candidate: CandidateFinding; readonly reason: RejectionReason }>;
}

export interface ValidationOptions {
  readonly enabledCategories: readonly ReviewCategory[];
}

const SPECULATIVE =
  /\b(might|may|could|possibly|potentially|perhaps|presumably|it is unclear|not sure|consider(?:ing)?)\b/gi;
const STYLE_ONLY =
  /\b(naming|rename|variable name|formatting|indentation|whitespace|typo|spelling|code style|style guide|semicolons?|trailing commas?|line length|import order|sort(?:ed)? imports|prefer const|readability nit|nitpick)\b/i;
const STYLE_CATEGORIES: ReadonlySet<ReviewCategory> = new Set(['maintainability', 'architecture', 'testing']);
const EVIDENCE_PENALTY = 0.25;
const SPECULATION_PENALTY = 0.1;

/**
 * VALIDATE_FINDINGS (Module E). Deterministic rules; an AI model saying something — or two models
 * agreeing — never bypasses them.
 */
export function validateFindings(
  context: ReviewContext,
  candidates: readonly CandidateFinding[],
  options: ValidationOptions,
): ValidationOutcome {
  const index = indexContext(context);
  const enabled = new Set(options.enabledCategories);
  const accepted: ValidatedCandidate[] = [];
  const rejected: ValidationOutcome['rejected'] = [];

  for (const candidate of candidates) {
    const result = validateOne(candidate, index.get(candidate.filePath), enabled);
    if ('reason' in result) rejected.push({ candidate, reason: result.reason });
    else accepted.push(result);
  }
  return { accepted, rejected };
}

function validateOne(
  candidate: CandidateFinding,
  file: FileIndex | undefined,
  enabled: ReadonlySet<ReviewCategory>,
): ValidatedCandidate | { reason: RejectionReason } {
  // 1. The file must be part of the reviewed change set (excluded/omitted files never qualify).
  if (!file) return { reason: 'unknown_file' };
  // 2. Category must be enabled for this repository.
  if (!enabled.has(candidate.category)) return { reason: 'category_disabled' };

  // 3. Line references must exist in the reviewed version of the file.
  const isDeleted = file.file.status === 'deleted';
  const { lineStart, lineEnd } = candidate;
  if (lineStart !== null && !isDeleted) {
    const max = file.file.lineCount;
    if (max === null || lineStart > max || (lineEnd ?? lineStart) > max) return { reason: 'invalid_line' };
  }

  // 4. Must relate to the change: touch a changed line, or sit within the surrounding code reviewers saw.
  if (lineStart !== null && !isDeleted) {
    const end = lineEnd ?? lineStart;
    let touchesChange = false;
    for (let line = lineStart; line <= end; line++) {
      if (file.addedLines.has(line) || file.commentableLines.has(line)) touchesChange = true;
    }
    const nearChange = file.windows.some((window) => lineStart <= window.end && end >= window.start);
    if (!touchesChange && !nearChange) return { reason: 'unrelated_to_change' };
  }

  // 5. Evidence must be present and should be verbatim code from the reviewed input.
  const evidence = normalizeCode(candidate.evidence);
  if (evidence.length === 0) return { reason: 'no_evidence' };
  const evidenceFound = candidate.source === 'static' || file.searchableText.includes(evidence);

  // 6. Style-only / preference findings are never published.
  const text = `${candidate.title} ${candidate.description}`;
  if (STYLE_CATEGORIES.has(candidate.category) && STYLE_ONLY.test(text)) return { reason: 'style_only' };

  // 7. Speculation: hedged wording without verifiable evidence is rejected; hedging alone is penalised.
  const hedges = (text.match(SPECULATIVE) ?? []).length;
  const speculative = hedges >= 2 || /^consider\b/i.test(candidate.title);
  if (speculative && !evidenceFound) return { reason: 'speculative' };

  const notes: string[] = [];
  let confidence = candidate.confidence;
  if (!evidenceFound) {
    confidence -= EVIDENCE_PENALTY;
    notes.push('evidence_not_found_verbatim');
  }
  if (speculative) {
    confidence -= SPECULATION_PENALTY;
    notes.push('hedged_wording');
  }

  // 8. A suggestion must add something beyond restating the evidence.
  let suggestion = candidate.suggestion;
  if (suggestion !== null && (suggestion.length < 5 || normalizeCode(suggestion) === evidence)) {
    suggestion = null;
    notes.push('suggestion_dropped');
  }

  // 9. Inline only when every referenced line can carry a provider comment; otherwise summary.
  let placement: FindingPlacement = 'summary';
  if (lineStart !== null && !isDeleted) {
    const end = lineEnd ?? lineStart;
    let allCommentable = true;
    for (let line = lineStart; line <= end; line++) if (!file.commentableLines.has(line)) allCommentable = false;
    placement = allCommentable ? 'inline' : 'summary';
  }

  return {
    candidate,
    placement,
    confidence: Math.max(0, Math.min(1, confidence)),
    evidenceFound,
    suggestion,
    notes,
  };
}
