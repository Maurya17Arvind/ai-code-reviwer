// Browser-safe: `zod/mini` keeps dashboard bundles small.
import {
  FindingPlacementSchema,
  FindingStatusSchema,
  GitProviderKindSchema,
  ReviewCategorySchema,
  SeveritySchema,
} from '@acra/shared-types';
import * as z from 'zod/mini';
import { IdSchema, NullableTimestampSchema, PageQuerySchema, TimestampSchema } from './common';

export const ReviewSessionStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'partial',
  'failed',
  'superseded',
  'skipped',
]);
export type ReviewSessionStatus = z.infer<typeof ReviewSessionStatusSchema>;

export const ReviewListQuerySchema = z.object({
  ...PageQuerySchema.shape,
  repositoryId: z.optional(IdSchema),
  status: z.optional(ReviewSessionStatusSchema),
});
export type ReviewListQuery = z.infer<typeof ReviewListQuerySchema>;

export const ReviewSummarySchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  repositoryName: z.string(),
  provider: GitProviderKindSchema,
  /** MR iid / PR number. */
  requestId: z.nullable(z.int()),
  baseSha: z.nullable(z.string()),
  headSha: z.string(),
  status: ReviewSessionStatusSchema,
  /** Coarse error code (never raw provider output). */
  errorCode: z.nullable(z.string()),
  /** Skip/supersede reason or a short failure description. */
  statusReason: z.nullable(z.string()),
  findingCount: z.int(),
  costUsd: z.nullable(z.number()),
  createdAt: TimestampSchema,
  startedAt: NullableTimestampSchema,
  finishedAt: NullableTimestampSchema,
});
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;

export const ModelExecutionSchema = z.object({
  id: z.string(),
  provider: z.string(),
  model: z.string(),
  servedByModel: z.nullable(z.string()),
  status: z.string(),
  errorKind: z.nullable(z.string()),
  inputTokens: z.int(),
  outputTokens: z.int(),
  cacheReadTokens: z.int(),
  costUsd: z.nullable(z.number()),
  latencyMs: z.int(),
  createdAt: TimestampSchema,
});
export type ModelExecution = z.infer<typeof ModelExecutionSchema>;

export const FindingSummarySchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  repositoryName: z.string(),
  requestId: z.int(),
  filePath: z.string(),
  lineNumber: z.nullable(z.int()),
  endLineNumber: z.nullable(z.int()),
  severity: SeveritySchema,
  category: ReviewCategorySchema,
  title: z.string(),
  confidence: z.number(),
  sources: z.array(z.string()),
  placement: FindingPlacementSchema,
  status: FindingStatusSchema,
  firstSeenSha: z.string(),
  lastSeenSha: z.string(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type FindingSummary = z.infer<typeof FindingSummarySchema>;

export const ReviewDetailSchema = z.object({
  ...ReviewSummarySchema.shape,
  repositoryWebUrl: z.nullable(z.string()),
  executions: z.array(ModelExecutionSchema),
  /** Findings last seen in this review. */
  findings: z.array(FindingSummarySchema),
  comments: z.object({ inline: z.int(), summary: z.int() }),
});
export type ReviewDetail = z.infer<typeof ReviewDetailSchema>;

export const FindingListQuerySchema = z.object({
  ...PageQuerySchema.shape,
  repositoryId: z.optional(IdSchema),
  severity: z.optional(SeveritySchema),
  status: z.optional(FindingStatusSchema),
  category: z.optional(ReviewCategorySchema),
});
export type FindingListQuery = z.infer<typeof FindingListQuerySchema>;

export const FindingFixRefSchema = z.object({ id: z.string(), status: z.string(), createdAt: TimestampSchema });

export const FindingDetailSchema = z.object({
  ...FindingSummarySchema.shape,
  /** Model-written text: untrusted, always rendered as plain text. */
  description: z.string(),
  evidence: z.string(),
  suggestion: z.nullable(z.string()),
  lastSessionId: z.string(),
  fixes: z.array(FindingFixRefSchema),
  /** Statuses a member may set from the current one. */
  allowedTransitions: z.array(FindingStatusSchema),
});
export type FindingDetail = z.infer<typeof FindingDetailSchema>;

/** Members can triage findings; automation never resurrects dismissed or false-positive findings. */
export const UpdateFindingStatusRequestSchema = z.object({
  status: z.enum(['dismissed', 'false_positive']),
  reason: z.optional(z.string().check(z.trim(), z.maxLength(500))),
});
export type UpdateFindingStatusRequest = z.infer<typeof UpdateFindingStatusRequestSchema>;
