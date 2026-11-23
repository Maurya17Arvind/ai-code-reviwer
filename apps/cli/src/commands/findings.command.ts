import { renderMarkdownReport, SEVERITY_RANK } from '@acra/review-engine';
import { type Severity } from '@acra/shared-types';
import { type Command, Option } from 'commander';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CliError, type CliIO, paint } from '../core/cli-context';
import { renderFinding, renderReportText } from '../core/render-report';
import { LocalReviewStore } from '../core/review-store';
import { type GlobalOptions, openRepository } from '../core/workspace';

async function latestReport(io: CliIO, command: Command) {
  const provider = await openRepository(io, command.optsWithGlobals<GlobalOptions>());
  const store = new LocalReviewStore(await provider.getGitDirectory());
  const report = await store.latest();
  if (!report) throw new CliError('No review found for this repository. Run `ai-review review` first.');
  return { store, report };
}

/** `ai-review findings` — findings of the latest local review (no network). */
export function registerFindingsCommand(program: Command, io: CliIO): void {
  program
    .command('findings')
    .description('list findings from the latest review in this repository')
    .addOption(
      new Option('--severity <severity>', 'minimum severity to show')
        .choices(['critical', 'high', 'medium', 'low'])
        .default('low'),
    )
    .addOption(new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'))
    .option('--verbose', 'print descriptions, evidence and suggestions')
    .action(async (options: { severity: Severity; format: 'text' | 'json'; verbose?: boolean }, command: Command) => {
      const { report } = await latestReport(io, command);
      const findings = report.findings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[options.severity]);
      if (options.format === 'json') {
        io.out(JSON.stringify({ reviewId: report.reviewId, createdAt: report.createdAt, findings }, null, 2));
        return;
      }
      io.out(
        paint(io, 'dim', `Review ${report.reviewId.slice(0, 8)} · ${report.createdAt} · ${report.scopeDescription}`),
      );
      if (findings.length === 0) io.out('No findings.');
      for (const finding of findings)
        for (const line of renderFinding(io, finding, options.verbose ?? false)) io.out(line);
    });

  program
    .command('dismiss')
    .description('dismiss a finding (or mark it a false positive) so it is not reported again')
    .argument('<finding-id>', 'finding id or unique id prefix (see `ai-review findings`)')
    .option('--false-positive', 'record the finding as a false positive instead of a dismissal')
    .option('--reason <text>', 'why (stored locally, max 500 characters)')
    .action(async (id: string, options: { falsePositive?: boolean; reason?: string }, command: Command) => {
      const { store, report } = await latestReport(io, command);
      const matches = report.findings.filter((f) => f.id.startsWith(id));
      if (id.length < 4 || matches.length !== 1) {
        throw new CliError(
          matches.length > 1 ? `Finding id "${id}" is ambiguous.` : `No finding with id "${id}" in the latest review.`,
        );
      }
      const finding = matches[0];
      if (!finding) throw new CliError(`No finding with id "${id}".`);
      const status = options.falsePositive ? 'false_positive' : 'dismissed';
      await store.decide(finding.fingerprint, {
        status,
        ...(options.reason ? { reason: options.reason.slice(0, 500) } : {}),
        findingId: finding.id,
        filePath: finding.filePath,
        decidedAt: new Date().toISOString(),
      });
      io.out(
        `${paint(io, 'green', '✔')} Marked "${finding.title}" as ${status.replace('_', ' ')}. It will not be reported again.`,
      );
    });
}

/** `ai-review report` — renders the latest review (no network). */
export function registerReportCommand(program: Command, io: CliIO): void {
  program
    .command('report')
    .description('render the latest review as text, JSON or Markdown')
    .addOption(new Option('--format <format>', 'output format').choices(['text', 'json', 'markdown']).default('text'))
    .option('-o, --output <file>', 'write to a file instead of stdout')
    .action(async (options: { format: 'text' | 'json' | 'markdown'; output?: string }, command: Command) => {
      const { report } = await latestReport(io, command);
      if (options.format === 'text' && !options.output) {
        renderReportText(io, report, true);
        return;
      }
      const content =
        options.format === 'json'
          ? `${JSON.stringify(report, null, 2)}\n`
          : options.format === 'markdown'
            ? `${renderMarkdownReport(report)}\n`
            : '';
      if (options.format === 'text') throw new CliError('--output supports --format json or markdown.', 2);
      if (options.output) {
        const target = resolve(io.cwd, options.output);
        await writeFile(target, content, 'utf8');
        io.out(`Wrote ${target}`);
      } else {
        io.out(content);
      }
    });
}
