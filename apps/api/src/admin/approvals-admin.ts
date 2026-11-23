import {
  type Actor,
  type ApprovalOperation,
  type ApprovalRequest,
  ApprovalError,
  approve,
  createApprovalRequest,
  describeOperation,
  reject,
} from '@acra/approvals';
import { type ApprovalStore, type ConnectionStore, type ReviewStore, type TenantContext } from '@acra/database';
import { fixCommitMessage, fixReviewRequestText } from '@acra/publishing';
import { type ExecuteApprovalJob } from '@acra/queue';

/**
 * Approval management for hosted repositories (Module H). Used by the operator CLI now and by the
 * authenticated API in Phase 7. Every decision is taken by a named organization member; untrusted
 * content (code, comments, AI output) can never create, approve or widen a request — operations are
 * built here from stored, validated fields only.
 */
export interface ApprovalAdminDeps {
  readonly approvals: ApprovalStore;
  readonly reviews: ReviewStore;
  readonly connections: ConnectionStore;
  /** Enqueues execution after approval (BullMQ `approvals` queue). */
  readonly enqueue: (job: ExecuteApprovalJob) => Promise<{ jobId: string }>;
}

export class ApprovalAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalAdminError';
  }
}

async function tenantFor(deps: ApprovalAdminDeps, slug: string): Promise<TenantContext> {
  const tenant = await deps.connections.findOrganization(slug);
  if (!tenant) throw new ApprovalAdminError(`Organization "${slug}" not found`);
  return tenant;
}

async function member(deps: ApprovalAdminDeps, tenant: TenantContext, email: string) {
  const found = await deps.approvals.memberByEmail(tenant, email);
  if (!found) throw new ApprovalAdminError(`${email} is not a member of this organization`);
  const actor: Actor = { kind: 'user', id: found.userId, display: found.email };
  return { ...found, actor };
}

export async function addMember(
  deps: ApprovalAdminDeps,
  input: {
    organizationSlug: string;
    email: string;
    displayName: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  },
) {
  if (!/^[^\s@]+@[^\s@]+$/.test(input.email) || input.email.length > 320)
    throw new ApprovalAdminError('Invalid e-mail');
  const tenant = await tenantFor(deps, input.organizationSlug);
  const result = await deps.approvals.addMember(tenant, input);
  await deps.reviews.audit(tenant.organizationId, {
    action: 'member.upserted',
    targetType: 'user',
    targetId: result.userId,
    metadata: { role: input.role },
  });
  return result;
}

/**
 * Creates a PENDING approval request for the next step of a fix:
 *  - `push`: create the fix branch with one commit containing exactly the proposed patch
 *    (apply + stage + commit + push as one remote write — there is no working tree on the server);
 *  - `open`: open a merge/pull request from the fix branch into the reviewed MR/PR's source branch.
 */
