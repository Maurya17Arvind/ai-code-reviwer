import { Command } from 'commander';
import { registerChangesCommand } from './commands/changes.command';
import { registerInitCommand } from './commands/init.command';
import { registerStatusCommand } from './commands/status.command';
import { type CliIO } from './core/cli-context';

export const CLI_NAME = 'ai-review';
export const CLI_VERSION = '0.2.0';

/**
 * Builds the `ai-review` command tree.
 *
 * Phase 2: `init`, `status`, `changes`. `review`, `findings` and `report` need the AI review
 * engine and arrive in Phase 3 — they are intentionally not registered as placeholders.
 *
 * Invariant for every command: the CLI never modifies, stages, commits or pushes code.
 * (`init` creates only ai-review.yaml, on explicit request.)
 */
export function buildProgram(io: CliIO): Command {
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
  return program;
}
