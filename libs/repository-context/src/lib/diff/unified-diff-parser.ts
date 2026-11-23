import { type ChangedFile, type DiffHunk, type DiffLine, type FileChangeStatus } from '@acra/git-providers-core';

/**
 * Parser for `git diff` unified output (as produced with `--no-color --no-ext-diff --src-prefix=a/
 * --dst-prefix=b/`). Pure and synchronous; input is untrusted text, so the parser never throws on
 * odd input — malformed sections are skipped rather than guessed.
 *
 * Unsupported by design: combined diffs (`diff --cc`, produced for unmerged files during a merge),
 * which are skipped.
 */

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

interface FileBuilder {
  path?: string;
  oldPath?: string;
  headerOld?: string;
  headerNew?: string;
  status: FileChangeStatus;
  isBinary: boolean;
  similarity?: number;
  oldMode?: string;
  newMode?: string;
  hunks: DiffHunk[];
}

export function parseUnifiedDiff(diffText: string): ChangedFile[] {
  const lines = diffText.split('\n');
  if (lines.at(-1) === '') lines.pop();

  const files: ChangedFile[] = [];
  let current: FileBuilder | undefined;
  let index = 0;

  const flush = () => {
    if (current) {
      const finished = finishFile(current);
      if (finished) files.push(finished);
    }
    current = undefined;
  };

  while (index < lines.length) {
    const line = stripCr(lines[index] ?? '');

    if (line.startsWith('diff --git ')) {
      flush();
      current = { status: 'modified', isBinary: false, hunks: [] };
      const header = parseGitHeaderPaths(line.slice('diff --git '.length));
      if (header) {
        current.headerOld = header.oldPath;
        current.headerNew = header.newPath;
      }
      index++;
      continue;
    }

    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      flush();
      index++;
      while (index < lines.length && !stripCr(lines[index] ?? '').startsWith('diff --git ')) index++;
      continue;
    }

    if (!current) {
      index++;
      continue;
    }

    if (line.startsWith('@@')) {
      const { hunk, nextIndex } = parseHunkAt(lines, index);
      if (hunk) current.hunks.push(hunk);
      index = nextIndex;
      continue;
    }

    applyExtendedHeader(current, line);
    index++;
  }
  flush();
  return files;
}

/**
 * Parses hunks only (no file headers), e.g. the per-file `diff` field returned by the GitLab
 * and GitHub APIs.
 */
export function parseHunks(hunksText: string): DiffHunk[] {
  const lines = hunksText.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    if (stripCr(lines[index] ?? '').startsWith('@@')) {
      const { hunk, nextIndex } = parseHunkAt(lines, index);
      if (hunk) hunks.push(hunk);
      index = nextIndex;
    } else {
      index++;
    }
  }
  return hunks;
}

function applyExtendedHeader(file: FileBuilder, line: string): void {
  if (line.startsWith('new file mode ')) {
    file.status = 'added';
    file.newMode = line.slice('new file mode '.length).trim();
  } else if (line.startsWith('deleted file mode ')) {
    file.status = 'deleted';
    file.oldMode = line.slice('deleted file mode '.length).trim();
  } else if (line.startsWith('old mode ')) {
    file.oldMode = line.slice('old mode '.length).trim();
  } else if (line.startsWith('new mode ')) {
    file.newMode = line.slice('new mode '.length).trim();
  } else if (line.startsWith('rename from ')) {
    file.status = 'renamed';
    file.oldPath = unquotePath(line.slice('rename from '.length));
  } else if (line.startsWith('rename to ')) {
    file.status = 'renamed';
    file.path = unquotePath(line.slice('rename to '.length));
  } else if (line.startsWith('copy from ')) {
    file.status = 'copied';
    file.oldPath = unquotePath(line.slice('copy from '.length));
  } else if (line.startsWith('copy to ')) {
    file.status = 'copied';
    file.path = unquotePath(line.slice('copy to '.length));
  } else if (line.startsWith('similarity index ')) {
    const value = Number.parseInt(line.slice('similarity index '.length), 10);
    if (Number.isFinite(value)) file.similarity = value;
  } else if (line.startsWith('--- ')) {
    const path = stripPrefix(unquotePath(line.slice(4)), 'a/');
    if (path !== null && file.status !== 'renamed' && file.status !== 'copied') file.oldPath ??= path;
  } else if (line.startsWith('+++ ')) {
    const path = stripPrefix(unquotePath(line.slice(4)), 'b/');
    if (path !== null) file.path ??= path;
  } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
    file.isBinary = true;
  }
}

