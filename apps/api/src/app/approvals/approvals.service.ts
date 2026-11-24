import { type ApprovalRequest, approvalCode, describeOperation } from '@acra/approvals';
import {
  ApprovalStore,
  ConnectionStore,
  InsightsStore,
  microsToUsd,
  ReviewStore,
  type StoredApproval,
} from '@acra/database';
import { ApprovalQueueProducer } from '@acra/queue';
import {
  type ApprovalDecisionResponse,
  type ApprovalDetail,
  type ApprovalOperationKind,
  type ApprovalStatus,
  type ApprovalSummary,
  type CreateApprovalRequest,
  type FixDetail,
  type FixStatus,
  type FixSummary,
} from '@acra/shared-contracts';
import { type Severity } from '@acra/shared-types';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import {
  type ApprovalAdminDeps,
  decideApproval,
  listApprovals,
  listFixes,
  requestApproval,
  showFix,
} from '../../admin/approvals-admin';
import { type AuthContext, type MembershipContext } from '../auth/auth-context';
import { mapErrors } from '../common/domain-errors';
import { tenant } from '../organizations/organizations.service';

const iso = (date: Date) => date.toISOString();

type FixRow = NonNullable<Awaited<ReturnType<typeof showFix>>>;
type FixListRow = Awaited<ReturnType<typeof listFixes>>[number];

function toFixSummary(row: FixListRow | FixRow, names: Map<string, string>): FixSummary {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    repositoryName: names.get(row.repositoryId) ?? row.repositoryId,
    requestId: row.requestId,
    findingId: row.findingId,
    findingTitle: row.finding.title,
    severity: row.finding.severity as Severity,
    filePath: row.filePath,
    status: row.status.toLowerCase() as FixStatus,
    additions: row.additions,
    deletions: row.deletions,
    provider: row.provider,
    model: row.model,
    baseSha: row.baseSha,
    branch: row.branch,
    targetBranch: row.targetBranch,
    reviewRequestUrl: row.reviewRequestUrl,
    createdAt: iso(row.createdAt),
  };
}

function toApprovalSummary(stored: StoredApproval): ApprovalSummary {
  const r = stored.request;
  return {
    id: r.id,
    operationKind: r.operation.kind as ApprovalOperationKind,
    status: r.status as ApprovalStatus,
    fixId: stored.proposedFixId,
    repositoryId: r.repositoryId,
    requestId: stored.requestId,
    headSha: r.headSha,
    requestedBy: { kind: r.requestedBy.kind, display: r.requestedBy.display },
    decidedBy: r.decidedBy ? { kind: r.decidedBy.kind, display: r.decidedBy.display } : null,
    reason: r.reason ?? null,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    decidedAt: r.decidedAt ?? null,
    executedAt: r.executedAt ?? null,
  };
}

