import { type LineChange, type TextLines } from './text-lines';

const CONTEXT = 3;
const NO_NEWLINE = '\\ No newline at end of file';

/**
 * Renders a git-compatible unified diff (applies with `git apply`) for changes to one file.
 * Deterministic: the same input always yields the same bytes, so the patch hash can be bound into
 * an approval. CRLF files keep their `\r` in every emitted line.
 */
export function createUnifiedDiff(path: string, old: TextLines, changes: readonly LineChange[]): string {
  if (changes.length === 0) return '';
  const cr = old.eol === '\r\n' ? '\r' : '';
  const n = old.lines.length;
  const out: string[] = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];

  // Group changes whose context windows touch or overlap.
  const groups: LineChange[][] = [];
  for (const change of changes) {
    const last = groups.at(-1)?.at(-1);
    if (last && change.oldStart - last.oldEnd - 1 <= 2 * CONTEXT) groups.at(-1)?.push(change);
    else groups.push([change]);
  }

  let delta = 0; // new-line offset accumulated by earlier groups
  for (const group of groups) {
    const first = group[0];
    const lastChange = group.at(-1);
    if (!first || !lastChange) continue;
    const from = Math.max(1, first.oldStart - CONTEXT);
    const to = Math.min(n, lastChange.oldEnd + CONTEXT);
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    let groupDelta = 0;
    const emit = (marker: ' ' | '-' | '+', text: string, isLastOld: boolean, isLastNew: boolean) => {
      // Without a final newline the file's last line has no line ending at all (not even \r).
      const unterminated = !old.finalNewline && ((marker !== '+' && isLastOld) || (marker !== '-' && isLastNew));
      body.push(`${marker}${text}${unterminated ? '' : cr}`);
      if (unterminated) body.push(NO_NEWLINE);
    };

    // New-file line count, needed to know which emitted line is the new last line.
    const newTotal = n + changes.reduce((sum, c) => sum + c.added.length - (c.oldEnd - c.oldStart + 1), 0);
    let newLine = from + delta - 1; // last emitted new-file line number
    let index = 0;
    for (let line = from; line <= to + 1; line++) {
      const change = group[index];
      if (change && change.oldStart === line) {
        for (let removed = change.oldStart; removed <= change.oldEnd; removed++) {
          emit('-', old.lines[removed - 1] ?? '', removed === n, false);
          oldCount++;
        }
        for (const added of change.added) {
          newLine++;
          emit('+', added, false, newLine === newTotal);
          newCount++;
        }
        groupDelta += change.added.length - (change.oldEnd - change.oldStart + 1);
        line = change.oldEnd; // loop increment moves past the replaced range
        index++;
        continue;
      }
      if (line > to) break;
      newLine++;
      const text = old.lines[line - 1] ?? '';
      const isLastOld = line === n;
      const isLastNew = newLine === newTotal;
      if (!old.finalNewline && isLastOld !== isLastNew) {
        // Same text, different line ending (it gains or loses the final newline): git needs -/+.
        emit('-', text, isLastOld, false);
        emit('+', text, false, isLastNew);
      } else {
        emit(' ', text, isLastOld, isLastNew);
      }
      oldCount++;
      newCount++;
    }

    const oldStart = oldCount === 0 ? from - 1 : from;
    const newStartLine = from + delta;
    const newStart = newCount === 0 ? newStartLine - 1 : newStartLine;
    out.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`, ...body);
    delta += groupDelta;
  }
  return `${out.join('\n')}\n`;
}

function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}
