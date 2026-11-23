import { CommanderError } from 'commander';
import { buildProgram, CLI_NAME, CLI_VERSION } from './program';

function run(args: string[]) {
  let output = '';
  const program = buildProgram()
    .exitOverride()
    .configureOutput({ writeOut: (s) => (output += s), writeErr: (s) => (output += s) });
  let error: CommanderError | undefined;
  try {
    program.parse(args, { from: 'user' });
  } catch (e) {
    error = e as CommanderError;
  }
  return { output, error };
}

describe('ai-review program', () => {
  it('prints the version', () => {
    const { output, error } = run(['--version']);
    expect(output.trim()).toBe(CLI_VERSION);
    expect(error?.code).toBe('commander.version');
  });

  it('prints help with the CLI name', () => {
    const { output, error } = run(['--help']);
    expect(output).toContain(`Usage: ${CLI_NAME}`);
    expect(error?.code).toBe('commander.helpDisplayed');
  });

  it('rejects unknown commands instead of silently succeeding', () => {
    const { error } = run(['push']);
    expect(error).toBeInstanceOf(CommanderError);
    expect(error?.exitCode).toBe(1);
  });
});
