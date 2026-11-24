// Browser-safe: `zod/mini` keeps dashboard bundles small.
import { AuditActorTypeSchema } from '@acra/shared-types';
import * as z from 'zod/mini';
import { IdSchema, PageQuerySchema, TimestampSchema } from './common';
import { AiProviderStatusSchema } from './organizations';

export const InsightsQuerySchema = z.object({
  days: z._default(z.coerce.number().check(z.int(), z.gte(1), z.lte(365)), 30),
  repositoryId: z.optional(IdSchema),
});
export type InsightsQuery = z.infer<typeof InsightsQuerySchema>;

const Counts = z.record(z.string(), z.int());

export const AnalyticsResponseSchema = z.object({
  from: TimestampSchema,
  to: TimestampSchema,
  reviews: z.object({ total: z.int(), byStatus: Counts }),
  findings: z.object({
    /** Findings first seen in the period. */
    total: z.int(),
    bySeverity: Counts,
    byCategory: Counts,
    byStatus: Counts,
    published: z.int(),
  }),
  /** Share of triaged findings marked false positive (null when nothing was triaged). */
  falsePositiveRate: z.nullable(z.number()),
  fixes: z.object({ total: z.int(), byStatus: Counts }),
  approvals: z.object({ total: z.int(), byStatus: Counts }),
  daily: z.array(z.object({ date: z.string(), reviews: z.int(), findings: z.int() })),
});
export type AnalyticsResponse = z.infer<typeof AnalyticsResponseSchema>;

export const UsageByModelSchema = z.object({
  provider: z.string(),
  model: z.string(),
  executions: z.int(),
  failures: z.int(),
  inputTokens: z.int(),
  outputTokens: z.int(),
  cacheReadTokens: z.int(),
  costUsd: z.number(),
  /** Executions without a price (e.g. unpriced or local models). */
  unpricedExecutions: z.int(),
});
export type UsageByModel = z.infer<typeof UsageByModelSchema>;

export const UsageResponseSchema = z.object({
  from: TimestampSchema,
  to: TimestampSchema,
  totals: z.object({
    executions: z.int(),
    failures: z.int(),
    inputTokens: z.int(),
    outputTokens: z.int(),
    cacheReadTokens: z.int(),
    costUsd: z.number(),
    unpricedExecutions: z.int(),
    fixProposalCostUsd: z.number(),
  }),
  byModel: z.array(UsageByModelSchema),
  daily: z.array(z.object({ date: z.string(), executions: z.int(), costUsd: z.number() })),
  providers: z.array(AiProviderStatusSchema),
});
export type UsageResponse = z.infer<typeof UsageResponseSchema>;

export const AuditLogQuerySchema = z.object({
  ...PageQuerySchema.shape,
  /** Prefix match on the dotted action, e.g. "approval" or "member.". */
  action: z.optional(z.string().check(z.maxLength(100), z.regex(/^[a-z_.]+$/))),
});
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;

export const AuditLogEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.nullable(z.string()),
  actorType: AuditActorTypeSchema,
  actor: z.nullable(z.object({ id: z.string(), email: z.string(), displayName: z.string() })),
  metadata: z.record(z.string(), z.unknown()),
  requestId: z.nullable(z.string()),
  ipAddress: z.nullable(z.string()),
  createdAt: TimestampSchema,
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;
