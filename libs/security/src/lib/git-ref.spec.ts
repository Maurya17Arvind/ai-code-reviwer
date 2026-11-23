import { assertSafeGitRef, isSafeGitRef } from './git-ref';

describe('assertSafeGitRef', () => {
  it.each([
    'main',
    'origin/main',
    'feature/graphql',
    'release-1.2.3',
    'HEAD',
    'HEAD~2',
    'HEAD^',
    'a1b2c3d4',
    'refs/heads/main',
  ])('accepts %s', (ref) => {
    expect(assertSafeGitRef(ref)).toBe(ref);
  });

  it.each([
    ['', 'empty'],
    ['--upload-pack=touch /tmp/pwned', 'option injection'],
    ['-n', 'option injection'],
    ['main..evil', 'range'],
    ['HEAD@{1}', 'reflog selector'],
    ['HEAD:secret.txt', 'blob selector'],
    ['main branch', 'whitespace'],
    ['main;rm -rf /', 'shell metacharacters'],
    ['feature/', 'trailing slash'],
    ['refs//heads', 'empty component'],
    ['main.lock', '.lock suffix'],
    ['.hidden', 'leading dot'],
    ['a'.repeat(201), 'too long'],
  ])('rejects %j (%s)', (ref) => {
    expect(isSafeGitRef(ref)).toBe(false);
  });
});
