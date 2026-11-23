import { type ChangeScope, type RepositoryInfo } from '@acra/git-providers-core';
import { CliError } from './cli-context';

export interface ScopeFlags {
  readonly staged?: boolean;
  readonly unstaged?: boolean;
  readonly all?: boolean;
  readonly base?: string;
  readonly branch?: string;
  /** Commander sets this to false for `--no-untracked`. */
  readonly untracked?: boolean;
}

/**
 * Maps CLI flags to a ChangeScope. Shared by `changes` now and `review` in Phase 3.
 *
 *   --staged                     index vs HEAD
 *   --unstaged                   working tree vs index (+ untracked)
 *   --base <ref>                 commits on the current branch not in <ref>
 *   --branch <ref> [--base <b>]  commits on <ref> not in <b> (no checkout)
 *   --all [--base <ref>]         everything not in base (default when no flag is given)
 */
export function resolveScope(flags: ScopeFlags, info: RepositoryInfo): ChangeScope {
  const includeUntracked = flags.untracked !== false;
  const modes = [flags.staged, flags.unstaged, flags.all].filter(Boolean).length;
  if (modes > 1) throw new CliError('Use only one of --staged, --unstaged and --all.', 2);
  if ((flags.staged || flags.unstaged) && (flags.base || flags.branch)) {
    throw new CliError('--staged and --unstaged cannot be combined with --base or --branch.', 2);
  }
  if (flags.all && flags.branch) throw new CliError('--all cannot be combined with --branch.', 2);

  if (flags.staged) return { kind: 'staged' };
  if (flags.unstaged) return { kind: 'unstaged', includeUntracked };

  const base = flags.base ?? info.defaultBaseBranch;
  if (flags.branch) return { kind: 'branch', base: requireBase(base), head: flags.branch };
  if (flags.base && !flags.all) return { kind: 'committed', base: flags.base };

  if (info.headSha === null) {
    // No commits yet: everything is new; staged + unstaged is the meaningful default.
    throw new CliError('The repository has no commits yet. Use --staged or --unstaged.', 2);
  }
  return { kind: 'all', base: requireBase(base), includeUntracked };
}

function requireBase(base: string | null | undefined): string {
  if (!base) {
    throw new CliError(
      'Could not detect a base branch (no origin/HEAD, main, master, develop or trunk). Pass --base <ref>.',
      2,
    );
  }
  return base;
}
