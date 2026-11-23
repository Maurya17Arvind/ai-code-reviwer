import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runValidationCommand } from './run-command';

describe('runValidationCommand (real npm)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'acra-sandbox-'));
    writeFileSync(
      join(dir, 'check.js'),
      [
        "const leaked = ['ANTHROPIC_API_KEY', 'GITLAB_TOKEN', 'DATABASE_URL'].filter((k) => process.env[k]);",
        "console.log('leaked=' + leaked.join(',') + ' ci=' + process.env.CI);",
        "process.exit(process.argv[2] === 'fail' ? 3 : 0);",
      ].join('\n'),
    );
    writeFileSync(join(dir, 'sleep.js'), 'setTimeout(() => {}, 60000);');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'sandbox-fixture',
        private: true,
        scripts: {
          test: 'node check.js',
          'test:fail': 'node check.js fail',
          hang: 'node sleep.js',
          loud: 'node -e "for(let i=0;i<5000;i++)console.log(i)"',
        },
      }),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
    GITLAB_TOKEN: 'glpat-should-not-leak',
    DATABASE_URL: 'postgres://x',
  };

  it('runs an allowed command without leaking secrets from the environment', async () => {
    const result = await runValidationCommand(['npm', 'test'], { cwd: dir, env });
    expect(result).toMatchObject({ exitCode: 0, passed: true, timedOut: false });
    expect(result.output).toContain('leaked= ci=true');
  }, 60_000);

  it('reports failures with the exit code', async () => {
    const result = await runValidationCommand(['npm', 'run', 'test:fail'], { cwd: dir, env });
    expect(result).toMatchObject({ exitCode: 3, passed: false });
  }, 60_000);

  it('kills commands that exceed the time limit', async () => {
    const result = await runValidationCommand(['npm', 'run', 'hang'], { cwd: dir, env, timeoutMs: 3_000 });
    expect(result).toMatchObject({ timedOut: true, passed: false });
    expect(result.durationMs).toBeLessThan(30_000);
  }, 60_000);

  it('keeps only the tail of large output', async () => {
    const result = await runValidationCommand(['npm', 'run', 'loud'], { cwd: dir, env, maxOutputBytes: 2_000 });
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(2_000);
    expect(result.output).toContain('4999');
  }, 60_000);

  it('refuses commands outside the policy before spawning anything', () => {
    expect(() => runValidationCommand(['npx', 'evil'], { cwd: dir })).toThrow(/not an allowed/);
  });
});
