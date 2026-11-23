import { type AiProviderName } from '@acra/ai-providers-core';
import { disableThirdPartyTracing, runReview } from '@acra/agent-core';
import { AiEnvSchema, loadEnv } from '@acra/configuration';
import { SEVERITY_RANK } from '@acra/review-engine';
import { type Severity } from '@acra/shared-types';
import { type Command, InvalidArgumentError, Option } from 'commander';
import { relative } from 'node:path';
import { CliError, type CliIO, formatBytes, paint } from '../core/cli-context';
import { type ContextOptions, loadReviewContext } from '../core/review-context';
import { LocalReviewStore } from '../core/review-store';
import { type ReviewerFactory } from '@acra/ai-providers-factory';
import { renderReportText } from '../core/render-report';
import { type GlobalOptions, openRepository, toCliError } from '../core/workspace';

interface ReviewOptions extends ContextOptions {
  readonly provider: 'claude' | 'gpt' | 'ollama' | 'both' | 'all';
  readonly format: 'text' | 'json';
  readonly yes?: boolean;
  readonly failOn?: Severity;
  readonly verbose?: boolean;
}

/** Exit code used when findings at or above --fail-on exist (CI gate). */
export const EXIT_FINDINGS = 3;

function nonNegativeInt(max: number) {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > max)
      throw new InvalidArgumentError(`expected an integer between 0 and ${max}`);
    return parsed;
  };
}

/**
 * `ai-review review` — runs the Claude + GPT review pipeline on local changes.
 * Sends code to external AI providers ONLY after explicit consent (--yes or an interactive yes).
 * Never modifies, stages, commits or pushes code; results are kept under .git/ai-review/.
 */
