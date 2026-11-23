/**
 * Which validation commands may run after a fix is applied. Commands come from `ai-review.yaml`
 * (untrusted) or the CLI, are parsed into argv without a shell, must match this allowlist, and are
 * shown verbatim in the approval the human gives — so nothing runs that a person did not see.
 *
 * Allowed: test / lint / build entry points of common toolchains. Not allowed: anything that
 * installs, downloads or executes arbitrary code by design (npx, dlx, exec, node -e, sh, make, …).
 */
export type CommandArgv = readonly string[];

export class CommandPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandPolicyError';
  }
}

const SAFE_WORD = /^[A-Za-z0-9@%+:,./_=-]+$/;
const FLAG = /^--?[A-Za-z0-9][A-Za-z0-9-]*(=[A-Za-z0-9@%+:,./_-]*)?$/;
const SCRIPT = /^[A-Za-z0-9:_.-]{1,100}$/;
/** Flags that redirect a package manager to other code, registries or directories. */
const DENIED_FLAGS =
  /^--?(prefix|registry|userconfig|globalconfig|dir|C|workspace-root|global|g|location|cache|config|require|r|loader|import|eval|e|print|p)(=|$)/;

interface ProgramRule {
  /** First argument must be one of these. `run` additionally needs a script name. */
  readonly subcommands: readonly string[];
}

const RULES: Readonly<Record<string, ProgramRule>> = {
  npm: { subcommands: ['test', 'run'] },
  pnpm: { subcommands: ['test', 'run'] },
  yarn: { subcommands: ['test', 'run'] },
  go: { subcommands: ['test', 'vet', 'build'] },
  cargo: { subcommands: ['test', 'check', 'clippy', 'build'] },
  dotnet: { subcommands: ['test', 'build'] },
  pytest: { subcommands: [] },
};

/** Programs that are `.cmd` shims on Windows (need cmd.exe to start). */
export const WINDOWS_SHIM_PROGRAMS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn']);

export function parseCommand(command: string): CommandArgv {
  const argv = command
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '');
  validateCommand(argv);
  return argv;
}

export function validateCommand(argv: CommandArgv): void {
  if (argv.length === 0 || argv.length > 20) throw new CommandPolicyError('Command must have 1–20 arguments');
  const [program, ...args] = argv;
  if (!program) throw new CommandPolicyError('Empty command');
  const rule = RULES[program];
  if (!rule) {
    throw new CommandPolicyError(
      `"${program.slice(0, 40)}" is not an allowed validation program (allowed: ${Object.keys(RULES).join(', ')})`,
    );
  }
  for (const arg of args) {
    if (arg.length > 200 || !(SAFE_WORD.test(arg) || FLAG.test(arg))) {
      throw new CommandPolicyError(`Argument "${arg.slice(0, 40)}" contains characters that are not allowed`);
    }
    if (arg.startsWith('-') && DENIED_FLAGS.test(arg)) {
      throw new CommandPolicyError(`Flag "${arg.slice(0, 40)}" is not allowed in validation commands`);
    }
    if (!arg.startsWith('-') && (arg.startsWith('/') || /^[A-Za-z]:/.test(arg) || arg.split(/[\\/]/).includes('..'))) {
      throw new CommandPolicyError(`Path "${arg.slice(0, 40)}" must stay inside the repository`);
    }
  }
  if (rule.subcommands.length > 0) {
    const sub = args[0];
    if (!sub || !rule.subcommands.includes(sub)) {
      throw new CommandPolicyError(`${program} may only run: ${rule.subcommands.join(', ')}`);
    }
    if (sub === 'run' && !(args[1] && SCRIPT.test(args[1]))) {
      throw new CommandPolicyError(`${program} run needs a script name`);
    }
  }
}