function parseHunkAt(lines: readonly string[], start: number): { hunk: DiffHunk | undefined; nextIndex: number } {
  const match = HUNK_HEADER.exec(stripCr(lines[start] ?? ''));
  if (!match) return { hunk: undefined, nextIndex: start + 1 };

  const oldStart = Number(match[1]);
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);
  const section = match[5]?.trim();

  const body: DiffLine[] = [];
  let oldRemaining = oldLines;
  let newRemaining = newLines;
  let oldLine = oldStart;
  let newLine = newStart;
  let index = start + 1;

  while (index < lines.length) {
    const raw = stripCr(lines[index] ?? '');
    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" applies to the previous line.
      const previous = body.at(-1);
      if (previous) body[body.length - 1] = { ...previous, noNewlineAtEof: true };
      index++;
      continue;
    }
    if (oldRemaining <= 0 && newRemaining <= 0) break;

    const marker = raw.charAt(0);
    const content = raw.slice(1);
    if (marker === '+' && newRemaining > 0) {
      body.push({ kind: 'add', content, newLine });
      newLine++;
      newRemaining--;
    } else if (marker === '-' && oldRemaining > 0) {
      body.push({ kind: 'del', content, oldLine });
      oldLine++;
      oldRemaining--;
    } else if ((marker === ' ' || raw === '') && oldRemaining > 0 && newRemaining > 0) {
      body.push({ kind: 'context', content, oldLine, newLine });
      oldLine++;
      newLine++;
      oldRemaining--;
      newRemaining--;
    } else {
      break; // malformed or truncated hunk: stop here rather than mis-number lines
    }
    index++;
  }

  return {
    hunk: { oldStart, oldLines, newStart, newLines, ...(section ? { section } : {}), lines: body },
    nextIndex: index,
  };
}

function finishFile(file: FileBuilder): ChangedFile | undefined {
  const path = file.status === 'deleted' ? (file.oldPath ?? file.headerOld) : (file.path ?? file.headerNew);
  if (!path) return undefined;

  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') additions++;
      else if (line.kind === 'del') deletions++;
    }
  }

  const oldPath = file.status === 'renamed' || file.status === 'copied' ? (file.oldPath ?? file.headerOld) : undefined;

  return {
    path,
    ...(oldPath !== undefined ? { oldPath } : {}),
    status: file.status,
    isBinary: file.isBinary,
    additions,
    deletions,
    ...(file.similarity !== undefined ? { similarity: file.similarity } : {}),
    ...(file.oldMode !== undefined ? { oldMode: file.oldMode } : {}),
    ...(file.newMode !== undefined ? { newMode: file.newMode } : {}),
    hunks: file.hunks,
  };
}

/**
 * Splits the `diff --git` header into old/new paths. Quoted paths are unambiguous; unquoted
 * paths may contain spaces, so we only accept the split when both sides name the same path
 * (renames and copies are resolved from the extended headers instead).
 */
function parseGitHeaderPaths(rest: string): { oldPath: string; newPath: string } | undefined {
  if (rest.startsWith('"')) {
    const end = findClosingQuote(rest, 0);
    if (end < 0) return undefined;
    const oldPath = stripPrefix(unquotePath(rest.slice(0, end + 1)), 'a/');
    const newPath = stripPrefix(unquotePath(rest.slice(end + 2)), 'b/');
    return oldPath && newPath ? { oldPath, newPath } : undefined;
  }
  if (!rest.startsWith('a/')) return undefined;
  if ((rest.length - 5) % 2 !== 0) return undefined;
  const length = (rest.length - 5) / 2;
  const oldPath = rest.slice(2, 2 + length);
  const separator = rest.slice(2 + length, 5 + length);
  const newPath = rest.slice(5 + length);
  if (separator !== ' b/' || oldPath !== newPath) return undefined;
  return { oldPath, newPath };
}

function findClosingQuote(text: string, openIndex: number): number {
  for (let i = openIndex + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

/** Decodes git's C-style quoted paths ("a/tab\there", octal escapes for raw bytes). */
export function unquotePath(value: string): string {
  const trimmed = value.trimEnd();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) return trimmed.replace(/\t$/, '');
  const inner = trimmed.slice(1, -1);
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '\\': 92, '"': 34 };
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i] as string;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = inner[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      const octal = inner.slice(i + 1, i + 4);
      bytes.push(Number.parseInt(octal, 8));
      i += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(path: string, prefix: 'a/' | 'b/'): string | null {
  if (path === '/dev/null') return null;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
