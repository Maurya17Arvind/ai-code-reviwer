import { REVIEW_CONFIG_FILENAME } from '@acra/configuration';
import { type Command, Option } from 'commander';
import { CliError, type CliIO, paint } from '../core/cli-context';
import { type GlobalOptions, loadRepositoryConfig, openRepository } from '../core/workspace';

interface StatusOptions {
  readonly format: 'text' | 'json';
}

export function registerStatusCommand(program: Command, io: CliIO): void {
  program
    .command('status')
    .description('show repository, branch, base branch, configuration and pending changes')
    .addOption(new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'))
    .action(async (options: StatusOptions, command: Command) => {
      const provider = await openRepository(io, command.optsWithGlobals<GlobalOptions>());
      const info = await provider.getRepositoryInfo();

      let config: { status: 'file' | 'default' | 'invalid'; problems?: readonly string[] };
      try {
        config = { status: (await loadRepositoryConfig(provider)).source };
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        config = {
          status: 'invalid',
          problems: error.message
            .split('\n')
            .slice(1)
            .map((line) => line.trim()),
        };
      }

      const staged = (await provider.getChangeSet({ kind: 'staged' })).files;
      const worktree = (await provider.getChangeSet({ kind: 'unstaged', includeUntracked: true })).files;
      const untracked = worktree.filter((file) => file.status === 'added').length;
      const counts = { staged: staged.length, unstaged: worktree.length - untracked, untracked };

      if (options.format === 'json') {
        io.out(JSON.stringify({ repository: info, config, changes: counts }, null, 2));
        return;
      }

      const label = (text: string) => paint(io, 'dim', text.padEnd(12));
      io.out(`${label('Repository')}${info.rootPath}`);
      io.out(`${label('Branch')}${info.currentBranch ?? paint(io, 'yellow', '(detached HEAD)')}`);
      io.out(`${label('HEAD')}${info.headSha?.slice(0, 12) ?? paint(io, 'yellow', '(no commits)')}`);
      io.out(`${label('Base')}${info.defaultBaseBranch ?? paint(io, 'yellow', 'not detected — pass --base <ref>')}`);
      io.out(`${label('Remote')}${info.remoteUrl ?? '(none)'}`);
      io.out(
        `${label('Config')}${
          config.status === 'file'
            ? `${REVIEW_CONFIG_FILENAME} ${paint(io, 'green', '(valid)')}`
            : config.status === 'default'
              ? `defaults (no ${REVIEW_CONFIG_FILENAME}; run \`ai-review init\`)`
              : paint(io, 'red', `${REVIEW_CONFIG_FILENAME} is invalid`)
        }`,
      );
      for (const problem of config.problems ?? []) io.out(`            ${problem}`);
      io.out(
        `${label('Changes')}${counts.staged} staged · ${counts.unstaged} unstaged · ${counts.untracked} untracked`,
      );
    });
}
