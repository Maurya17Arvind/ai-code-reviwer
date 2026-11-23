import { type Actor, type ApprovalOperation, type ApprovalRequest, type ApprovalStatus } from '@acra/approvals';
import { Inject, Injectable } from '@nestjs/common';
import {
  type ApprovalOperationKind,
  type ApprovalStatus as DbApprovalStatus,
  type OrganizationRole,
  Prisma,
  type PrismaClient,
  type ProposedFixStatus,
} from '../../generated/prisma/client';
import { PRISMA_CLIENT } from '../tokens';
import { type TenantContext } from './review-store';

export interface ProposedFixInput {
  readonly id: string;
  readonly repositoryId: string;
  readonly reviewSessionId: string;
  readonly findingId: string;
  readonly requestId: number;
  readonly fingerprint: string;
  readonly filePath: string;
  readonly baseSha: string;
  readonly targetBranch: string;
  readonly explanation: string;
  readonly changes: unknown;
  readonly patch: string;
  readonly patchSha256: string;
  readonly originalSha256: string;
  readonly resultSha256: string;
  readonly additions: number;
  readonly deletions: number;
  readonly provider: string;
  readonly model: string;
  readonly costUsd: number | null;
  readonly branch: string;
}

export type StoredFix = Awaited<ReturnType<ApprovalStore['getFix']>>;

/** An approval as the domain sees it, plus the relational columns around it. */
export interface StoredApproval {
  readonly request: ApprovalRequest;
  readonly requestId: number;
  readonly proposedFixId: string | null;
  readonly requestedById: string;
  readonly decidedById: string | null;
}

const toDbStatus = (status: ApprovalStatus) => status.toUpperCase() as DbApprovalStatus;
const toKind = (operation: ApprovalOperation) => operation.kind.toUpperCase() as ApprovalOperationKind;

type ApprovalRow = Prisma.ApprovalRequestGetPayload<object>;

function toDomain(row: ApprovalRow): StoredApproval {
  const request: ApprovalRequest = {
    id: row.id,
    organizationId: row.organizationId,
    repositoryId: row.repositoryId,
    reviewSessionId: row.reviewSessionId,
    headSha: row.headSha,
    operation: row.operation as unknown as ApprovalOperation,
    patchSha256: row.patchSha256,
    requestedBy: row.requestedBy as unknown as Actor,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    bindingHash: row.bindingHash,
    status: row.status.toLowerCase() as ApprovalStatus,
    ...(row.decidedBy ? { decidedBy: row.decidedBy as unknown as Actor } : {}),
    ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.executedAt ? { executedAt: row.executedAt.toISOString() } : {}),
    ...(row.result ? { result: row.result as Record<string, unknown> } : {}),
  };
  return {
    request,
    requestId: row.requestId,
    proposedFixId: row.proposedFixId,
    requestedById: row.requestedById,
    decidedById: row.decidedById,
  };
}

/**
 * Persistence for fix proposals and approval requests (Modules G and H). Every method is
 * tenant-scoped. Status changes are compare-and-set on the previous status, so an approval can be
 * decided once and executed once even with concurrent workers or operators.
 */
@Injectable()
export class ApprovalStore {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  // ---------------- people ----------------

