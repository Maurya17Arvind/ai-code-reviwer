import { GitProviderError } from '@acra/git-providers-core';
import { resolveInsideRepo } from '@acra/security';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const FIX_BRANCH = /^ai-review\/fix-[0-9a-f]{8,40}$/;
const REMOTE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Write-side Git operations for one fix, each called only after its approval was verified
 * (the caller passes the approved values). Isolation and hardening:
 *
 *  - Everything happens in a dedicated linked worktree under `<git-dir>/ai-review/worktrees/`, on a
 *    new `ai-review/fix-*` branch created from the reviewed commit. The user's checkout, index and
 *    current branch are never touched.
 *  - Repository hooks are disabled (`core.hooksPath` → an empty directory): hooks are repository code
 *    and would otherwise run on checkout, commit and push without having been approved.
 *  - Signing programs are not invoked (`commit.gpgsign=false`); fsmonitor is disabled.
 *  - Pushes name one exact refspec and never force. There is no merge, rebase or reset.
 */
export class LocalFixWorkspace {
  private constructor(
    readonly directory: string,
    readonly branch: string,
    private readonly git: SimpleGit,
    private readonly mainGit: SimpleGit,
  ) {}

  private static hardenedGit(baseDir: string, hooksDir: string): SimpleGit {
    return simpleGit({
      baseDir,
      binary: 'git',
      trimmed: false,
      strict: true,
      config: [
        `core.hooksPath=${hooksDir}`,
        'core.fsmonitor=false',
        'commit.gpgsign=false',
        'tag.gpgsign=false',
        'core.quotePath=false',
        'color.ui=false',
      ],
      allowConfig: ['core.hooksPath', 'core.fsmonitor', 'commit.gpgsign', 'tag.gpgsign'],
      timeout: { block: 120_000 },
    });
  }

  private static paths(gitDirectory: string, fixId: string) {
    const id = fixId
      .replace(/[^0-9a-f]/gi, '')
      .slice(0, 12)
      .toLowerCase();
    if (id.length < 8) throw new GitProviderError('Invalid fix id', 'UNSAFE_REF');
    const root = join(gitDirectory, 'ai-review');
    return { directory: join(root, 'worktrees', id), hooks: join(root, 'no-hooks') };
  }

  /** Creates the worktree and branch at `baseSha`. Refuses when the branch already exists. */
  static async create(input: {
    repoRoot: string;
    gitDirectory: string;
    fixId: string;
    branch: string;
    baseSha: string;
  }): Promise<LocalFixWorkspace> {
    if (!FIX_BRANCH.test(input.branch)) throw new GitProviderError('Not a fix branch name', 'UNSAFE_REF');
    if (!SHA.test(input.baseSha)) throw new GitProviderError('Base must be a full commit id', 'UNSAFE_REF');
    const { directory, hooks } = LocalFixWorkspace.paths(input.gitDirectory, input.fixId);
    await mkdir(hooks, { recursive: true, mode: 0o700 });
    const main = LocalFixWorkspace.hardenedGit(input.repoRoot, hooks);
    const exists = await main.raw(['branch', '--list', input.branch]);
    if (exists.trim() !== '') {
      throw new GitProviderError(`Branch ${input.branch} already exists; discard the fix first`, 'GIT_FAILED');
    }
    await run(main, ['worktree', 'add', '--quiet', '-b', input.branch, directory, input.baseSha]);
    return new LocalFixWorkspace(directory, input.branch, LocalFixWorkspace.hardenedGit(directory, hooks), main);
  }

  /** Re-opens the worktree of a fix created earlier (by the same CLI). */
  static async open(input: { repoRoot: string; gitDirectory: string; fixId: string; branch: string }) {
    if (!FIX_BRANCH.test(input.branch)) throw new GitProviderError('Not a fix branch name', 'UNSAFE_REF');
    const { directory, hooks } = LocalFixWorkspace.paths(input.gitDirectory, input.fixId);
    const git = LocalFixWorkspace.hardenedGit(directory, hooks);
    const branch = (await run(git, ['symbolic-ref', '--short', 'HEAD'])).trim();
    if (branch !== input.branch) throw new GitProviderError('Fix worktree is not on the fix branch', 'GIT_FAILED');
    return new LocalFixWorkspace(directory, input.branch, git, LocalFixWorkspace.hardenedGit(input.repoRoot, hooks));
  }

