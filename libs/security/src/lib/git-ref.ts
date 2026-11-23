/**
 * Validation for user-supplied Git revisions (branch names, tags, SHAs, `HEAD~2`).
 *
 * Refs are passed to git as argv elements (no shell), so the main risks are option injection
 * (a value starting with `-`, e.g. `--upload-pack=...`) and confusing revision syntax
 * (`..` ranges, `@{...}` reflog selectors, `:path` blob selectors) that callers did not intend.
 * Ranges are always built by the provider itself, never accepted from input.
 */
const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9._/+~^-]*$/;
const MAX_LENGTH = 200;

export class UnsafeGitRefError extends Error {
  constructor(reason: string) {
    super(`Invalid git reference: ${reason}`);
    this.name = 'UnsafeGitRefError';
  }
}

export function assertSafeGitRef(ref: string): string {
  if (ref.length === 0) throw new UnsafeGitRefError('empty');
  if (ref.length > MAX_LENGTH) throw new UnsafeGitRefError(`longer than ${MAX_LENGTH} characters`);
  if (!ALLOWED.test(ref)) {
    throw new UnsafeGitRefError('must start with a letter or digit and contain only letters, digits and . _ / + ~ ^ -');
  }
  if (ref.includes('..')) throw new UnsafeGitRefError('ranges ("..") are not accepted');
  if (ref.includes('//')) throw new UnsafeGitRefError('empty path component');
  if (ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) {
    throw new UnsafeGitRefError('must not end with "/", "." or ".lock"');
  }
  return ref;
}

export function isSafeGitRef(ref: string): boolean {
  try {
    assertSafeGitRef(ref);
    return true;
  } catch {
    return false;
  }
}
