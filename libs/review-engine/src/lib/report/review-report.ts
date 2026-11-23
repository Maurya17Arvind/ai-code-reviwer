import { ReviewCategorySchema, type ReviewFinding, ReviewFindingSchema, SeveritySchema } from '@acra/shared-types';
import * as z from 'zod';

/**
 * Persisted review result (local `.git/ai-review/` store now; database in Phase 4).
 * Full Zod (server/CLI). Finding objects are validated with the shared browser-safe contract.
 */
const Finding = z.custom<ReviewFinding>((value) => ReviewFindingSchema.safeParse(value).success, {
  error: 'invalid review finding',
});

export const ModelExecutionSchema = z.object({
  provider: z.enum(['claude', 'gpt', 'ollama']),
  model: z.string(),
  servedByModel: z.string().nullable(),
  status: z.enum(['succeeded', 'failed', 'skipped']),
  errorKind: z.string().optional(),
  errorMessage: z.string().optional(),
  latencyMs: z.number().nonnegative(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadInputTokens: z.number().optional(),
    cacheCreationInputTokens: z.number().optional(),
  }),
  costUsd: z.number().nullable(),
  rawFindingCount: z.number().int(),
  requestId: z.string().optional(),
});
export type ModelExecution = z.infer<typeof ModelExecutionSchema>;

export const FilteredFindingSchema = z.object({
  fingerprint: z.string(),
  filePath: z.string(),
  lineNumber: z.number().int().optional(),
  title: z.string(),
  severity: z.enum(SeveritySchema.options),
  category: z.enum(ReviewCategorySchema.options),
  confidence: z.number(),
  sources: z.array(z.enum(['claude', 'gpt', 'ollama', 'static'])),
  reason: z.enum(['below_severity', 'below_confidence', 'dismissed', 'false_positive']),
});

export const RejectedFindingSchema = z.object({
  source: z.enum(['claude', 'gpt', 'ollama', 'static']),
  filePath: z.string(),
  title: z.string(),
  reason: z.string(),
});

export const ReviewReportSchema = z.object({
  schemaVersion: z.literal(1),
  reviewId: z.string(),
  createdAt: z.iso.datetime(),
  status: z.enum(['completed', 'partial', 'failed']),
  repository: z.object({ rootPath: z.string(), branch: z.string().nullable(), headSha: z.string().nullable() }),
  scope: z.record(z.string(), z.unknown()),
  scopeDescription: z.string(),
  contextHash: z.string(),
  promptHash: z.string(),
  secretsRedacted: z.number().int(),
  settings: z.object({
    providers: z.array(z.enum(['claude', 'gpt', 'ollama'])),
    categories: z.array(z.enum(ReviewCategorySchema.options)),
    minimumSeverity: z.enum(SeveritySchema.options),
    minimumConfidence: z.number(),
  }),
  stats: z.object({
    filesReviewed: z.number().int(),
    filesOmitted: z.number().int(),
    candidates: z.number().int(),
    rejected: z.number().int(),
    filtered: z.number().int(),
    findings: z.number().int(),
    bySeverity: z.record(z.string(), z.number()),
    totalCostUsd: z.number().nullable(),
  }),
  executions: z.array(ModelExecutionSchema),
  findings: z.array(Finding),
  filtered: z.array(FilteredFindingSchema),
  rejected: z.array(RejectedFindingSchema),
  resolved: z.array(z.object({ id: z.string(), fingerprint: z.string(), filePath: z.string() })),
  /** Free-text summaries written by the models — untrusted text, render escaped. */
  modelSummaries: z.record(z.string(), z.string()),
  trace: z.array(z.object({ node: z.string(), durationMs: z.number() })),
});
export type ReviewReport = z.infer<typeof ReviewReportSchema>;
