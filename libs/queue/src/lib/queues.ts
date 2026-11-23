import * as z from 'zod';

/**
 * Queue registry. Every queue and job name lives here so producers (api) and
 * consumers (worker) cannot drift apart. Review, publishing and fix queues are
 * added in the phases that introduce them.
 */
export const QueueName = {
  /** Infrastructure jobs: heartbeats, maintenance. */
  System: 'system',
  /** AI reviews of merge/pull requests (Phase 4+). */
  Reviews: 'reviews',
  /** Execution of human-approved Git operations (Phase 6). */
  Approvals: 'approvals',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const ReviewJobName = {
  MergeRequest: 'review-merge-request',
} as const;

/**
 * Payload of reviews:review-merge-request. Contains identifiers only — never code, tokens or
 * provider payloads; the worker re-fetches everything from the provider at `headSha`.
 */
export const ReviewMergeRequestJobSchema = z.object({
  organizationId: z.uuid(),
  repositoryId: z.uuid(),
  provider: z.enum(['gitlab', 'github']),
  requestId: z.int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  deliveryId: z.string().min(1).max(200),
  trigger: z.enum(['webhook', 'manual']),
});
export type ReviewMergeRequestJob = z.infer<typeof ReviewMergeRequestJobSchema>;

/** One job per (repository, MR, head commit). BullMQ job ids may not contain ':'. */
export function reviewJobId(
  job: Pick<ReviewMergeRequestJob, 'provider' | 'repositoryId' | 'requestId' | 'headSha'>,
): string {
  return `${job.provider}_${job.repositoryId}_${job.requestId}_${job.headSha}`;
}

export const ApprovalJobName = {
  Execute: 'execute-approval',
} as const;

/**
 * Payload of approvals:execute-approval. Only ids: the worker re-loads the approval, re-verifies its
 * binding, expiry, the provider's current head commit and the patch hash before writing anything.
 */
export const ExecuteApprovalJobSchema = z.object({
  organizationId: z.uuid(),
  approvalId: z.uuid(),
});
export type ExecuteApprovalJob = z.infer<typeof ExecuteApprovalJobSchema>;

/** One job per approval (an approval is single use). */
export function approvalJobId(approvalId: string): string {
  return `approval_${approvalId}`;
}

export const SystemJobName = {
  Heartbeat: 'heartbeat',
} as const;
export type SystemJobName = (typeof SystemJobName)[keyof typeof SystemJobName];

/** Payload of system:heartbeat — proves end-to-end api → Redis → worker wiring. */
export const HeartbeatJobSchema = z.object({
  correlationId: z.uuid(),
  requestedAt: z.iso.datetime(),
  source: z.enum(['api', 'worker', 'test']),
});
export type HeartbeatJob = z.infer<typeof HeartbeatJobSchema>;

export const HeartbeatResultSchema = z.object({
  correlationId: z.uuid(),
  processedAt: z.iso.datetime(),
});
export type HeartbeatResult = z.infer<typeof HeartbeatResultSchema>;
