import { detectLanguage } from './language';
import { createPathFilter } from './path-filter';

describe('createPathFilter', () => {
  const filter = createPathFilter(['**/node_modules/**', '*.lock', 'dist/**', '.env*']);

  it.each([
    ['node_modules/x/index.js', '**/node_modules/**'],
    ['packages/a/node_modules/x.js', '**/node_modules/**'],
    ['yarn.lock', '*.lock'],
    ['packages/a/Cargo.lock', '*.lock'],
    ['dist/main.js', 'dist/**'],
    ['.env.local', '.env*'],
  ])('excludes %s via %s', (path, pattern) => {
    expect(filter.check(path)).toEqual({ excluded: true, pattern });
  });

  it.each(['src/dist/main.ts', 'src/app.ts', 'lockfile.ts'])('keeps %s', (path) => {
    expect(filter.check(path)).toEqual({ excluded: false });
  });
});

describe('detectLanguage', () => {
  it.each([
    ['src/app/app.component.ts', 'typescript'],
    ['src/app/app.html', 'html'],
    ['styles.scss', 'scss'],
    ['schema.graphql', 'graphql'],
    ['Dockerfile', 'dockerfile'],
    ['Dockerfile.dev', 'dockerfile'],
    ['.gitignore', 'text'],
    ['LICENSE', 'text'],
  ])('%s → %s', (path, language) => {
    expect(detectLanguage(path)).toBe(language);
  });
});
