import { Command } from 'commander';
import { registerChangesCommand } from './commands/changes.command';
import { registerFindingsCommand, registerReportCommand } from './commands/findings.command';
import { type HostWriterFactory, registerFixCommands } from './commands/fix.command';
import { registerInitCommand } from './commands/init.command';
import { registerReviewCommand } from './commands/review.command';
import { registerStatusCommand } from './commands/status.command';
import { type CliIO } from './core/cli-context';
import { defaultHostWriter } from './core/host-writer';
import { createReviewers, type ReviewerFactory } from '@acra/ai-providers-factory';

export const CLI_NAME = 'ai-review';
export const CLI_VERSION = '0.4.0';

export interface CliDeps {
  /** Builds the AI reviewers; tests inject fakes so no real API is ever called. */
  readonly createReviewers: ReviewerFactory;
  /** Builds GitLab/GitHub writers for `fix open`; tests inject fakes. */
  readonly hostWriter?: HostWriterFactory;
}

const defaultDeps: CliDeps = { createReviewers, hostWriter: defaultHostWriter };

/**
 * Builds the `ai-review` command tree.
 *
 * Invariant: the CLI never modifies, stages, commits, pushes or opens an MR/PR without a human
 * approval of that exact operation (`fix apply|stage|commit|push|open`), and it never merges.
 * Fixes are applied in an isolated worktree on a new branch — the user's checkout is not touched.
 * (`init` creates only ai-review.yaml on request; history lives under .git/ai-review/.)
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
  registerFixCommands(program, io, {
    createReviewers: deps.createReviewers,
    hostWriter: deps.hostWriter ?? defaultHostWriter,
  });
  return program;
}