export function registerReviewCommand(program: Command, io: CliIO, createReviewers: ReviewerFactory): void {
  program
    .command('review')
    .description('review local changes with Claude and GPT (asks before sending code to AI providers)')
    .option('--staged', 'staged changes (index vs HEAD)')
    .option('--unstaged', 'unstaged changes incl. untracked files')
    .option('--base <ref>', 'base branch/commit (default: detected base branch)')
    .option('--branch <ref>', 'review another branch against --base without checking it out')
    .option('--all', 'committed + staged + unstaged + untracked changes not in base (default)')
    .option('--no-untracked', 'exclude untracked files')
    .option('--diff-context <lines>', 'unchanged lines inside the diff (git -U)', nonNegativeInt(50))
    .option('--surrounding <lines>', 'surrounding source lines per hunk', nonNegativeInt(200))
    .addOption(
      new Option('--provider <provider>', 'AI reviewers: claude, gpt, ollama (local), both (claude+gpt) or all')
        .choices(['claude', 'gpt', 'ollama', 'both', 'all'])
        .default('both'),
    )
    .addOption(
      new Option('--fail-on <severity>', 'exit with code 3 if findings at/above this severity exist').choices([
        'critical',
        'high',
        'medium',
        'low',
      ]),
    )
    .addOption(new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'))
    .option('-y, --yes', 'consent to sending the review context to the configured AI providers')
    .option('--verbose', 'print descriptions, evidence and suggestions')
    .action(async (options: ReviewOptions, command: Command) => {
      const provider = await openRepository(io, command.optsWithGlobals<GlobalOptions>());
      try {
        const { info, config, context } = await loadReviewContext(provider, options);
        if (!config.review.enabled) {
          io.out('Reviews are disabled for this repository (review.enabled: false in ai-review.yaml).');
          return;
        }
        if (context.files.length === 0) {
          io.out(
            `Nothing to review: ${context.stats.changedFiles === 0 ? 'no changes in this scope' : 'all changed files were omitted'}.`,
          );
          return;
        }

        const aiEnv = loadEnv(AiEnvSchema, io.env);
        const requested: readonly AiProviderName[] =
          options.provider === 'both'
            ? ['claude', 'gpt']
            : options.provider === 'all'
              ? ['claude', 'gpt', 'ollama']
              : [options.provider];
        const allowed: Record<AiProviderName, boolean> = {
          claude: config.review.providers.claude,
          gpt: config.review.providers.openai,
          ollama: config.review.providers.ollama,
        };
        const wanted = new Set<AiProviderName>(requested.filter((p) => allowed[p]));
        if (wanted.size === 0)
          throw new CliError('No AI provider is enabled (see review.providers in ai-review.yaml and --provider).', 2);
        const setup = createReviewers(aiEnv, wanted);
        for (const skipped of setup.skipped)
          io.err(paint(io, 'yellow', `Skipping ${skipped.provider}: ${skipped.reason}.`));
        if (setup.reviewers.length === 0)
          throw new CliError('No AI reviewer could be configured (see messages above).', 2);

        // ---- Consent: show exactly what leaves the machine, then ask. ----
        const tracingWarning = disableThirdPartyTracing();
        if (tracingWarning) io.err(paint(io, 'yellow', tracingWarning));
        const destinations = setup.destinations
          .map((d) => `${d.provider} (${d.model} via ${d.host}${d.local ? ', this machine' : ''})`)
          .join(', ');
        // Consent is about code leaving the machine; purely local (loopback) reviewers need none.
        const leavesMachine = setup.destinations.some((d) => !d.local);
        const summary = leavesMachine
          ? `About to send ${context.files.length} file(s) — diffs plus surrounding lines, ${formatBytes(context.stats.contextBytes)}, secrets redacted — to: ${destinations}.`
          : `Reviewing ${context.files.length} file(s) (${formatBytes(context.stats.contextBytes)}) with ${destinations}. Nothing leaves this machine.`;
        if (!leavesMachine) {
          if (options.format === 'text') io.out(paint(io, 'dim', summary));
        } else if (!options.yes) {
          if (!io.confirm)
            throw new CliError(`${summary}\nRe-run with --yes to consent (no interactive terminal available).`, 2);
          io.out(summary);
          if (!(await io.confirm('Send this code for review?'))) {
            io.out('Cancelled. Nothing was sent.');
            return;
          }
        } else if (options.format === 'text') {
          io.out(paint(io, 'dim', summary));
        }

        const store = new LocalReviewStore(await provider.getGitDirectory());
        const report = await runReview({
          context,
          reviewers: setup.reviewers,
          skippedProviders: setup.skipped,
          settings: {
            categories: config.review.categories,
            minimumSeverity: config.review.minimumSeverity,
            minimumConfidence: config.review.minimumConfidence,
            ...(config.project.framework ? { framework: config.project.framework } : {}),
            ...(config.project.language ? { language: config.project.language } : {}),
            providerTimeoutMs: aiEnv.AI_REVIEW_TIMEOUT_MS,
          },
          repository: {
            rootPath: info.rootPath,
            branch: info.currentBranch,
            headSha: info.headSha,
            repositoryId: null,
          },
          priorFindings: await store.priorFindings(),
        });
        const savedAt = await store.save(report);

        if (options.format === 'json') io.out(JSON.stringify(report, null, 2));
        else {
          if (!options.yes) io.out('');
          renderReportText(io, report, options.verbose ?? false);
          io.out(
            paint(
              io,
              'dim',
              `Saved ${relative(info.rootPath, savedAt).replace(/\\/g, '/')} · \`ai-review report --format markdown\` for the full report`,
            ),
          );
        }

        if (report.status === 'failed')
          throw new CliError('No AI reviewer completed successfully (see provider status above).');
        if (options.failOn) {
          const threshold = SEVERITY_RANK[options.failOn];
          const blocking = report.findings.filter((f) => SEVERITY_RANK[f.severity] >= threshold).length;
          if (blocking > 0) {
            throw new CliError(`${blocking} finding(s) at or above ${options.failOn}.`, EXIT_FINDINGS);
          }
        }
      } catch (error) {
        throw toCliError(error);
      }
    });
}
