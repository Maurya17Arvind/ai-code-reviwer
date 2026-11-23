import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';

/** I/O boundary of the CLI. Commands never touch process.stdout/env/exit directly (testability). */
export interface CliIO {
  readonly cwd: string;
  readonly color: boolean;
  /** Process environment (injected so tests never depend on the developer's real keys). */
  readonly env: Readonly<Record<string, string | undefined>>;
  out(text: string): void;
  err(text: string): void;
  /** Asks a yes/no question; undefined when no interactive terminal is available. */
  readonly confirm?: (question: string) => Promise<boolean>;
}

/** Expected failure with a user-facing message and exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

type Style = Parameters<typeof styleText>[0];

export function paint(io: CliIO, style: Style, text: string): string {
  return io.color ? styleText(style, text, { validateStream: false }) : text;
}

export function processIO(): CliIO {
  const color = Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env) && process.env['TERM'] !== 'dumb';
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    cwd: process.cwd(),
    color,
    env: process.env,
    out: (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    err: (text) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
    ...(interactive
      ? {
          confirm: async (question: string) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
            } finally {
              rl.close();
            }
          },
        }
      : {}),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
