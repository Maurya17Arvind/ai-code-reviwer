import { type ReviewReport } from './review-report';

const SEVERITY_ICON: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' };

/** Escapes untrusted text (model output, paths) so it cannot inject Markdown/HTML structure. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&').replace(/\r?\n/g, ' ');
}

function codeBlock(text: string): string {
  const fence = text.includes('```') ? '~~~~' : '```';
  return `${fence}\n${text}\n${fence}`;
}

/** Markdown report (`ai-review report --format markdown`); later reused for MR/PR summaries. */
export function renderMarkdownReport(report: ReviewReport): string {
  const lines: string[] = [];
  lines.push('# AI Code Review', '');
  lines.push(
    `**Status:** ${report.status} · **Scope:** ${escapeMarkdown(report.scopeDescription)} · **Findings:** ${report.findings.length}`,
    '',
  );

  lines.push('| Provider | Model | Status | Findings | Tokens (in/out) | Cost |', '|---|---|---|---|---|---|');
  for (const execution of report.executions) {
    const tokens = `${execution.usage.inputTokens}/${execution.usage.outputTokens}`;
    const cost = execution.costUsd === null ? 'n/a' : `$${execution.costUsd.toFixed(4)}`;
    const model =
      execution.servedByModel && execution.servedByModel !== execution.model
        ? `${execution.model} → ${execution.servedByModel}`
        : execution.model;
    const status = execution.status === 'failed' ? `failed (${execution.errorKind ?? 'error'})` : execution.status;
    lines.push(
      `| ${execution.provider} | ${escapeMarkdown(model)} | ${status} | ${execution.rawFindingCount} | ${tokens} | ${cost} |`,
    );
  }
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('No issues met the publishing thresholds.', '');
  }
  for (const finding of report.findings) {
    const location = `${finding.filePath}${finding.lineNumber ? `:${finding.lineNumber}` : ''}`;
    lines.push(
      `## ${SEVERITY_ICON[finding.severity] ?? ''} ${escapeMarkdown(finding.title)}`,
      '',
      `\`${location.replace(/`/g, "'")}\` · ${finding.severity} · ${finding.category} · confidence ${finding.confidence.toFixed(2)} · ${finding.modelSources.join(' + ')}${finding.placement === 'summary' ? ' · summary-only' : ''}`,
      '',
      escapeMarkdown(finding.description),
      '',
      codeBlock(finding.evidence),
      '',
    );
    if (finding.suggestion) lines.push(`**Suggestion:** ${escapeMarkdown(finding.suggestion)}`, '');
  }

  if (report.resolved.length > 0) {
    lines.push(`### Resolved since last review (${report.resolved.length})`, '');
    for (const resolved of report.resolved)
      lines.push(`- \`${resolved.filePath.replace(/`/g, "'")}\` (${resolved.fingerprint.slice(0, 8)})`);
    lines.push('');
  }

  lines.push(
    `<sub>context ${report.contextHash.slice(0, 12)} · prompt ${report.promptHash.slice(0, 12)} · ${report.stats.rejected} rejected by validation · ${report.stats.filtered} below thresholds · ${report.secretsRedacted} secrets redacted before sending</sub>`,
  );
  return lines.join('\n');
}
