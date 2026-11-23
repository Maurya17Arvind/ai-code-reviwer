import { describeRevision, describeScope } from './revision';

describe('describeRevision', () => {
  it('abbreviates commit shas and names special revisions', () => {
    expect(describeRevision({ kind: 'commit', sha: 'a'.repeat(40) })).toBe('a'.repeat(12));
    expect(describeRevision({ kind: 'index' })).toBe('index (staged)');
    expect(describeRevision({ kind: 'worktree' })).toBe('working tree');
  });
});

describe('describeScope', () => {
  it('describes every scope', () => {
    expect(describeScope({ kind: 'staged' })).toContain('staged');
    expect(describeScope({ kind: 'unstaged', includeUntracked: true })).toContain('untracked');
    expect(describeScope({ kind: 'committed', base: 'main' })).toContain('main');
    expect(describeScope({ kind: 'branch', base: 'main', head: 'feature/x' })).toContain('feature/x');
    expect(describeScope({ kind: 'all', base: 'origin/main', includeUntracked: false })).not.toContain('untracked');
  });
});
