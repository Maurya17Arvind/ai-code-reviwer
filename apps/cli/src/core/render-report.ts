import { type ReviewReport } from '@acra/review-engine';
import { type ReviewFinding } from '@acra/shared-types';
import { type CliIO, paint } from './cli-context';

const SEVERITY_STYLE = { critical: 'red', high: 'red', medium: 'yellow', low: 'dim' } as const;

/** Untrusted text (model output, paths) is printed without terminal control characters. */
export function safeTerminalText(text: string): string {
  // Intentional: strip C0/C1 control characters so model output cannot inject terminal escape sequences.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/\n/g, ' ');
}

export function renderExecutions(io: CliIO, report: ReviewReport): string {
  return report.executions
    .map((execution) => {
      if (execution.status === 'skipped') {
        return `${execution.provider} ${paint(io, 'dim', `skipped (${execution.errorMessage ?? ''})`)}`;
      }
      if (execution.status === 'failed') {
        return `${execution.provider} ${paint(io, 'red', `✗ ${execution.errorKind ?? 'failed'}`)}`;
      }
      const seconds = (execution.latencyMs / 1000).toFixed(1);
      const cost = execution.costUsd === null ? 'cost n/a' : `$${execution.costUsd.toFixed(4)}`;
      const model =
        execution.servedByModel && execution.servedByModel !== execution.model
          ? `${execution.model}→${execution.servedByModel}`
          : execution.model;
      return `${execution.provider} ${paint(io, 'green', '✓')} ${model} ${seconds}s ${cost}`;
    })
    .join(' · ');
}

export function renderFinding(io: CliIO, finding: ReviewFinding, verbose: boolean): string[] {
  const severity = paint(io, SEVERITY_STYLE[finding.severity], finding.severity.toUpperCase().padEnd(8));
  const location = `${safeTerminalText(finding.filePath)}${finding.lineNumber ? `:${finding.lineNumber}` : ''}`;
  const meta = paint(
    io,
    'dim',
    `${finding.category} · ${finding.confidence.toFixed(2)} · ${finding.modelSources.join('+')}${finding.placement === 'summary' ? ' · summary' : ''} · id ${finding.id.slice(0, 8)}`,
  );
  const lines = [`  ${severity} ${location}  ${safeTerminalText(finding.title)}`, `           ${meta}`];
  if (verbose) {
    lines.push(`           ${safeTerminalText(finding.description)}`);
    lines.push(paint(io, 'dim', `           > ${safeTerminalText(finding.evidence).slice(0, 200)}`));
    if (finding.suggestion)
      lines.push(`           ${paint(io, 'cyan', 'fix:')} ${safeTerminalText(finding.suggestion)}`);
  }
  return lines;
}

export function renderReportText(io: CliIO, report: ReviewReport, verbose: boolean): void {
  const label = (text: string) => paint(io, 'dim', text.padEnd(12));
  const status =
    report.status === 'completed'
      ? paint(io, 'green', 'completed')
      : paint(io, report.status === 'failed' ? 'red' : 'yellow', report.status);
  io.out(`${label('Review')}${status} · ${renderExecutions(io, report)}`);
  io.out(`${label('Scope')}${report.scopeDescription}`);
  io.out('');

  if (report.findings.length === 0) {
    io.out(
      report.status === 'failed'
        ? 'No AI review completed; only static checks ran.'
        : 'No issues met the publishing thresholds.',
    );
  } else {
    io.out(paint(io, 'bold', `Findings (${report.findings.length})`));
    for (const finding of report.findings) for (const line of renderFinding(io, finding, verbose)) io.out(line);
  }

  const { stats } = report;
  io.out('');
  io.out(
    paint(
      io,
      'dim',
      `${stats.filesReviewed} files · ${stats.candidates} candidates · ${stats.rejected} rejected by validation · ${stats.filtered} below thresholds/dismissed · ${report.resolved.length} resolved · ${report.secretsRedacted} secrets redacted before sending · total ${stats.totalCostUsd === null ? 'cost n/a' : `$${stats.totalCostUsd.toFixed(4)}`}`,
    ),
  );
}
