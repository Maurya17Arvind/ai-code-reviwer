import { type ReviewReport } from '@acra/review-engine';
import { type ReviewFinding } from '@acra/shared-types';
import { findingMarker, summaryMarker } from './markers';
import { codeFence, escapeInline, neutralizeQuickActions } from './sanitize';

const SEVERITY_LABEL: Record<ReviewFinding['severity'], string> = {
  critical: '🔴 Critical',
  high: '🟠 High',
  medium: '🟡 Medium',
  low: '⚪ Low',
};

const SOURCE_LABEL: Record<string, string> = {
  claude: 'Claude',
  gpt: 'GPT',
  ollama: 'local model',
  static: 'static analysis',
};

/** Inline comment for one finding. All model-derived text is escaped. */
export function renderFindingComment(finding: ReviewFinding): string {
  const lines = [
    `**${SEVERITY_LABEL[finding.severity]} · ${finding.category.replace(/_/g, ' ')}** — ${escapeInline(finding.title)}`,
    '',
    escapeInline(finding.description),
  ];
  if (finding.suggestion) lines.push('', `**Suggestion:** ${escapeInline(finding.suggestion)}`);
  lines.push(
    '',
    `<sub>AI code review · ${finding.modelSources.map((s) => SOURCE_LABEL[s] ?? s).join(' + ')} · confidence ${finding.confidence.toFixed(2)}</sub>`,
    findingMarker(finding.fingerprint),
  );
  return neutralizeQuickActions(lines.join('\n'));
}

/**
 * Summary note (one per MR, updated in place on every review). Lists findings that cannot be
 * placed inline — never inventing positions — plus provider status and resolved findings.
 */
export function renderSummaryComment(
  report: ReviewReport,
  summaryOnly: readonly ReviewFinding[],
  inlineCount: number,
): string {
  const lines: string[] = ['### 🤖 AI Code Review', ''];
  const providers = report.executions
    .map((e) =>
      e.status === 'succeeded'
        ? `${SOURCE_LABEL[e.provider] ?? e.provider} ✓`
        : `${SOURCE_LABEL[e.provider] ?? e.provider} ${e.status === 'skipped' ? 'skipped' : `✗ (${e.errorKind ?? 'error'})`}`,
    )
    .join(' · ');
  lines.push(
    `**${report.findings.length} finding(s)** for commit \`${(report.repository.headSha ?? '').slice(0, 8)}\` · ${providers}`,
    '',
  );
  if (report.status !== 'completed') {
    lines.push(
      report.status === 'partial'
        ? '> ⚠️ Partial review: at least one AI reviewer failed; results come from the remaining reviewer(s).'
        : '> ⚠️ No AI reviewer completed; only static checks ran.',
      '',
    );
  }
  if (inlineCount > 0) lines.push(`${inlineCount} finding(s) are posted as inline comments on the diff.`, '');

  if (summaryOnly.length > 0) {
    lines.push('#### Findings not tied to a changed line', '');
    for (const finding of summaryOnly) {
      const location = `${finding.filePath}${finding.lineNumber ? `:${finding.lineNumber}` : ''}`;
      lines.push(
        `- **${SEVERITY_LABEL[finding.severity]}** \`${location.replace(/`/g, "'")}\` — ${escapeInline(finding.title)}`,
        `  ${escapeInline(finding.description)}`,
      );
      if (finding.evidence) lines.push('', indent(codeFence(finding.evidence)), '');
      if (finding.suggestion) lines.push(`  **Suggestion:** ${escapeInline(finding.suggestion)}`);
    }
    lines.push('');
  }
  if (report.resolved.length > 0)
    lines.push(`✅ ${report.resolved.length} previously reported finding(s) are resolved.`, '');
  if (report.findings.length === 0 && report.status === 'completed')
    lines.push('No issues met the publishing thresholds. 🎉', '');

  lines.push(
    `<sub>Findings are AI-generated and filtered by deterministic validation (${report.stats.rejected} rejected, ${report.stats.filtered} below thresholds). ` +
      'Resolve a thread to dismiss it. This bot never approves, merges or changes code.</sub>',
    summaryMarker(report.repository.headSha ?? ''),
  );
  return neutralizeQuickActions(lines.join('\n'));
}

function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
