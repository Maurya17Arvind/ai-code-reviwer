import { ModelFixOutputSchema } from './fix-output.schema';
import { type FixWindow } from './fix-prompt';
import { type LineChange, replacementLines, toChanges } from './text-lines';

export const FIX_LIMITS = {
  maxEdits: 10,
  /** Old lines replaced across all edits. */
  maxReplacedLines: 80,
  /** New lines written across all edits. */
  maxAddedLines: 120,
  maxReplacementChars: 20_000,
  maxExplanationChars: 2_000,
  maxFileBytes: 400_000,
} as const;

export type FixRejectionCode =
  | 'protected_path'
  | 'unsupported_file'
  | 'multiline_secret'
  | 'model_declined'
  | 'invalid_output'
  | 'invalid_edits'
  | 'no_change'
  | 'provider_error';

export class FixRejection extends Error {
  constructor(
    readonly code: FixRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = 'FixRejection';
  }
}

export interface ValidatedFix {
  readonly explanation: string;
  readonly changes: readonly LineChange[];
}

/**
 * Deterministic gate for model output (the control, not the prompt): schema, line bounds inside the
 * shown window, no overlaps, size limits, no redaction markers, and no edits to lines whose secrets
 * were redacted before the model saw them (the model would write the marker back).
 */
export function validateFixOutput(
  raw: unknown,
  context: { lines: readonly string[]; window: FixWindow; redactedLines: ReadonlySet<number> },
): ValidatedFix {
  const parsed = ModelFixOutputSchema.safeParse(raw);
  if (!parsed.success) throw new FixRejection('invalid_output', 'Model output does not match the fix schema');
  const output = parsed.data;
  const explanation = output.explanation.trim().slice(0, FIX_LIMITS.maxExplanationChars);
  if (!output.canFix) {
    throw new FixRejection(
      'model_declined',
      `Model declined to fix: ${explanation.slice(0, 300) || 'no reason given'}`,
    );
  }
  if (output.edits.length === 0 || output.edits.length > FIX_LIMITS.maxEdits) {
    throw new FixRejection('invalid_edits', `Expected 1–${FIX_LIMITS.maxEdits} edits, got ${output.edits.length}`);
  }

  const edits = [...output.edits].sort((a, b) => a.startLine - b.startLine);
  let replaced = 0;
  let added = 0;
  let previousEnd = 0;
  const normalized: Array<{ startLine: number; endLine: number; added: string[] }> = [];
  for (const edit of edits) {
    const { startLine, endLine, replacement } = edit;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || endLine < startLine) {
      throw new FixRejection('invalid_edits', `Invalid line range ${startLine}-${endLine}`);
    }
    if (startLine < context.window.startLine || endLine > context.window.endLine) {
      throw new FixRejection('invalid_edits', `Edit ${startLine}-${endLine} is outside the lines shown to the model`);
    }
    if (endLine > context.lines.length) {
      throw new FixRejection('invalid_edits', `Edit ${startLine}-${endLine} is beyond the end of the file`);
    }
    if (startLine <= previousEnd) throw new FixRejection('invalid_edits', 'Edits overlap');
    previousEnd = endLine;
    if (replacement.length > FIX_LIMITS.maxReplacementChars || replacement.includes('\0')) {
      throw new FixRejection('invalid_edits', 'Replacement text is too large or contains NUL bytes');
    }
    if (/\[REDACTED:/.test(replacement)) {
      throw new FixRejection('invalid_edits', 'Replacement contains a secret-redaction marker');
    }
    for (let line = startLine; line <= endLine; line++) {
      if (context.redactedLines.has(line)) {
        throw new FixRejection('invalid_edits', `Edit touches line ${line}, which contains a redacted secret`);
      }
    }
    const lines = replacementLines(replacement);
    // A model copying the "<n> | " display prefix would corrupt the file.
    const prefixed = lines.filter((line) => /^\d+ \| /.test(line)).length;
    if (lines.length > 0 && prefixed === lines.length) {
      throw new FixRejection('invalid_edits', 'Replacement still contains line-number prefixes');
    }
    replaced += endLine - startLine + 1;
    added += lines.length;
    normalized.push({ startLine, endLine, added: lines });
  }
  if (replaced > FIX_LIMITS.maxReplacedLines || added > FIX_LIMITS.maxAddedLines) {
    throw new FixRejection('invalid_edits', `Fix is too large (${replaced} lines replaced, ${added} written)`);
  }

  const changes = toChanges(context.lines, normalized);
  if (changes.length === 0) throw new FixRejection('no_change', 'The proposed edits do not change the file');
  return { explanation, changes };
}
