import { type ReviewFinding, type Severity } from '@acra/shared-types';
import { randomUUID } from 'node:crypto';
import { SEVERITY_RANK } from '../candidate';
import { type MergedFinding } from '../deduplication/deduplicate';
import { type Reconciliation } from '../finding-lifecycle/lifecycle';
import { type ReviewReport } from '../report/review-report';

export interface SelectionOptions {
  readonly minimumSeverity: Severity;
  readonly minimumConfidence: number;
  readonly reviewSessionId: string;
  readonly repositoryId: string | null;
  readonly commitSha: string | null;
  readonly now: string;
  readonly reconciliation: Reconciliation;
}

/**
 * MAP_FINDINGS_TO_DIFF + thresholds: turns merged findings into ReviewFindings (status
 * `validated`, placement already decided by validation) or records why they were filtered.
 * User decisions (dismissed / false positive) always win over a new detection.
 */
export function selectFindings(
  merged: readonly MergedFinding[],
  options: SelectionOptions,
): { findings: ReviewFinding[]; filtered: ReviewReport['filtered'] } {
  const findings: ReviewFinding[] = [];
  const filtered: ReviewReport['filtered'] = [];

  for (const item of merged) {
    const { candidate } = item.primary;
    const base = {
      fingerprint: item.fingerprint,
      filePath: candidate.filePath,
      ...(candidate.lineStart !== null ? { lineNumber: candidate.lineStart } : {}),
      title: candidate.title,
      severity: candidate.severity,
      category: candidate.category,
      confidence: item.confidence,
      sources: [...item.sources],
    };

    const suppressed = options.reconciliation.suppressed.get(item.fingerprint);
    if (suppressed === 'dismissed' || suppressed === 'false_positive') {
      filtered.push({ ...base, reason: suppressed });
      continue;
    }
    if (SEVERITY_RANK[candidate.severity] < SEVERITY_RANK[options.minimumSeverity]) {
      filtered.push({ ...base, reason: 'below_severity' });
      continue;
    }
    if (item.confidence < options.minimumConfidence) {
      filtered.push({ ...base, reason: 'below_confidence' });
      continue;
    }

    const prior = options.reconciliation.stillPresent.get(item.fingerprint);
    const suggestion = item.primary.suggestion;
    findings.push({
      id: prior?.id ?? randomUUID(),
      fingerprint: item.fingerprint,
      repositoryId: options.repositoryId,
      reviewSessionId: options.reviewSessionId,
      filePath: candidate.filePath,
      ...(candidate.lineStart !== null ? { lineNumber: candidate.lineStart } : {}),
      ...(candidate.lineEnd !== null && candidate.lineEnd !== candidate.lineStart
        ? { endLineNumber: candidate.lineEnd }
        : {}),
      severity: candidate.severity,
      category: candidate.category,
      title: candidate.title,
      description: candidate.description,
      evidence: candidate.evidence,
      ...(suggestion ? { suggestion } : {}),
      confidence: item.confidence,
      isActionable: suggestion !== null || item.placement === 'inline',
      modelSources: [...item.sources],
      placement: item.placement,
      status: prior?.status === 'published' ? 'published' : 'validated',
      commitSha: options.commitSha,
      createdAt: prior?.createdAt ?? options.now,
      updatedAt: options.now,
    });
  }

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0) ||
      (a.lineNumber ?? 0) - (b.lineNumber ?? 0),
  );
  return { findings, filtered };
}