/** Only short, known result fields reach the browser (no raw provider responses). */
function safeResult(result: ApprovalRequest['result']): Record<string, unknown> | null {
  if (!result) return null;
  const allowed = ['branch', 'commitSha', 'reviewRequestUrl', 'url', 'error', 'message', 'status'];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = result[key];
    if (typeof value === 'string') out[key] = value.slice(0, 500);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function codesMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Fix proposals and approval requests for the dashboard. All decisions go through the same
 * functions as the operator CLI (approvals-admin → @acra/approvals state machine); the API only
 * adds the authenticated member as the actor. Merging is not an operation anywhere.
 */
@Injectable()
export class ApprovalsService {
  private readonly deps: ApprovalAdminDeps;

  constructor(
    @Inject(ApprovalStore) approvals: ApprovalStore,
    @Inject(ReviewStore) reviews: ReviewStore,
    @Inject(ConnectionStore) connections: ConnectionStore,
    @Inject(InsightsStore) private readonly insights: InsightsStore,
    @Inject(ApprovalQueueProducer) producer: ApprovalQueueProducer,
  ) {
    this.deps = { approvals, reviews, connections, enqueue: (job) => producer.enqueueExecution(job) };
  }

  async listFixes(membership: MembershipContext): Promise<FixSummary[]> {
    const rows = await listFixes(this.deps, { organization: { tenant: tenant(membership) } });
    const names = await this.insights.repositoryNames(
      tenant(membership),
      rows.map((r) => r.repositoryId),
    );
    return rows.map((r) => toFixSummary(r, names));
  }

  async getFix(membership: MembershipContext, id: string): Promise<FixDetail> {
    const fix = await mapErrors(() => showFix(this.deps, { organization: { tenant: tenant(membership) }, fixId: id }));
    const names = await this.insights.repositoryNames(tenant(membership), [fix.repositoryId]);
    const nextStep = fix.status === 'PROPOSED' ? 'push' : fix.status === 'APPLIED' && fix.commitSha ? 'open' : null;
    return {
      ...toFixSummary(fix, names),
      explanation: fix.explanation,
      patch: fix.patch,
      patchSha256: fix.patchSha256,
      commitSha: fix.commitSha,
      costUsd: microsToUsd(fix.costMicros),
      nextStep,
    };
  }

  async listApprovals(membership: MembershipContext, scope: 'open' | 'all'): Promise<ApprovalSummary[]> {
    const rows = await listApprovals(this.deps, { organization: { tenant: tenant(membership) }, all: scope === 'all' });
    return rows.map(toApprovalSummary);
  }

  async getApproval(membership: MembershipContext, id: string): Promise<ApprovalDetail> {
    const stored = await this.deps.approvals.getApproval(tenant(membership), id);
    if (!stored) throw new NotFoundException('Approval request not found');
    return {
      ...toApprovalSummary(stored),
      description: describeOperation(stored.request.operation),
      patchSha256: stored.request.patchSha256,
      approvalCode: approvalCode(stored.request),
      result: safeResult(stored.request.result),
    };
  }

  async request(
    auth: AuthContext,
    membership: MembershipContext,
    input: CreateApprovalRequest,
  ): Promise<ApprovalDetail> {
    const { request } = await mapErrors(() =>
      requestApproval(this.deps, {
        organization: { tenant: tenant(membership) },
        fixId: input.fixId,
        step: input.step,
        requestedBy: auth.email,
        ttlHours: input.ttlHours,
      }),
    );
    return this.getApproval(membership, request.id);
  }

  /**
   * Approves exactly the request whose code the member typed. The state machine re-checks role,
   * expiry, binding hash and the reviewed commit; the worker re-verifies everything before writing.
   */
  async approve(
    auth: AuthContext,
    membership: MembershipContext,
    id: string,
    code: string,
  ): Promise<ApprovalDecisionResponse> {
    const stored = await this.deps.approvals.getApproval(tenant(membership), id);
    if (!stored) throw new NotFoundException('Approval request not found');
    if (!codesMatch(approvalCode(stored.request), code)) {
      throw new BadRequestException('The approval code does not match this request. Nothing was approved.');
    }
    const result = await mapErrors(() =>
      decideApproval(this.deps, {
        organization: { tenant: tenant(membership) },
        approvalId: id,
        decidedBy: auth.email,
        decision: 'approve',
      }),
    );
    const updated = await this.deps.approvals.getApproval(tenant(membership), id);
    return { approval: toApprovalSummary(updated ?? stored), jobId: result.jobId ?? null };
  }

  async reject(
    auth: AuthContext,
    membership: MembershipContext,
    id: string,
    reason: string | undefined,
  ): Promise<ApprovalDecisionResponse> {
    await mapErrors(() =>
      decideApproval(this.deps, {
        organization: { tenant: tenant(membership) },
        approvalId: id,
        decidedBy: auth.email,
        decision: 'reject',
        ...(reason ? { reason } : {}),
      }),
    );
    const updated = await this.deps.approvals.getApproval(tenant(membership), id);
    if (!updated) throw new NotFoundException('Approval request not found');
    return { approval: toApprovalSummary(updated), jobId: null };
  }
}