  /** Organization member by e-mail (lower-cased), or null. Only members can request or decide. */
  async memberByEmail(tenant: TenantContext, email: string) {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        organizationId: tenant.organizationId,
        user: { email: email.trim().toLowerCase(), deletedAt: null },
      },
      select: { role: true, user: { select: { id: true, email: true, displayName: true } } },
    });
    return member
      ? { userId: member.user.id, email: member.user.email, displayName: member.user.displayName, role: member.role }
      : null;
  }

  async addMember(tenant: TenantContext, input: { email: string; displayName: string; role: OrganizationRole }) {
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.user.upsert({
      where: { email },
      create: { email, displayName: input.displayName.slice(0, 200) },
      update: {},
      select: { id: true },
    });
    await this.prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId: tenant.organizationId, userId: user.id } },
      create: { organizationId: tenant.organizationId, userId: user.id, role: input.role },
      update: { role: input.role },
    });
    return { userId: user.id };
  }

  // ---------------- fixes ----------------

  async findingId(tenant: TenantContext, repositoryId: string, requestId: number, fingerprint: string) {
    const row = await this.prisma.reviewFinding.findFirst({
      where: { organizationId: tenant.organizationId, repositoryId, requestId, fingerprint },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async saveProposedFix(tenant: TenantContext, input: ProposedFixInput): Promise<void> {
    // Explicit field list: a new proposal always starts PROPOSED, whatever the caller passes.
    await this.prisma.proposedFix.create({
      data: {
        id: input.id,
        organizationId: tenant.organizationId,
        repositoryId: input.repositoryId,
        reviewSessionId: input.reviewSessionId,
        findingId: input.findingId,
        requestId: input.requestId,
        fingerprint: input.fingerprint,
        filePath: input.filePath.slice(0, 1000),
        baseSha: input.baseSha,
        targetBranch: input.targetBranch.slice(0, 255),
        explanation: input.explanation,
        changes: input.changes as Prisma.InputJsonValue,
        patch: input.patch,
        patchSha256: input.patchSha256,
        originalSha256: input.originalSha256,
        resultSha256: input.resultSha256,
        additions: input.additions,
        deletions: input.deletions,
        provider: input.provider,
        model: input.model.slice(0, 100),
        costMicros: input.costUsd === null ? null : BigInt(Math.round(input.costUsd * 1_000_000)),
        branch: input.branch,
        status: 'PROPOSED',
      },
    });
  }

  async getFix(tenant: TenantContext, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return this.prisma.proposedFix.findFirst({
      where: { id, organizationId: tenant.organizationId },
      include: { finding: { select: { title: true, severity: true, category: true } } },
    });
  }

  async listFixes(
    tenant: TenantContext,
    filter: { repositoryId?: string; status?: ProposedFixStatus; take?: number } = {},
  ) {
    return this.prisma.proposedFix.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(filter.repositoryId ? { repositoryId: filter.repositoryId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.take ?? 50, 200),
      include: { finding: { select: { title: true, severity: true } } },
    });
  }

  async updateFix(
    tenant: TenantContext,
    id: string,
    from: ProposedFixStatus,
    data: { status: ProposedFixStatus; commitSha?: string; reviewRequestUrl?: string },
  ): Promise<boolean> {
    const result = await this.prisma.proposedFix.updateMany({
      where: { id, organizationId: tenant.organizationId, status: from },
      data,
    });
    return result.count === 1;
  }

  /** Head commit of the latest successful review of an MR/PR. */
  async latestReviewedHead(tenant: TenantContext, repositoryId: string, requestId: number): Promise<string | null> {
    const session = await this.prisma.reviewSession.findFirst({
      where: {
        organizationId: tenant.organizationId,
        repositoryId,
        requestId,
        status: { in: ['COMPLETED', 'PARTIAL'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { headSha: true },
    });
    return session?.headSha ?? null;
  }

  /**
   * A new commit was reviewed: open approvals bound to another commit become INVALIDATED and
   * unapplied fixes for another commit become SUPERSEDED (Module H).
   */
  async invalidateForHead(tenant: TenantContext, repositoryId: string, requestId: number, headSha: string) {
    return this.prisma.$transaction(async (tx) => {
      const approvals = await tx.approvalRequest.updateMany({
        where: {
          organizationId: tenant.organizationId,
          repositoryId,
          requestId,
          status: { in: ['PENDING', 'APPROVED'] },
          headSha: { not: headSha },
        },
        data: { status: 'INVALIDATED', reason: 'a newer commit was reviewed' },
      });
      const fixes = await tx.proposedFix.updateMany({
        where: {
          organizationId: tenant.organizationId,
          repositoryId,
          requestId,
          status: 'PROPOSED',
          baseSha: { not: headSha },
        },
        data: { status: 'SUPERSEDED' },
      });
      return { approvals: approvals.count, fixes: fixes.count };
    });
  }

  // ---------------- approvals ----------------

  async createApproval(
    tenant: TenantContext,
    request: ApprovalRequest,
    extra: { requestId: number; proposedFixId: string | null; requestedById: string },
  ): Promise<void> {
    if (request.organizationId !== tenant.organizationId) throw new Error('Approval belongs to another organization');
    await this.prisma.approvalRequest.create({
      data: {
        id: request.id,
        organizationId: tenant.organizationId,
        repositoryId: request.repositoryId,
        reviewSessionId: request.reviewSessionId,
        proposedFixId: extra.proposedFixId,
        requestId: extra.requestId,
        headSha: request.headSha,
        operationKind: toKind(request.operation),
        operation: request.operation as unknown as Prisma.InputJsonValue,
        patchSha256: request.patchSha256,
        bindingHash: request.bindingHash,
        status: toDbStatus(request.status),
        requestedById: extra.requestedById,
        requestedBy: request.requestedBy as unknown as Prisma.InputJsonValue,
        createdAt: new Date(request.createdAt),
        expiresAt: new Date(request.expiresAt),
      },
    });
  }

  async getApproval(tenant: TenantContext, id: string): Promise<StoredApproval | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const row = await this.prisma.approvalRequest.findFirst({ where: { id, organizationId: tenant.organizationId } });
    return row ? toDomain(row) : null;
  }

  async listApprovals(tenant: TenantContext, filter: { statuses?: ApprovalStatus[]; take?: number } = {}) {
    const rows = await this.prisma.approvalRequest.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(filter.statuses ? { status: { in: filter.statuses.map(toDbStatus) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.take ?? 50, 200),
    });
    return rows.map(toDomain);
  }

  /**
   * Persists a state-machine transition iff the stored status is still `from` (compare-and-set).
   * Returns false when another actor changed the request first.
   */
  async transition(
    tenant: TenantContext,
    next: ApprovalRequest,
    from: ApprovalStatus,
    extra: { decidedById?: string } = {},
  ): Promise<boolean> {
    const result = await this.prisma.approvalRequest.updateMany({
      where: {
        id: next.id,
        organizationId: tenant.organizationId,
        status: toDbStatus(from),
        bindingHash: next.bindingHash,
      },
      data: {
        status: toDbStatus(next.status),
        ...(extra.decidedById ? { decidedById: extra.decidedById } : {}),
        ...(next.decidedBy ? { decidedBy: next.decidedBy as unknown as Prisma.InputJsonValue } : {}),
        ...(next.decidedAt ? { decidedAt: new Date(next.decidedAt) } : {}),
        ...(next.reason ? { reason: next.reason.slice(0, 500) } : {}),
        ...(next.executedAt ? { executedAt: new Date(next.executedAt) } : {}),
        ...(next.result ? { result: next.result as Prisma.InputJsonValue } : {}),
      },
    });
    return result.count === 1;
  }

  /** Executed operations of a fix (to check prerequisites such as "pushed before MR/PR"). */
  async executedOperations(tenant: TenantContext, proposedFixId: string): Promise<string[]> {
    const rows = await this.prisma.approvalRequest.findMany({
      where: { organizationId: tenant.organizationId, proposedFixId, status: 'EXECUTED' },
      select: { operationKind: true },
    });
    return rows.map((r) => r.operationKind.toLowerCase());
  }
}
