import picomatch from 'picomatch';

export type PathFilterResult = { readonly excluded: false } | { readonly excluded: true; readonly pattern: string };

export interface PathFilter {
  check(path: string): PathFilterResult;
}

/**
 * Glob-based exclusion filter. Patterns without a slash match the file name at any depth
 * (`*.lock` excludes `packages/a/yarn.lock`); patterns with a slash are anchored at the
 * repository root unless they start with `**`. Dotfiles are matched.
 */
export function createPathFilter(patterns: readonly string[]): PathFilter {
  const matchers = patterns.map((pattern) => ({
    pattern,
    isMatch: picomatch(pattern, { dot: true, basename: !pattern.includes('/') }),
  }));
  return {
    check(path: string): PathFilterResult {
      const hit = matchers.find((matcher) => matcher.isMatch(path));
      return hit ? { excluded: true, pattern: hit.pattern } : { excluded: false };
    },
  };
}
