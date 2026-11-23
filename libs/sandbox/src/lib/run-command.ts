import { spawn } from 'node:child_process';
import { type CommandArgv, validateCommand, WINDOWS_SHIM_PROGRAMS } from './command-policy';

export interface RunOptions {
  /** Working directory: the isolated fix worktree, never the user's checkout. */
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Bytes of combined stdout/stderr kept (the tail). */
  readonly maxOutputBytes?: number;
  /** Source environment to filter (default process.env). Only allowlisted variables pass. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

export interface CommandResult {
  readonly argv: CommandArgv;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Tail of combined output. */
  readonly output: string;
  readonly truncated: boolean;
  readonly passed: boolean;
}

/**
 * Variables a toolchain needs to start. Everything else — API keys, tokens, DATABASE_URL, cloud
 * credentials — is withheld from repository code.
 */
const ENV_ALLOWLIST = new Set(
  [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'COMSPEC',
    'WINDIR',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMDATA',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TZ',
    'GOPATH',
    'GOCACHE',
    'CARGO_HOME',
    'RUSTUP_HOME',
    'DOTNET_ROOT',
  ].map((k) => k.toUpperCase()),
);

export function sandboxEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' };
}

/**
 * Runs one allowlisted validation command. No shell is involved except cmd.exe for Windows .cmd
 * shims, and then only with arguments already restricted to characters cmd does not interpret.
 * Enforced: time limit (process tree killed), output cap, filtered environment.
 *
 * Not enforced here: network or filesystem isolation. The command runs as the current user in
 * the fix worktree — which is why it must be approved by a human first. Server deployments do
 * not run validation commands (see ADR-033).
 */
export function runValidationCommand(argv: CommandArgv, options: RunOptions): Promise<CommandResult> {
  validateCommand(argv);
  const [program, ...args] = argv;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const maxOutput = options.maxOutputBytes ?? 64_000;
  const started = Date.now();
  const useShell = platform === 'win32' && WINDOWS_SHIM_PROGRAMS.has(program ?? '');

  return new Promise((resolvePromise) => {
    const child = spawn(program ?? '', args, {
      cwd: options.cwd,
      env: sandboxEnv(options.env ?? process.env),
      shell: useShell,
      windowsHide: true,
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let truncated = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > maxOutput) {
        output = output.slice(-maxOutput);
        truncated = true;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, platform);
    }, timeoutMs);

    const finish = (exitCode: number | null, error?: Error) => {
      clearTimeout(timer);
      if (error) append(Buffer.from(`\n[failed to start: ${error.message}]\n`));
      resolvePromise({
        argv,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        output,
        truncated,
        passed: !timedOut && exitCode === 0,
      });
    };
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code));
  });
}

function killTree(pid: number | undefined, platform: NodeJS.Platform): void {
  if (!pid) return;
  try {
    if (platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // already exited
  }
}
