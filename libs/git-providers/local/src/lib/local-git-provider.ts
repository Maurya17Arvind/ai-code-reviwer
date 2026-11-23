import {
  type ChangedFile,
  type ChangeScope,
  type ChangeSet,
  type CommitDetails,
  type FileContent,
  GitProviderError,
  type GetChangeSetOptions,
  type RepositoryInfo,
  type RepositoryReader,
  type Revision,
} from '@acra/git-providers-core';
import { parseUnifiedDiff } from '@acra/repository-context';
import {
  assertSafeGitRef,
  maskUrlCredentials,
  normalizeRepoRelativePath,
  resolveInsideRepo,
  UnsafeGitRefError,
  UnsafePathError,
} from '@acra/security';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

export interface LocalGitProviderOptions {
  /** Files larger than this are reported as `tooLarge` and not loaded. Default 1 MB. */
  readonly maxFileBytes?: number;
  /** Per-git-process inactivity timeout. Default 30 s. */
  readonly timeoutMs?: number;
  /** Upper bound for a single diff output. Default 50 MB. */
  readonly maxDiffBytes?: number;
}

const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BINARY_SNIFF_BYTES = 8_000;

/**
 * Git configuration forced on every command. Repository-local `.git/config` is not trusted:
 * - core.fsmonitor can name a program that git runs during status/diff → disabled.
 * - quoting, prefixes, colour and relative diffs are pinned so output is always parseable.
 * External diff drivers and textconv filters are disabled per command (--no-ext-diff, --no-textconv).
 */
const FORCED_CONFIG = [
  'core.fsmonitor=false',
  'core.quotePath=false',
  'color.ui=false',
  'diff.noprefix=false',
  'diff.mnemonicPrefix=false',
  'diff.relative=false',
];

/**
 * Read-only access to a local Git repository via the git CLI (through simple-git, which spawns
 * git without a shell). Never modifies the repository, index or working tree.
 */
export class LocalGitProvider implements RepositoryReader {
  private objectFormat: 'sha1' | 'sha256' | undefined;

  private constructor(
    readonly rootPath: string,
    private readonly git: SimpleGit,
    private readonly options: Required<LocalGitProviderOptions>,
  ) {}

  /** Opens the repository containing `path` (any sub-directory works). */
  static async open(path: string, options: LocalGitProviderOptions = {}): Promise<LocalGitProvider> {
    const resolved: Required<LocalGitProviderOptions> = {
      maxFileBytes: options.maxFileBytes ?? 1_000_000,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxDiffBytes: options.maxDiffBytes ?? 50_000_000,
    };
    const directory = resolve(path);
    try {
      const stats = await stat(directory);
      if (!stats.isDirectory()) throw new Error('not a directory');
    } catch {
      throw new GitProviderError(`Directory not found: ${directory}`, 'NOT_A_REPOSITORY');
    }

    let root: string;
    try {
      root = (await createGit(directory, resolved).raw(['rev-parse', '--show-toplevel'])).trim();
    } catch {
      throw new GitProviderError(`Not a Git repository: ${directory}`, 'NOT_A_REPOSITORY');
    }
    if (root === '') throw new GitProviderError(`Not a Git working tree: ${directory}`, 'NOT_A_REPOSITORY');
    return new LocalGitProvider(root, createGit(root, resolved), resolved);
  }

