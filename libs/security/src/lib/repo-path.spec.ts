import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeRepoRelativePath, resolveInsideRepo, UnsafePathError } from './repo-path';

describe('normalizeRepoRelativePath', () => {
  it('normalises separators and redundant segments', () => {
    expect(normalizeRepoRelativePath('src\\app\\./main.ts')).toBe('src/app/main.ts');
    expect(normalizeRepoRelativePath('./README.md')).toBe('README.md');
  });

  it.each([
    '',
    '../etc/passwd',
    'src/../../x',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'c:/x',
    '\\\\server\\share',
    'a\0b',
    '.',
  ])('rejects %j', (input) => {
    expect(() => normalizeRepoRelativePath(input)).toThrow(UnsafePathError);
  });
});

describe('resolveInsideRepo', () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'acra-repo-'));
    outside = mkdtempSync(join(tmpdir(), 'acra-outside-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'x');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('resolves existing and not-yet-existing files inside the repository', () => {
    expect(resolveInsideRepo(root, 'src/a.ts')).toBe(join(root, 'src', 'a.ts'));
    expect(resolveInsideRepo(root, 'src/new.ts')).toBe(join(root, 'src', 'new.ts'));
  });

  it('rejects traversal', () => {
    expect(() => resolveInsideRepo(root, '../outside.txt')).toThrow(UnsafePathError);
  });

  it('rejects symlinks that escape the repository', (context) => {
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'), 'file');
    } catch {
      context.skip(); // creating symlinks requires Developer Mode / admin on Windows
    }
    expect(() => resolveInsideRepo(root, 'link.txt')).toThrow(/outside the repository/);
  });
});
