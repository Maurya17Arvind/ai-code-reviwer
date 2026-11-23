import { CommanderError } from 'commander';
import { CliError, type CliIO } from '../core/cli-context';
import { buildProgram } from '../program';

export interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Runs the CLI in-process with captured output — mirrors main.ts error handling. */
export async function runCli(args: string[], cwd: string): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const io: CliIO = {
    cwd,
    color: false,
    out: (text) => (stdout += text.endsWith('\n') ? text : `${text}\n`),
    err: (text) => (stderr += text.endsWith('\n') ? text : `${text}\n`),
  };
  let exitCode = 0;
  try {
    await buildProgram(io).exitOverride().parseAsync(args, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) exitCode = error.exitCode;
    else if (error instanceof CliError) {
      stderr += `error: ${error.message}\n`;
      exitCode = error.exitCode;
    } else throw error;
  }
  return { stdout, stderr, exitCode };
}
