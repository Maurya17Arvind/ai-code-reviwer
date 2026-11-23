import { type StructuredOutputSpec, toProviderJsonSchema } from '@acra/ai-providers-core';
import * as z from 'zod';

/**
 * What a model returns when asked to fix one finding. The model never writes a diff: it names line
 * ranges of the single file it was shown and their replacement text. The patch is computed
 * deterministically from that (see unified-diff.ts), so its shape and hash are under our control.
 *
 * Portable structured-output subset: strict objects, every property required, no numeric bounds
 * (limits are enforced after parsing in validate-fix.ts).
 */
export const ModelFixEditSchema = z.strictObject({
  startLine: z.int().describe('First line to replace, using the line numbers shown in the input.'),
  endLine: z.int().describe('Last line to replace (inclusive); equal to startLine for a single line.'),
  replacement: z
    .string()
    .describe(
      'Complete new text for lines startLine..endLine, without line-number prefixes, lines separated by newlines. Empty string deletes the lines. Keep the existing indentation.',
    ),
});
export type ModelFixEdit = z.infer<typeof ModelFixEditSchema>;

export const ModelFixOutputSchema = z.strictObject({
  canFix: z
    .boolean()
    .describe('false when the problem cannot be fixed safely and minimally within the shown lines of this file.'),
  explanation: z.string().describe('2–5 sentences: what the change does and why it resolves the finding.'),
  edits: z.array(ModelFixEditSchema).describe('Non-overlapping line-range replacements; empty when canFix is false.'),
});
export type ModelFixOutput = z.infer<typeof ModelFixOutputSchema>;

export function fixOutputSpec(): StructuredOutputSpec {
  return { name: 'code_fix', schema: toProviderJsonSchema(ModelFixOutputSchema) };
}
