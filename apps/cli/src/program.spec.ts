import { CLI_NAME, CLI_VERSION } from './program';
import { runCli } from './testing/run-cli';

describe('ai-review program', () => {
  it('prints the version', async () => {
    const result = await runCli(['--version'], process.cwd());
    expect(result.stdout.trim()).toBe(CLI_VERSION);
    expect(result.exitCode).toBe(0);
  });

  it('lists all commands in help', async () => {
    const result = await runCli(['--help'], process.cwd());
    expect(result.stdout).toContain(`Usage: ${CLI_NAME}`);
    for (const command of ['init', 'status', 'changes', 'review', 'findings', 'report', 'dismiss'])
      expect(result.stdout).toContain(command);
    expect(result.stdout).toContain('--repo <path>');
  });

  it('rejects unknown commands — and has no commands that mutate git state', async () => {
    for (const command of ['push', 'commit', 'merge', 'apply']) {
      const result = await runCli([command], process.cwd());
      expect(result.exitCode).toBe(1);
    }
  });
});
