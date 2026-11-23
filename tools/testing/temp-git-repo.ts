import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Throwaway Git repository for tests. Uses the git CLI directly (independent of the code
 * under test), isolated from the developer's global git configuration.
 */
export class TempGitRepo {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static create(options: { initialBranch?: string } = {}): TempGitRepo {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'acra-git-')));
    const repo = new TempGitRepo(root);
    repo.git('init', '--quiet', `--initial-branch=${options.initialBranch ?? 'main'}`);
    repo.git('config', 'user.name', 'Test User');
    repo.git('config', 'user.email', 'test@example.com');
    repo.git('config', 'core.autocrlf', 'false');
    repo.git('config', 'commit.gpgsign', 'false');
    return repo;
  }

  git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(this.root, '.no-global-config') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  write(path: string, content: string | Buffer): this {
    const absolute = join(this.root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    return this;
  }

  commit(message: string, ...paths: string[]): string {
    this.git('add', ...(paths.length > 0 ? paths : ['-A']));
    this.git('commit', '--quiet', '-m', message);
    return this.git('rev-parse', 'HEAD').trim();
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
