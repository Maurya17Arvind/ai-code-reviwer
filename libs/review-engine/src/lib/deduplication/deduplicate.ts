import { sha256Hex } from '@acra/repository-context';
import { type FindingPlacement, type FindingSource, type Severity } from '@acra/shared-types';
import { SEVERITY_RANK, SOURCE_ORDER } from '../candidate';
import { normalizeCode } from '../validators/context-index';
import { type ValidatedCandidate } from '../validators/validate-findings';

/** A deduplicated finding: one issue, possibly reported by several sources. */
export interface MergedFinding {
  readonly fingerprint: string;
  readonly primary: ValidatedCandidate;
  readonly sources: readonly FindingSource[];
  readonly confidence: number;
  readonly placement: FindingPlacement;
  /** Present when sources assessed severity differently (disagreement is recorded, not hidden). */
  readonly severityAssessments?: ReadonlyArray<{ readonly source: FindingSource; readonly severity: Severity }>;
}

/** Agreement between independent models is a signal, not proof: small bonus, hard cap. */
const AGREEMENT_BONUS = 0.05;
const CONFIDENCE_CAP = 0.99;
const LINE_PROXIMITY = 3;

/**
 * Stable identity of an issue across commits: file + category + normalised evidence. Line
 * numbers are deliberately excluded (they shift when unrelated code above changes).
 */
export function fingerprintOf(filePath: string, category: string, evidence: string): string {
  return sha256Hex(`${filePath}\n${category}\n${normalizeCode(evidence).toLowerCase().slice(0, 300)}`).slice(0, 32);
}

/**
 * DEDUPLICATE_FINDINGS: clusters candidates describing the same issue — same fingerprint, or same
 * file with overlapping/adjacent lines and the same category or a clearly similar title.
 * Fully deterministic (stable ordering, greedy clustering).
 */
export function deduplicateFindings(accepted: readonly ValidatedCandidate[]): MergedFinding[] {
  const sorted = [...accepted].sort(
    (a, b) =>
      cmp(a.candidate.filePath, b.candidate.filePath) ||
      (a.candidate.lineStart ?? 0) - (b.candidate.lineStart ?? 0) ||
      SOURCE_ORDER[a.candidate.source] - SOURCE_ORDER[b.candidate.source] ||
      cmp(a.candidate.title, b.candidate.title),
  );

  const clusters: ValidatedCandidate[][] = [];
  for (const item of sorted) {
    const cluster = clusters.find((members) => members.some((member) => sameIssue(member, item)));
    if (cluster) cluster.push(item);
    else clusters.push([item]);
  }

  return clusters.map((members) => {
    const primary = [...members].sort(
      (a, b) =>
        b.confidence - a.confidence ||
        SEVERITY_RANK[b.candidate.severity] - SEVERITY_RANK[a.candidate.severity] ||
        SOURCE_ORDER[a.candidate.source] - SOURCE_ORDER[b.candidate.source],
    )[0] as ValidatedCandidate;

    const sources = [...new Set(members.map((m) => m.candidate.source))].sort(
      (a, b) => SOURCE_ORDER[a] - SOURCE_ORDER[b],
    );
    const aiSources = sources.filter((s) => s !== 'static').length;
    const confidence = Math.min(CONFIDENCE_CAP, primary.confidence + (aiSources >= 2 ? AGREEMENT_BONUS : 0));
    const severities = new Set(members.map((m) => m.candidate.severity));
    const placement: FindingPlacement = members.every((m) => m.placement === 'inline') ? 'inline' : primary.placement;

    return {
      fingerprint: fingerprintOf(primary.candidate.filePath, primary.candidate.category, primary.candidate.evidence),
      primary,
      sources,
      confidence: Math.round(confidence * 1000) / 1000,
      placement,
      ...(severities.size > 1
        ? { severityAssessments: members.map((m) => ({ source: m.candidate.source, severity: m.candidate.severity })) }
        : {}),
    };
  });
}

function sameIssue(a: ValidatedCandidate, b: ValidatedCandidate): boolean {
  const x = a.candidate;
  const y = b.candidate;
  if (x.filePath !== y.filePath) return false;
  if (fingerprintOf(x.filePath, x.category, x.evidence) === fingerprintOf(y.filePath, y.category, y.evidence))
    return true;
  if (x.lineStart === null || y.lineStart === null) return false;
  const near =
    x.lineStart <= (y.lineEnd ?? y.lineStart) + LINE_PROXIMITY &&
    y.lineStart <= (x.lineEnd ?? x.lineStart) + LINE_PROXIMITY;
  return near && (x.category === y.category || titleSimilarity(x.title, y.title) >= 0.5);
}

export function titleSimilarity(a: string, b: string): number {
  const tokens = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 2),
    );
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / (left.size + right.size - intersection);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
