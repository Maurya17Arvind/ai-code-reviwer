import {
  type AiProviderName,
  MODEL_OUTPUT_LIMITS,
  type ModelReviewOutput,
  ModelReviewOutputSchema,
} from '@acra/ai-providers-core';
import { normalizeRepoRelativePath } from '@acra/security';
import { type CandidateFinding } from '../candidate';

export type ParsedModelOutput =
  | { readonly ok: true; readonly output: ModelReviewOutput; readonly truncatedFindings: number }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Validates raw provider output against the shared schema. Never trusts provider-side validation. */
export function parseModelOutput(raw: unknown): ParsedModelOutput {
  const result = ModelReviewOutputSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      problems: result.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    };
  }
  const findings = result.data.findings.slice(0, MODEL_OUTPUT_LIMITS.maxFindings);
  return {
    ok: true,
    output: { ...result.data, findings },
    truncatedFindings: result.data.findings.length - findings.length,
  };
}

export interface RejectedCandidate {
  readonly source: CandidateFinding['source'];
  readonly filePath: string;
  readonly title: string;
  readonly reason: string;
}

/**
 * AGGREGATE_FINDINGS: normalises every source's findings into CandidateFindings (trimmed text,
 * clamped confidence, normalised paths, ordered line ranges). Candidates with unusable paths are
 * rejected here; everything else goes to validation.
 */
export function aggregateFindings(
  modelOutputs: ReadonlyArray<{ readonly provider: AiProviderName; readonly output: ModelReviewOutput }>,
  staticFindings: readonly CandidateFinding[],
): { candidates: CandidateFinding[]; rejected: RejectedCandidate[] } {
  const candidates: CandidateFinding[] = [...staticFindings];
  const rejected: RejectedCandidate[] = [];

  for (const { provider, output } of modelOutputs) {
    for (const finding of output.findings) {
      let filePath: string;
      try {
        filePath = normalizeRepoRelativePath(finding.filePath.trim());
      } catch {
        rejected.push({
          source: provider,
          filePath: finding.filePath.slice(0, 200),
          title: clip(finding.title, 200),
          reason: 'invalid_path',
        });
        continue;
      }
      let lineStart = positiveIntOrNull(finding.lineStart);
      let lineEnd = positiveIntOrNull(finding.lineEnd);
      if (lineStart === null && lineEnd !== null) lineStart = lineEnd;
      if (lineStart !== null && (lineEnd === null || lineEnd < lineStart)) lineEnd = lineStart;

      candidates.push({
        source: provider,
        filePath,
        lineStart,
        lineEnd,
        severity: finding.severity,
        category: finding.category,
        title: clip(finding.title, 200),
        description: clip(finding.description, MODEL_OUTPUT_LIMITS.maxTextLength),
        evidence: clip(stripPromptFormatting(finding.evidence), MODEL_OUTPUT_LIMITS.maxEvidenceLength),
        suggestion: finding.suggestion === null ? null : clip(finding.suggestion, MODEL_OUTPUT_LIMITS.maxTextLength),
        confidence: Number.isFinite(finding.confidence) ? Math.min(1, Math.max(0, finding.confidence)) : 0,
      });
    }
  }
  return { candidates, rejected };
}

/**
 * Models sometimes copy the prompt's diff formatting ("+ 12 | code", "4 | code") into evidence.
 * Strip it per line so stored/displayed evidence is plain code.
 */
export function stripPromptFormatting(evidence: string): string {
  return evidence
    .split('\n')
    .map((line) => line.replace(/^\s*[+-]?\s*\d+\s*\|\s?/, ''))
    .join('\n');
}

function positiveIntOrNull(value: number | null): number | null {
  return value !== null && Number.isInteger(value) && value > 0 ? value : null;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