  async getRepositoryInfo(): Promise<RepositoryInfo> {
    const [branch, head, base, remote] = await Promise.all([
      this.tryRun(['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.tryRun(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
      this.detectBaseBranch(),
      this.tryRun(['remote', 'get-url', 'origin']),
    ]);
    return {
      rootPath: this.rootPath,
      currentBranch: emptyToNull(branch),
      headSha: emptyToNull(head),
      defaultBaseBranch: base,
      remoteUrl: remote === null ? null : sanitizeRemoteUrl(remote.trim()),
    };
  }

  async getChangeSet(scope: ChangeScope, options: GetChangeSetOptions = {}): Promise<ChangeSet> {
    const contextLines = Math.min(Math.max(options.diffContextLines ?? 3, 0), 50);
    const diffArgs = [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      `--unified=${contextLines}`,
    ];

    switch (scope.kind) {
      case 'staged': {
        const head = (await this.headSha()) ?? (await this.emptyTree());
        const files = await this.diff([...diffArgs, '--cached', head, '--']);
        return { scope, base: { kind: 'commit', sha: head }, head: { kind: 'index' }, files };
      }
      case 'unstaged': {
        const files = await this.diff([...diffArgs, '--']);
        if (scope.includeUntracked) files.push(...(await this.untrackedFiles()));
        return { scope, base: { kind: 'index' }, head: { kind: 'worktree' }, files };
      }
      case 'committed': {
        const head = await this.requireHead();
        const mergeBase = await this.mergeBase(await this.resolveCommit(scope.base), head);
        const files = await this.diff([...diffArgs, mergeBase, head, '--']);
        return { scope, base: { kind: 'commit', sha: mergeBase }, head: { kind: 'commit', sha: head }, files };
      }
      case 'branch': {
        const head = await this.resolveCommit(scope.head);
        const mergeBase = await this.mergeBase(await this.resolveCommit(scope.base), head);
        const files = await this.diff([...diffArgs, mergeBase, head, '--']);
        return { scope, base: { kind: 'commit', sha: mergeBase }, head: { kind: 'commit', sha: head }, files };
      }
      case 'all': {
        const head = await this.requireHead();
        const mergeBase = await this.mergeBase(await this.resolveCommit(scope.base), head);
        // `git diff <commit>` compares the commit with the working tree: committed + staged + unstaged.
        const files = await this.diff([...diffArgs, mergeBase, '--']);
        if (scope.includeUntracked) files.push(...(await this.untrackedFiles()));
        return { scope, base: { kind: 'commit', sha: mergeBase }, head: { kind: 'worktree' }, files };
      }
    }
  }

  async readFile(path: string, revision: Revision): Promise<FileContent | null> {
    const normalized = this.safePath(path);
    if (revision.kind === 'worktree') return this.readWorktreeFile(normalized);

    if (revision.kind === 'commit' && !OBJECT_ID.test(revision.sha)) {
      throw new GitProviderError('Invalid commit id', 'UNSAFE_REF');
    }
    const spec = revision.kind === 'index' ? `:${normalized}` : `${revision.sha}:${normalized}`;
    const type = await this.tryRun(['cat-file', '-t', spec]);
    if (type?.trim() !== 'blob') return null; // missing, directory (tree) or submodule (commit)

    const sizeBytes = Number((await this.run(['cat-file', '-s', spec])).trim());
    if (sizeBytes > this.options.maxFileBytes) {
      return { path: normalized, revision, sizeBytes, isBinary: false, content: '', tooLarge: true };
    }
    const content = await this.run(['cat-file', 'blob', spec]);
    const isBinary = content.slice(0, BINARY_SNIFF_BYTES).includes('\u0000');
    return { path: normalized, revision, sizeBytes, isBinary, content: isBinary ? '' : content, tooLarge: false };
  }

  async getCommitDetails(ref: string): Promise<CommitDetails> {
    const sha = await this.resolveCommit(ref);
    const output = await this.run(['show', '-s', '--no-color', '--format=%H%x00%an%x00%ae%x00%aI%x00%s%x00%b', sha]);
    const [fullSha = sha, authorName = '', authorEmail = '', authoredAt = '', subject = '', body = ''] =
      output.split('\u0000');
    return { sha: fullSha.trim(), authorName, authorEmail, authoredAt, subject, body: body.trimEnd() };
  }

  /**
   * Absolute path of the repository's .git directory (read-only query). Used by the CLI to keep
   * local review history outside the working tree, where it is never committed.
   */
  async getGitDirectory(): Promise<string> {
    const dir = emptyToNull(await this.tryRun(['rev-parse', '--absolute-git-dir']));
    if (!dir) throw new GitProviderError('Could not locate the .git directory', 'GIT_FAILED');
    return dir;
  }

  /** Resolves a user-supplied revision to a full commit id. */
  async resolveCommit(ref: string): Promise<string> {
    try {
      assertSafeGitRef(ref);
    } catch (error) {
      throw new GitProviderError(
        error instanceof UnsafeGitRefError ? error.message : 'Invalid reference',
        'UNSAFE_REF',
      );
    }
    const sha = await this.tryRun(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    if (!sha?.trim()) throw new GitProviderError(`Unknown revision: ${ref}`, 'UNKNOWN_REF');
    return sha.trim();
  }

  // ---------------------------------------------------------------------------

  private async detectBaseBranch(): Promise<string | null> {
    const originHead = emptyToNull(
      await this.tryRun(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
    );
    if (originHead) return originHead;
    for (const name of ['main', 'master', 'develop', 'trunk']) {
      if (await this.refExists(`refs/heads/${name}`)) return name;
    }
    for (const name of ['main', 'master', 'develop', 'trunk']) {
      if (await this.refExists(`refs/remotes/origin/${name}`)) return `origin/${name}`;
    }
    return null;
  }

  private async refExists(fullRef: string): Promise<boolean> {
    // Note: simple-git does not reject when git exits non-zero without writing to stderr
    // (as `--quiet` commands do), so existence is decided by the output, never by "no error".
    return emptyToNull(await this.tryRun(['rev-parse', '--verify', '--quiet', fullRef])) !== null;
  }

  private async headSha(): Promise<string | null> {
    return emptyToNull(await this.tryRun(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']));
  }

  private async requireHead(): Promise<string> {
    const head = await this.headSha();
    if (!head) throw new GitProviderError('The repository has no commits yet', 'NO_COMMITS');
    return head;
  }

  private async mergeBase(a: string, b: string): Promise<string> {
    const base = await this.tryRun(['merge-base', a, b]);
    if (!base?.trim()) throw new GitProviderError('The revisions have no common ancestor', 'NO_MERGE_BASE');
    return base.trim();
  }

  private async emptyTree(): Promise<string> {
    this.objectFormat ??=
      (await this.tryRun(['rev-parse', '--show-object-format']))?.trim() === 'sha256' ? 'sha256' : 'sha1';
    return this.objectFormat === 'sha256' ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1;
  }

  private async diff(args: string[]): Promise<ChangedFile[]> {
    const output = await this.run(args);
    if (output.length > this.options.maxDiffBytes) {
      throw new GitProviderError(`Diff exceeds ${this.options.maxDiffBytes} bytes; narrow the scope`, 'GIT_FAILED');
    }
    return parseUnifiedDiff(output);
  }

  /** Untracked, non-ignored files represented as added files with a single all-lines hunk. */
  private async untrackedFiles(): Promise<ChangedFile[]> {
    const output = await this.run(['ls-files', '--others', '--exclude-standard', '-z']);
    const paths = output.split('\u0000').filter((p) => p.length > 0);
    const files: ChangedFile[] = [];
    for (const rawPath of paths) {
      let path: string;
      try {
        path = normalizeRepoRelativePath(rawPath);
      } catch {
        continue;
      }
      const content = await this.readWorktreeFile(path);
      if (!content) continue;
      files.push(untrackedAsAdded(path, content));
    }
    return files;
  }

  private async readWorktreeFile(path: string): Promise<FileContent | null> {
    let absolute: string;
    try {
      absolute = resolveInsideRepo(this.rootPath, path);
    } catch (error) {
      throw new GitProviderError(error instanceof UnsafePathError ? error.message : 'Unsafe path', 'UNSAFE_PATH');
    }
    const revision: Revision = { kind: 'worktree' };
    let sizeBytes: number;
    try {
      const stats = await stat(absolute);
      if (!stats.isFile()) return null;
      sizeBytes = stats.size;
    } catch {
      return null;
    }
    if (sizeBytes > this.options.maxFileBytes) {
      return { path, revision, sizeBytes, isBinary: false, content: '', tooLarge: true };
    }
    const buffer = await readFile(absolute);
    const isBinary = buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
    return { path, revision, sizeBytes, isBinary, content: isBinary ? '' : buffer.toString('utf8'), tooLarge: false };
  }

  private safePath(path: string): string {
    try {
      return normalizeRepoRelativePath(path);
    } catch (error) {
      throw new GitProviderError(error instanceof UnsafePathError ? error.message : 'Unsafe path', 'UNSAFE_PATH');
    }
  }

  private async run(args: string[]): Promise<string> {
    try {
      return await this.git.raw(args);
    } catch (error) {
      const message = error instanceof Error ? (error.message.split('\n').find((l) => l.trim() !== '') ?? '') : '';
      throw new GitProviderError(`git ${args[0] ?? ''} failed: ${message.slice(0, 300)}`, 'GIT_FAILED');
    }
  }

  private async tryRun(args: string[]): Promise<string | null> {
    try {
      return await this.git.raw(args);
    } catch {
      return null;
    }
  }
}

function createGit(baseDir: string, options: Required<LocalGitProviderOptions>): SimpleGit {
  return simpleGit({
    baseDir,
    binary: 'git',
    maxConcurrentProcesses: 4,
    trimmed: false,
    config: FORCED_CONFIG,
    // Strict mode: unsafe options and GIT_* environment overrides are rejected/stripped.
    strict: true,
    allowConfig: ['core.fsmonitor'],
    timeout: { block: options.timeoutMs },
  });
}

function untrackedAsAdded(path: string, content: FileContent): ChangedFile {
  const base = { path, status: 'added' as const, deletions: 0 };
  if (content.isBinary) return { ...base, isBinary: true, additions: 0, hunks: [] };
  if (content.tooLarge) {
    // Content is not loaded; an empty hunk makes the context builder look at the file and
    // record it as `too_large` instead of silently including it without content.
    return {
      ...base,
      isBinary: false,
      additions: 0,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 0, lines: [] }],
    };
  }
  if (content.content.length === 0) return { ...base, isBinary: false, additions: 0, hunks: [] };

  const lines = content.content.split(/\r?\n/);
  const endsWithNewline = lines.at(-1) === '';
  if (endsWithNewline) lines.pop();
  return {
    ...base,
    isBinary: false,
    additions: lines.length,
    hunks: [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines: lines.map((line, index) => ({
          kind: 'add' as const,
          content: line,
          newLine: index + 1,
          ...(index === lines.length - 1 && !endsWithNewline ? { noNewlineAtEof: true } : {}),
        })),
      },
    ],
  };
}

function emptyToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Masks credentials in URL-style remotes; scp-style SSH remotes (git@host:path) carry none. */
function sanitizeRemoteUrl(remote: string): string {
  if (/^[\w.-]+@[\w.-]+:(?!\/\/)/.test(remote)) return remote;
  return maskUrlCredentials(remote);
}
