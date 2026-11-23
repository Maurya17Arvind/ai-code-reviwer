import { type ChangeScope, type Revision } from './repository-reader';

/** Short human-readable label for a revision (used in CLI output and reports). */
export function describeRevision(revision: Revision): string {
  switch (revision.kind) {
    case 'commit':
      return revision.sha.slice(0, 12);
    case 'index':
      return 'index (staged)';
    case 'worktree':
      return 'working tree';
  }
}

export function describeScope(scope: ChangeScope): string {
  switch (scope.kind) {
    case 'staged':
      return 'staged changes (index vs HEAD)';
    case 'unstaged':
      return scope.includeUntracked
        ? 'unstaged changes incl. untracked files (working tree vs index)'
        : 'unstaged changes (working tree vs index)';
    case 'committed':
      return `commits on the current branch not in ${scope.base}`;
    case 'branch':
      return `commits on ${scope.head} not in ${scope.base}`;
    case 'all':
      return `all changes not in ${scope.base} (committed + staged + unstaged${scope.includeUntracked ? ' + untracked' : ''})`;
  }
}
