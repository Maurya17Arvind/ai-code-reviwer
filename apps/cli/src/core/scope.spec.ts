import { type RepositoryInfo } from '@acra/git-providers-core';
import { CliError } from './cli-context';
import { resolveScope } from './scope';

const info: RepositoryInfo = {
  rootPath: '/repo',
  currentBranch: 'feature/x',
  headSha: 'a'.repeat(40),
  defaultBaseBranch: 'origin/main',
  remoteUrl: null,
};

describe('resolveScope', () => {
  it('defaults to all changes against the detected base', () => {
    expect(resolveScope({}, info)).toEqual({ kind: 'all', base: 'origin/main', includeUntracked: true });
    expect(resolveScope({ all: true, untracked: false }, info)).toEqual({
      kind: 'all',
      base: 'origin/main',
      includeUntracked: false,
    });
  });

  it('maps each flag to its scope', () => {
    expect(resolveScope({ staged: true }, info)).toEqual({ kind: 'staged' });
    expect(resolveScope({ unstaged: true }, info)).toEqual({ kind: 'unstaged', includeUntracked: true });
    expect(resolveScope({ base: 'main' }, info)).toEqual({ kind: 'committed', base: 'main' });
    expect(resolveScope({ all: true, base: 'develop' }, info)).toEqual({
      kind: 'all',
      base: 'develop',
      includeUntracked: true,
    });
    expect(resolveScope({ branch: 'feature/graphql', base: 'main' }, info)).toEqual({
      kind: 'branch',
      base: 'main',
      head: 'feature/graphql',
    });
    expect(resolveScope({ branch: 'feature/graphql' }, info)).toMatchObject({ base: 'origin/main' });
  });

  it.each([
    [{ staged: true, unstaged: true }],
    [{ staged: true, all: true }],
    [{ staged: true, base: 'main' }],
    [{ unstaged: true, branch: 'x' }],
    [{ all: true, branch: 'x' }],
  ])('rejects conflicting flags %j with exit code 2', (flags) => {
    expect(() => resolveScope(flags, info)).toThrow(CliError);
    try {
      resolveScope(flags, info);
    } catch (error) {
      expect((error as CliError).exitCode).toBe(2);
    }
  });

  it('asks for --base when none can be detected, and for --staged/--unstaged without commits', () => {
    expect(() => resolveScope({}, { ...info, defaultBaseBranch: null })).toThrow(/--base/);
    expect(() => resolveScope({}, { ...info, headSha: null })).toThrow(/no commits/);
  });
});
