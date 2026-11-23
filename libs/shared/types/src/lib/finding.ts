// Browser-safe: `zod/mini` keeps dashboard bundles small.
import * as z from 'zod/mini';
import { ReviewCategorySchema, SeveritySchema } from './review';

/** Who produced a finding. `static` = deterministic built-in analyzers (no AI). */
export const FindingSourceSchema = z.enum(['claude', 'gpt', 'ollama', 'static']);
export type FindingSource = z.infer<typeof FindingSourceSchema>;

/** Lifecycle statuses (Module F). */
export const FindingStatusSchema = z.enum(['new', 'validated', 'published', 'resolved', 'dismissed', 'false_positive']);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

/** Where a validated finding can be shown. Unmappable findings go to the summary — never an invented position. */
export const FindingPlacementSchema = z.enum(['inline', 'summary']);
export type FindingPlacement = z.infer<typeof FindingPlacementSchema>;

/**
 * A review finding after aggregation, validation and deduplication (product brief §8, extended).
 * Timestamps are ISO strings in contracts; the database stores timestamptz.
 */
export const ReviewFindingSchema = z.object({
  id: z.string(),
  /** Stable across commits for the same issue (independent of line numbers). */
  fingerprint: z.string(),
  repositoryId: z.nullable(z.string()),
  reviewSessionId: z.string(),
  filePath: z.string(),
  lineNumber: z.optional(z.int()),
  endLineNumber: z.optional(z.int()),
  severity: SeveritySchema,
  category: ReviewCategorySchema,
  title: z.string(),
  description: z.string(),
  evidence: z.string(),
  suggestion: z.optional(z.string()),
  /** Final confidence after deterministic adjustment, 0–1. */
  confidence: z.number(),
  isActionable: z.boolean(),
  modelSources: z.array(FindingSourceSchema),
  placement: FindingPlacementSchema,
  status: FindingStatusSchema,
  commitSha: z.nullable(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
