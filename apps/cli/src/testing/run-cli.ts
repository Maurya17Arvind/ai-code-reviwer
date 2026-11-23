import { CommanderError } from 'commander';
import { CliError, type CliIO } from '../core/cli-context';
import { buildProgram, type CliDeps } from '../program';

export interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RunOptions {
  readonly deps?: CliDeps;
  readonly env?: Record<string, string | undefined>;
  /** Simulates an interactive terminal answering the consent prompt. */
  readonly confirm?: (question: string) => Promise<boolean>;
}

/** Runs the CLI in-process with captured output — mirrors main.ts error handling. */
export async function runCli(args: string[], cwd: string, options: RunOptions = {}): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const io: CliIO = {
    cwd,
    color: false,
    env: options.env ?? {},
    out: (text) => (stdout += text.endsWith('\n') ? text : `${text}\n`),
    err: (text) => (stderr += text.endsWith('\n') ? text : `${text}\n`),
    ...(options.confirm ? { confirm: options.confirm } : {}),
  };
  let exitCode = 0;
  try {
    await buildProgram(io, options.deps).exitOverride().parseAsync(args, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) exitCode = error.exitCode;
    else if (error instanceof CliError) {
      stderr += `error: ${error.message}\n`;
      exitCode = error.exitCode;
    } else throw error;
  }
  return { stdout, stderr, exitCode };
}
