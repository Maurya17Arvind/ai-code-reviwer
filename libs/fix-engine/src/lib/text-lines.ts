/** A text file split into lines, remembering its line-ending style. */
export interface TextLines {
  readonly lines: readonly string[];
  readonly eol: '\n' | '\r\n';
  readonly finalNewline: boolean;
}

export function splitLines(content: string): TextLines {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  if (content === '') return { lines: [], eol, finalNewline: false };
  const lines = content.split(/\r?\n/);
  const finalNewline = lines.at(-1) === '';
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

export function joinLines(text: TextLines): string {
  if (text.lines.length === 0) return '';
  return text.lines.join(text.eol) + (text.finalNewline ? text.eol : '');
}

/** One contiguous replacement in old-file numbering: lines oldStart..oldEnd (1-based, inclusive). */
export interface LineChange {
  readonly oldStart: number;
  /** oldStart - 1 for a pure insertion before oldStart. */
  readonly oldEnd: number;
  readonly added: readonly string[];
}

/** Splits replacement text into lines (a single trailing newline is not an extra empty line). */
export function replacementLines(replacement: string): string[] {
  if (replacement === '') return [];
  const lines = replacement.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Turns validated edits into minimal changes: lines identical at the start or end of a replacement
 * are dropped, so the diff shows only what really changes. Edits must be sorted and non-overlapping.
 */
export function toChanges(
  old: readonly string[],
  edits: ReadonlyArray<{ startLine: number; endLine: number; added: readonly string[] }>,
): LineChange[] {
  const changes: LineChange[] = [];
  for (const edit of edits) {
    let start = edit.startLine;
    let end = edit.endLine;
    let added = [...edit.added];
    while (start <= end && added.length > 0 && old[start - 1] === added[0]) {
      start++;
      added = added.slice(1);
    }
    while (end >= start && added.length > 0 && old[end - 1] === added.at(-1)) {
      end--;
      added = added.slice(0, -1);
    }
    if (end < start && added.length === 0) continue;
    changes.push({ oldStart: start, oldEnd: end, added });
  }
  return changes;
}

export function applyChanges(text: TextLines, changes: readonly LineChange[]): TextLines {
  const result: string[] = [];
  let cursor = 1;
  for (const change of changes) {
    result.push(...text.lines.slice(cursor - 1, change.oldStart - 1));
    result.push(...change.added);
    cursor = change.oldEnd + 1;
  }
  result.push(...text.lines.slice(cursor - 1));
  return { lines: result, eol: text.eol, finalNewline: text.finalNewline && result.length > 0 };
}