export async function requestApproval(
  deps: ApprovalAdminDeps,
  input: { organizationSlug: string; fixId: string; step: 'push' | 'open'; requestedBy: string; ttlHours?: number },
): Promise<{ request: ApprovalRequest; description: string[] }> {
  const tenant = await tenantFor(deps, input.organizationSlug);
  const requester = await member(deps, tenant, input.requestedBy);
  const fix = await deps.approvals.getFix(tenant, input.fixId);
  if (!fix) throw new ApprovalAdminError('Fix not found');
  const repository = await deps.reviews.findRepositoryForReview(fix.repositoryId);
  if (!repository || repository.organizationId !== tenant.organizationId)
    throw new ApprovalAdminError('Repository not found');

  const head = await deps.approvals.latestReviewedHead(tenant, fix.repositoryId, fix.requestId);
  if (head !== fix.baseSha) {
    throw new ApprovalAdminError(
      'A newer commit was reviewed since this fix was proposed; it can no longer be approved',
    );
  }
  const text = { finding: fix.finding, proposal: fix };
  let operation: ApprovalOperation;
  if (input.step === 'push') {
    if (fix.status !== 'PROPOSED')
      throw new ApprovalAdminError(`Fix is ${fix.status.toLowerCase()}; push needs a proposed fix`);
    operation = {
      kind: 'commit_and_push_fix',
      fixId: fix.id,
      filePath: fix.filePath,
      branch: fix.branch,
      message: fixCommitMessage(text),
    };
  } else {
    if (fix.status !== 'APPLIED' || !fix.commitSha)
      throw new ApprovalAdminError('Push the fix (approved) before opening a merge/pull request');
    operation = {
      kind: repository.provider === 'GITLAB' ? 'create_merge_request' : 'create_pull_request',
      fixId: fix.id,
      sourceBranch: fix.branch,
      targetBranch: fix.targetBranch,
      title: fixReviewRequestText(text).title,
      commitSha: fix.commitSha,
    };
  }

  let request: ApprovalRequest;
  try {
    request = createApprovalRequest({
      organizationId: tenant.organizationId,
      repositoryId: fix.repositoryId,
      reviewSessionId: fix.reviewSessionId,
      headSha: fix.baseSha,
      operation,
      patchSha256: fix.patchSha256,
      requestedBy: requester.actor,
      ...(input.ttlHours ? { ttlMs: input.ttlHours * 3_600_000 } : {}),
    });
  } catch (error) {
    throw new ApprovalAdminError(error instanceof Error ? error.message : 'Invalid request');
  }
  await deps.approvals.createApproval(tenant, request, {
    requestId: fix.requestId,
    proposedFixId: fix.id,
    requestedById: requester.userId,
  });
  await deps.reviews.audit(tenant.organizationId, {
    action: 'approval.requested',
    targetType: 'approval_request',
    targetId: request.id,
    actorType: 'USER',
    actorUserId: requester.userId,
    metadata: { operation: operation.kind, fixId: fix.id },
  });
  return { request, description: describeOperation(operation) };
}

/** Approves (and enqueues execution) or rejects a pending request on behalf of a member. */
export async function decideApproval(
  deps: ApprovalAdminDeps,
  input: {
    organizationSlug: string;
    approvalId: string;
    decidedBy: string;
    decision: 'approve' | 'reject';
    reason?: string;
  },
): Promise<{ request: ApprovalRequest; jobId?: string }> {
  const tenant = await tenantFor(deps, input.organizationSlug);
  const decider = await member(deps, tenant, input.decidedBy);
  const stored = await deps.approvals.getApproval(tenant, input.approvalId);
  if (!stored) throw new ApprovalAdminError('Approval request not found');
  const now = new Date();

  let next: ApprovalRequest;
  try {
    if (input.decision === 'reject') {
      next = reject(stored.request, { actor: decider.actor, role: decider.role, now }, input.reason);
    } else {
      const head = await deps.approvals.latestReviewedHead(tenant, stored.request.repositoryId, stored.requestId);
      next = approve(stored.request, { actor: decider.actor, role: decider.role, now, currentHeadSha: head ?? '' });
    }
  } catch (error) {
    if (error instanceof ApprovalError) throw new ApprovalAdminError(error.message);
    throw error;
  }
  if (!(await deps.approvals.transition(tenant, next, 'pending', { decidedById: decider.userId }))) {
    throw new ApprovalAdminError('The request was changed concurrently; nothing was done');
  }
  await deps.reviews.audit(tenant.organizationId, {
    action: `approval.${next.status}`,
    targetType: 'approval_request',
    targetId: next.id,
    actorType: 'USER',
    actorUserId: decider.userId,
    metadata: { operation: next.operation.kind },
  });
  if (next.status !== 'approved') return { request: next };
  const { jobId } = await deps.enqueue({ organizationId: tenant.organizationId, approvalId: next.id });
  return { request: next, jobId };
}

export async function listApprovals(deps: ApprovalAdminDeps, input: { organizationSlug: string; all: boolean }) {
  const tenant = await tenantFor(deps, input.organizationSlug);
  return deps.approvals.listApprovals(tenant, input.all ? {} : { statuses: ['pending', 'approved', 'executing'] });
}

export async function listFixes(deps: ApprovalAdminDeps, input: { organizationSlug: string }) {
  return deps.approvals.listFixes(await tenantFor(deps, input.organizationSlug));
}

export async function showFix(deps: ApprovalAdminDeps, input: { organizationSlug: string; fixId: string }) {
  const fix = await deps.approvals.getFix(await tenantFor(deps, input.organizationSlug), input.fixId);
  if (!fix) throw new ApprovalAdminError('Fix not found');
  return fix;
}
