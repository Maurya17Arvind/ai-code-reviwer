import { DEFAULT_EXCLUDE_GLOBS } from '@acra/configuration';
import { describeRevision, describeScope, type FileChangeStatus } from '@acra/git-providers-core';
import { buildReviewContext, type ReviewContext } from '@acra/repository-context';
import { type Command, InvalidArgumentError, Option } from 'commander';
import { type CliIO, formatBytes, paint } from '../core/cli-context';
import { resolveScope, type ScopeFlags } from '../core/scope';
import { type GlobalOptions, loadRepositoryConfig, openRepository, toCliError } from '../core/workspace';

interface ChangesOptions extends ScopeFlags {
  readonly format: 'text' | 'json';
  readonly diffContext?: number;
  readonly surrounding?: number;
  readonly showContext?: boolean;
}

const STATUS_LETTER: Record<FileChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
};

function nonNegativeInt(max: number) {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
      throw new InvalidArgumentError(`expected an integer between 0 and ${max}`);
    }
    return parsed;
  };
}

/**
 * `ai-review changes` — shows exactly which changes and how much surrounding code a review
 * would include. Purely local and read-only: nothing is sent anywhere.
 */
export function registerChangesCommand(program: Command, io: CliIO): void {
  program
    .command('changes')
    .description('preview what a review would include (read-only; nothing is sent anywhere)')
    .option('--staged', 'staged changes (index vs HEAD)')
    .option('--unstaged', 'unstaged changes (working tree vs index, incl. untracked files)')
    .option('--base <ref>', 'base branch/commit (default: detected base branch)')
    .option('--branch <ref>', 'compare another branch against --base without checking it out')
    .option('--all', 'committed + staged + unstaged + untracked changes not in base (default)')
    .option('--no-untracked', 'exclude untracked files')
    .option('--diff-context <lines>', 'unchanged lines inside the diff (git -U)', nonNegativeInt(50))
    .option(
      '--surrounding <lines>',
      'surrounding source lines per hunk (overrides ai-review.yaml)',
      nonNegativeInt(200),
    )
    .option('--show-context', 'print the surrounding source snippets (text format)')
    .addOption(new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'))
    .action(async (options: ChangesOptions, command: Command) => {
      const provider = await openRepository(io, command.optsWithGlobals<GlobalOptions>());
      try {
        const info = await provider.getRepositoryInfo();
        const { source, config } = await loadRepositoryConfig(provider);
        const scope = resolveScope(options, info);
        const changeSet = await provider.getChangeSet(
          scope,
          options.diffContext === undefined ? {} : { diffContextLines: options.diffContext },
        );
        const context = await buildReviewContext(changeSet, provider, {
          exclude: [...DEFAULT_EXCLUDE_GLOBS, ...config.review.exclude],
          budget: {
            ...config.review.context,
            ...(options.surrounding === undefined ? {} : { surroundingLines: options.surrounding }),
          },
        });

        if (options.format === 'json') {
          io.out(
            JSON.stringify(
              {
                repository: { rootPath: info.rootPath, currentBranch: info.currentBranch },
                configSource: source,
                context,
              },
              null,
              2,
            ),
          );
          return;
        }
        if (!config.review.enabled) {
          io.err(paint(io, 'yellow', 'Note: review.enabled is false in ai-review.yaml — reviews will be skipped.'));
        }
        printText(io, info.rootPath, info.currentBranch, source, context, options.showContext ?? false);
      } catch (error) {
        throw toCliError(error);
      }
    });
}

function printText(
  io: CliIO,
  rootPath: string,
  branch: string | null,
  configSource: 'file' | 'default',
  context: ReviewContext,
  showContext: boolean,
): void {
  const label = (text: string) => paint(io, 'dim', text.padEnd(12));
  io.out(`${label('Repository')}${rootPath}${branch ? ` (${branch})` : ''}`);
  io.out(`${label('Scope')}${describeScope(context.scope)}`);
  io.out(`${label('Compared')}${describeRevision(context.base)} → ${describeRevision(context.head)}`);
  io.out(`${label('Config')}${configSource === 'file' ? 'ai-review.yaml' : 'defaults'}`);
  io.out('');

  if (context.stats.changedFiles === 0) {
    io.out('No changes in this scope.');
    return;
  }

  io.out(paint(io, 'bold', `Included files (${context.files.length})`));
  const width = Math.min(60, Math.max(20, ...context.files.map((f) => displayPath(f.path, f.oldPath).length)));
  for (const file of context.files) {
    const counts = `${paint(io, 'green', `+${file.additions}`.padStart(5))} ${paint(io, 'red', `-${file.deletions}`.padStart(5))}`;
    const hunks = `${file.hunks.length} ${file.hunks.length === 1 ? 'hunk' : 'hunks'}`;
    io.out(
      `  ${STATUS_LETTER[file.status]}  ${displayPath(file.path, file.oldPath).padEnd(width)} ${counts}  ${hunks}`,
    );
    if (showContext) {
      for (const snippet of file.snippets) {
        io.out(
          paint(
            io,
            'dim',
            `     ── ${snippet.side === 'old' ? 'old ' : ''}lines ${snippet.startLine}–${snippet.endLine}`,
          ),
        );
        snippet.text.split('\n').forEach((line, index) => {
          io.out(paint(io, 'dim', `     ${String(snippet.startLine + index).padStart(5)} │ `) + line);
        });
      }
    }
  }

  if (context.omitted.length > 0) {
    io.out('');
    io.out(paint(io, 'bold', `Omitted (${context.omitted.length})`));
    for (const file of context.omitted) {
      const reason = file.reason.replace('_', ' ');
      io.out(
        `  ${STATUS_LETTER[file.status]}  ${file.path}  ${paint(io, 'yellow', reason)}${file.detail ? paint(io, 'dim', ` (${file.detail})`) : ''}`,
      );
    }
  }

  const { stats } = context;
  io.out('');
  io.out(
    `${label('Context')}${stats.includedFiles} files · ${stats.hunks} hunks · +${stats.additions} −${stats.deletions} · ${formatBytes(stats.contextBytes)} · sha256 ${context.contextHash.slice(0, 12)}`,
  );
  io.out(paint(io, 'dim', 'Preview only — nothing was sent to any AI provider or server.'));
}

function displayPath(path: string, oldPath: string | undefined): string {
  return oldPath ? `${path} ← ${oldPath}` : path;
}
