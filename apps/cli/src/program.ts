import { Command } from 'commander';
import { registerChangesCommand } from './commands/changes.command';
import { registerFindingsCommand, registerReportCommand } from './commands/findings.command';
import { registerInitCommand } from './commands/init.command';
import { registerReviewCommand } from './commands/review.command';
import { registerStatusCommand } from './commands/status.command';
import { type CliIO } from './core/cli-context';
import { createReviewers, type ReviewerFactory } from './core/reviewers';

export const CLI_NAME = 'ai-review';
export const CLI_VERSION = '0.3.0';

export interface CliDeps {
  /** Builds the AI reviewers; tests inject fakes so no real API is ever called. */
  readonly createReviewers: ReviewerFactory;
}

const defaultDeps: CliDeps = { createReviewers };

/**
 * Builds the `ai-review` command tree.
 *
 * Invariant for every command: the CLI never modifies, stages, commits or pushes code.
 * (`init` creates only ai-review.yaml on request; review history lives under .git/ai-review/.)
 */
export function buildProgram(io: CliIO, deps: CliDeps = defaultDeps): Command {
  const program = new Command()
    .name(CLI_NAME)
    .description('AI Code Review Agent — review local Git changes with Claude and GPT before opening an MR/PR.')
    .version(CLI_VERSION, '-v, --version', 'print the CLI version')
    .option('-C, --repo <path>', 'repository to operate on (default: current directory)')
    .showHelpAfterError()
    .configureHelp({ sortSubcommands: true })
    .configureOutput({ writeOut: (s) => io.out(s), writeErr: (s) => io.err(s) });

  registerInitCommand(program, io);
  registerStatusCommand(program, io);
  registerChangesCommand(program, io);
  registerReviewCommand(program, io, deps.createReviewers);
  registerFindingsCommand(program, io);
  registerReportCommand(program, io);
  return program;
}
