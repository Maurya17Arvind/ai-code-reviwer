// Browser-safe: `zod/mini` keeps dashboard bundles small.
import { SeveritySchema } from '@acra/shared-types';
import * as z from 'zod/mini';
import { IdSchema, NullableTimestampSchema, TimestampSchema } from './common';

export const FixStatusSchema = z.enum(['proposed', 'applied', 'opened', 'superseded', 'rejected']);
export type FixStatus = z.infer<typeof FixStatusSchema>;

export const FixSummarySchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  repositoryName: z.string(),
  requestId: z.int(),
  findingId: z.string(),
  findingTitle: z.string(),
  severity: SeveritySchema,
  filePath: z.string(),
  status: FixStatusSchema,
  additions: z.int(),
  deletions: z.int(),
  provider: z.string(),
  model: z.string(),
  baseSha: z.string(),
  branch: z.string(),
  targetBranch: z.string(),
  reviewRequestUrl: z.nullable(z.string()),
  createdAt: TimestampSchema,
});
export type FixSummary = z.infer<typeof FixSummarySchema>;

export const FixDetailSchema = z.object({
  ...FixSummarySchema.shape,
  /** Model-written explanation: untrusted, rendered as plain text. */
  explanation: z.string(),
  /** Exact unified diff computed by the platform (not by the model). */
  patch: z.string(),
  patchSha256: z.string(),
  commitSha: z.nullable(z.string()),
  costUsd: z.nullable(z.number()),
  /** Which approval step can be requested next, if any. */
  nextStep: z.nullable(z.enum(['push', 'open'])),
});
export type FixDetail = z.infer<typeof FixDetailSchema>;

export const ApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'invalidated',
  'executing',
  'executed',
  'failed',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/** No merge operation exists anywhere in the platform (Module H). */
export const ApprovalOperationKindSchema = z.enum([
  'apply_fix',
  'stage_changes',
  'commit_changes',
  'push_branch',
  'commit_and_push_fix',
  'create_merge_request',
  'create_pull_request',
]);
export type ApprovalOperationKind = z.infer<typeof ApprovalOperationKindSchema>;

export const ApprovalActorSchema = z.object({ kind: z.string(), display: z.string() });

export const ApprovalSummarySchema = z.object({
  id: z.string(),
  operationKind: ApprovalOperationKindSchema,
  status: ApprovalStatusSchema,
  fixId: z.nullable(z.string()),
  repositoryId: z.string(),
  requestId: z.int(),
  headSha: z.string(),
  requestedBy: ApprovalActorSchema,
  decidedBy: z.nullable(ApprovalActorSchema),
  reason: z.nullable(z.string()),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  decidedAt: NullableTimestampSchema,
  executedAt: NullableTimestampSchema,
});
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;

export const ApprovalDetailSchema = z.object({
  ...ApprovalSummarySchema.shape,
  /** Human-readable lines describing exactly what will happen. */
  description: z.array(z.string()),
  patchSha256: z.nullable(z.string()),
  /**
   * 12-character code derived from the binding hash. The approver types it back, which proves
   * the decision was made on exactly this operation (ADR-032).
   */
  approvalCode: z.string(),
  /** Result of execution (branch, commit, MR/PR URL or a coarse error). */
  result: z.nullable(z.record(z.string(), z.unknown())),
});
export type ApprovalDetail = z.infer<typeof ApprovalDetailSchema>;

export const ApprovalListQuerySchema = z.object({ scope: z._default(z.enum(['open', 'all']), 'open') });
export type ApprovalListQuery = z.infer<typeof ApprovalListQuerySchema>;

export const CreateApprovalRequestSchema = z.object({
  fixId: IdSchema,
  step: z.enum(['push', 'open']),
  ttlHours: z._default(z.number().check(z.int(), z.gte(1), z.lte(168)), 24),
});
export type CreateApprovalRequest = z.infer<typeof CreateApprovalRequestSchema>;

export const ApproveRequestSchema = z.object({
  code: z.string().check(z.trim(), z.toLowerCase(), z.regex(/^[0-9a-f]{12}$/, 'enter the 12-character code')),
});
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;

export const RejectRequestSchema = z.object({
  reason: z.optional(z.string().check(z.trim(), z.maxLength(500))),
});
export type RejectRequest = z.infer<typeof RejectRequestSchema>;

export const ApprovalDecisionResponseSchema = z.object({
  approval: ApprovalSummarySchema,
  jobId: z.nullable(z.string()),
});
export type ApprovalDecisionResponse = z.infer<typeof ApprovalDecisionResponseSchema>;
