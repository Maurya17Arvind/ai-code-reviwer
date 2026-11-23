import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

/**
 * Safe handling of repository-relative paths that come from untrusted sources
 * (git output, provider APIs, AI findings, CLI input).
 */
export class UnsafePathError extends Error {
  constructor(reason: string) {
    super(`Unsafe repository path: ${reason}`);
    this.name = 'UnsafePathError';
  }
}

/**
 * Normalises a repository-relative path to forward slashes and rejects anything that could
 * escape the repository: absolute paths, drive letters, UNC paths, `..` segments, NUL bytes.
 */
export function normalizeRepoRelativePath(input: string): string {
  if (input.length === 0) throw new UnsafePathError('empty');
  if (input.includes('\0')) throw new UnsafePathError('contains a NUL byte');
  const forward = input.replace(/\\/g, '/');
  if (forward.startsWith('/') || isAbsolute(input) || win32.isAbsolute(input) || /^[A-Za-z]:/.test(forward)) {
    throw new UnsafePathError('absolute paths are not allowed');
  }
  const segments = forward.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) throw new UnsafePathError('empty');
  if (segments.some((segment) => segment === '..')) throw new UnsafePathError('".." segments are not allowed');
  return segments.join('/');
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolves a repository-relative path to an absolute filesystem path inside `repoRoot`.
 * If the target exists, symlinks are resolved and the real path must also stay inside the
 * repository (prevents reading e.g. ~/.ssh through a committed symlink).
 */
export function resolveInsideRepo(repoRoot: string, relativePath: string): string {
  const normalized = normalizeRepoRelativePath(relativePath);
  const root = resolve(repoRoot);
  const target = resolve(root, ...normalized.split('/'));
  if (!isInside(root, target)) throw new UnsafePathError('resolves outside the repository');

  let realTarget: string;
  try {
    realTarget = realpathSync.native(target);
  } catch {
    return target; // does not exist (yet); lexical check above is sufficient
  }
  const realRoot = realpathSync.native(root);
  if (!isInside(realRoot, realTarget)) {
    throw new UnsafePathError('symbolic link points outside the repository');
  }
  return target;
}

/** Converts an OS path to forward slashes for display/storage. */
export function toPosixPath(path: string): string {
  return sep === '\\' ? path.replace(/\\/g, '/') : path;
}
