import { type ReviewContext } from '@acra/repository-context';
import { redactSecrets } from './secret-scanner';

/**
 * Returns a copy of the review context with credentials replaced by `[REDACTED:<kind>]` in every
 * diff line and snippet. This is the payload that may leave the machine; the original context is
 * only used locally (static analysis, validation).
 */
export function redactContext(context: ReviewContext): { context: ReviewContext; redactions: number } {
  let redactions = 0;
  const redact = (text: string) => {
    const result = redactSecrets(text);
    redactions += result.redactions;
    return result.text;
  };
  const files = context.files.map((file) => ({
    ...file,
    hunks: file.hunks.map((hunk) => ({
      ...hunk,
      lines: hunk.lines.map((line) => ({ ...line, content: redact(line.content) })),
    })),
    snippets: file.snippets.map((snippet) => ({ ...snippet, text: redact(snippet.text) })),
  }));
  return { context: { ...context, files }, redactions };
}
