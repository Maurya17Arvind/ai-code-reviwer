import { ReviewCategorySchema, SeveritySchema } from '@acra/shared-types';
import * as z from 'zod';

/**
 * The exact JSON shape every AI reviewer must return. Used three ways:
 *  1. converted to JSON Schema for provider-side constrained decoding (Claude output_config.format,
 *     OpenAI text.format strict),
 *  2. re-validated locally with Zod — provider output is never trusted,
 *  3. as the single contract shared by all providers (identical instructions, comparable output).
 *
 * Portability rules (both providers' structured-output subsets): every object is strict
 * (additionalProperties: false), every property is required (optional values are nullable), and no
 * numeric/length constraints appear in the schema — those are enforced after parsing.
 */
const Severity = z.enum(SeveritySchema.options);
const Category = z.enum(ReviewCategorySchema.options);

export const ModelFindingSchema = z.strictObject({
  filePath: z.string().describe('Repository-relative path exactly as given in the review input.'),
  lineStart: z
    .int()
    .nullable()
    .describe('First line (new file numbering) the issue is on, or null if not line-specific.'),
  lineEnd: z.int().nullable().describe('Last line of the issue, or null.'),
  severity: Severity,
  category: Category,
  title: z.string().describe('One-line summary of the problem.'),
  description: z.string().describe('What is wrong and what impact it has.'),
  evidence: z.string().describe('The exact code from the review input that demonstrates the problem.'),
  suggestion: z.string().nullable().describe('Concrete fix, or null.'),
  confidence: z.number().describe('0.0–1.0: how certain you are this is a real, actionable problem.'),
});
export type ModelFinding = z.infer<typeof ModelFindingSchema>;

export const ModelReviewOutputSchema = z.strictObject({
  findings: z.array(ModelFindingSchema),
  summary: z.string().describe('Two to four sentences on the overall quality and risk of the change.'),
});
export type ModelReviewOutput = z.infer<typeof ModelReviewOutputSchema>;

/** JSON Schema (draft 2020-12) for provider structured-output APIs. */
export function modelReviewOutputJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ModelReviewOutputSchema, { target: 'draft-2020-12', io: 'output' }) as Record<
    string,
    unknown
  >;
  delete schema['$schema'];
  return stripUnsupportedKeywords(schema) as Record<string, unknown>;
}

/**
 * Removes keywords outside the providers' structured-output subset (e.g. the safe-integer
 * bounds Zod emits for z.int()). The constraints are still enforced by local Zod validation.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
]);

function stripUnsupportedKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupportedKeywords);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>)
      .filter(([key]) => !UNSUPPORTED_KEYWORDS.has(key))
      .map(([key, value]) => [key, stripUnsupportedKeywords(value)]),
  );
}

/** Local post-parse limits (not expressible in provider schemas). */
export const MODEL_OUTPUT_LIMITS = {
  maxFindings: 100,
  maxTextLength: 4_000,
  maxEvidenceLength: 2_000,
} as const;
