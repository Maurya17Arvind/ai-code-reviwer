import { Command } from 'commander';

export const CLI_NAME = 'ai-review';
export const CLI_VERSION = '0.1.0';

/**
 * Builds the `ai-review` command tree.
 *
 * Phase 1 ships only the program shell (--help, --version). Review commands
 * (`init`, `review`, `findings`, `report`) are added in Phase 2 together with the
 * local Git adapter — they are intentionally not registered as placeholders.
 *
 * Invariant for every future command: the CLI never modifies, stages, commits or pushes code.
 */
export function buildProgram(): Command {
  return new Command()
    .name(CLI_NAME)
    .description('AI Code Review Agent — review local Git changes with Claude and GPT before opening an MR/PR.')
    .version(CLI_VERSION, '-v, --version', 'print the CLI version')
    .showHelpAfterError()
    .configureHelp({ sortSubcommands: true });
}