  /** Applies the exact approved patch bytes to the working tree (not the index). */
  async applyPatch(patch: string): Promise<void> {
    const file = join(this.directory, '..', `${this.directory.split(/[\\/]/).at(-1)}.patch`);
    await writeFile(file, patch, { mode: 0o600 });
    try {
      await run(this.git, ['apply', '--check', '--whitespace=nowarn', file]);
      await run(this.git, ['apply', '--whitespace=nowarn', file]);
    } finally {
      await rm(file, { force: true });
    }
  }

  async fileSha256(path: string): Promise<string> {
    const content = await readFile(resolveInsideRepo(this.directory, path));
    return createHash('sha256').update(content).digest('hex');
  }

  /** Paths with changes in the worktree (porcelain, NUL separated). */
  async changedPaths(): Promise<{ staged: string[]; unstaged: string[] }> {
    const out = await run(this.git, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const staged: string[] = [];
    const unstaged: string[] = [];
    for (const entry of out.split('\0').filter((e) => e.length > 3)) {
      const [x, y, path] = [entry[0], entry[1], entry.slice(3)];
      if (x !== ' ' && x !== '?') staged.push(path);
      if (y !== ' ') unstaged.push(path);
    }
    return { staged, unstaged };
  }

  async stage(paths: readonly string[]): Promise<void> {
    for (const path of paths) resolveInsideRepo(this.directory, path);
    await run(this.git, ['add', '--', ...paths]);
  }

  async head(): Promise<string> {
    return (await run(this.git, ['rev-parse', 'HEAD'])).trim();
  }

  /** Commits the index. Returns the new commit id. */
  async commit(message: string): Promise<string> {
    const before = await this.head();
    await run(this.git, ['commit', '--quiet', '--no-edit', '-m', message]);
    const after = await this.head();
    // git can exit non-zero without stderr (e.g. nothing to commit); verify a commit was made.
    if (after === before) throw new GitProviderError('git commit did not create a commit', 'GIT_FAILED');
    return after;
  }

  /** Pushes exactly `commitSha` as the fix branch. Never forces; fails if the remote branch exists. */
  async push(remote: string, commitSha: string): Promise<void> {
    if (!REMOTE.test(remote)) throw new GitProviderError('Invalid remote name', 'UNSAFE_REF');
    if (!SHA.test(commitSha) || (await this.head()) !== commitSha) {
      throw new GitProviderError('The fix branch is not at the approved commit', 'GIT_FAILED');
    }
    await run(this.git, ['push', '--porcelain', remote, `${commitSha}:refs/heads/${this.branch}`]);
  }

  async remoteUrl(remote: string): Promise<string | null> {
    if (!REMOTE.test(remote)) return null;
    try {
      return (await this.mainGit.raw(['remote', 'get-url', remote])).trim() || null;
    } catch {
      return null;
    }
  }

  /** Removes the worktree; deletes the local branch too when asked (only our own fix branches). */
  async discard(options: { deleteBranch: boolean }): Promise<void> {
    await run(this.mainGit, ['worktree', 'remove', '--force', this.directory]).catch(() => undefined);
    await run(this.mainGit, ['worktree', 'prune']);
    if (options.deleteBranch) await run(this.mainGit, ['branch', '-D', this.branch]);
  }
}

async function run(git: SimpleGit, args: string[]): Promise<string> {
  try {
    return await git.raw(args);
  } catch (error) {
    const message = error instanceof Error ? (error.message.split('\n').find((l) => l.trim() !== '') ?? '') : '';
    throw new GitProviderError(`git ${args[0] ?? ''} failed: ${message.slice(0, 300)}`, 'GIT_FAILED');
  }
}
