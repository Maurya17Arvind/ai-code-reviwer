import { styleText } from 'node:util';

/** I/O boundary of the CLI. Commands never touch process.stdout/exit directly (testability). */
export interface CliIO {
  readonly cwd: string;
  readonly color: boolean;
  out(text: string): void;
  err(text: string): void;
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
  return {
    cwd: process.cwd(),
    color,
    out: (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    err: (text) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
