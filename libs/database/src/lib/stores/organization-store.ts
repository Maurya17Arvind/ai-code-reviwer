import { Inject, Injectable } from '@nestjs/common';
import { type OrganizationRole, Prisma, type PrismaClient } from '../../generated/prisma/client';
import { PRISMA_CLIENT } from '../tokens';
import { type TenantContext } from './review-store';

export class OrganizationStoreError extends Error {
  constructor(
    readonly code: 'slug_taken' | 'already_member' | 'not_found' | 'last_owner',
    message: string,
  ) {
    super(message);
    this.name = 'OrganizationStoreError';
  }
}

export interface OrganizationPolicy {
  readonly reviewsEnabled: boolean;
  readonly allowClaude: boolean;
  readonly allowOpenai: boolean;
  readonly allowOllama: boolean;
  readonly allowFixProposals: boolean;
  readonly minimumSeverityFloor: string | null;
  readonly minimumConfidenceFloor: number | null;
}

/** Policy used when an organization never saved settings: nothing is restricted. */
export const DEFAULT_ORGANIZATION_POLICY: OrganizationPolicy = {
  reviewsEnabled: true,
  allowClaude: true,
  allowOpenai: true,
  allowOllama: true,
  allowFixProposals: true,
  minimumSeverityFloor: null,
  minimumConfidenceFloor: null,
};

/** Audit context of an authenticated HTTP request. */
export interface RequestAuditContext {
  readonly actorUserId: string;
  readonly requestId?: string | null;
  readonly ipAddress?: string | null;
}

const MEMBER_SELECT = {
  id: true,
  role: true,
  createdAt: true,
  user: { select: { id: true, email: true, displayName: true, passwordHash: true, lastLoginAt: true } },
} as const;

type MemberRow = Prisma.OrganizationMemberGetPayload<{ select: typeof MEMBER_SELECT }>;

function toMember(row: MemberRow) {
  return {
    id: row.id,
    userId: row.user.id,
    email: row.user.email,
    displayName: row.user.displayName,
    role: row.role,
    hasPassword: row.user.passwordHash !== null,
    lastLoginAt: row.user.lastLoginAt,
    createdAt: row.createdAt,
  };
}
export type MemberRecord = ReturnType<typeof toMember>;

/**
 * Organization administration for the dashboard: organizations, members, policy, repositories
 * and connections. Every tenant query filters by organization_id (ADR-010); credentials are never
 * selected.
 */
@Injectable()
export class OrganizationStore {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  // ---------------- organizations ----------------

  /** Creates an organization with its creator as OWNER, in one transaction. */
  async createOrganization(input: { name: string; slug: string; ownerUserId: string }, audit: RequestAuditContext) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({
          data: { name: input.name, slug: input.slug },
          select: { id: true, name: true, slug: true, createdAt: true },
        });
        await tx.organizationMember.create({
          data: { organizationId: org.id, userId: input.ownerUserId, role: 'OWNER' },
        });
        await tx.auditLog.create({
          data: auditData(org.id, audit, 'organization.created', 'organization', org.id, { slug: org.slug }),
        });
        return org;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new OrganizationStoreError('slug_taken', 'This slug is already in use');
      }
      throw error;
    }
  }

  async getOrganization(tenant: TenantContext) {
    return this.prisma.organization.findFirst({
      where: { id: tenant.organizationId, deletedAt: null },
      select: { id: true, name: true, slug: true, createdAt: true },
    });
  }

  async renameOrganization(tenant: TenantContext, name: string, audit: RequestAuditContext) {
    return this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.update({
        where: { id: tenant.organizationId },
        data: { name },
        select: { id: true, name: true, slug: true, createdAt: true },
      });
      await tx.auditLog.create({
        data: auditData(tenant.organizationId, audit, 'organization.renamed', 'organization', org.id, {}),
      });
      return org;
    });
  }

  // ---------------- members ----------------

  async listMembers(tenant: TenantContext): Promise<MemberRecord[]> {
    const rows = await this.prisma.organizationMember.findMany({
      where: { organizationId: tenant.organizationId, user: { deletedAt: null } },
      select: MEMBER_SELECT,
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toMember);
  }

  async getMember(tenant: TenantContext, memberId: string): Promise<MemberRecord | null> {
    const row = await this.prisma.organizationMember.findFirst({
      where: { id: memberId, organizationId: tenant.organizationId },
      select: MEMBER_SELECT,
    });
    return row ? toMember(row) : null;
  }

  /** Adds a member, creating the user (without a password) when the e-mail is new. */
  async addMember(
    tenant: TenantContext,
    input: { email: string; displayName: string; role: OrganizationRole },
    audit: RequestAuditContext,
  ): Promise<MemberRecord> {
    const email = input.email.trim().toLowerCase();
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { email },
        create: { email, displayName: input.displayName.slice(0, 200) },
        update: {},
        select: { id: true, deletedAt: true },
      });
      if (user.deletedAt) throw new OrganizationStoreError('not_found', 'This user account is disabled');
      const existing = await tx.organizationMember.findFirst({
        where: { organizationId: tenant.organizationId, userId: user.id },
        select: { id: true },
      });
      if (existing) throw new OrganizationStoreError('already_member', 'This person is already a member');
      const row = await tx.organizationMember.create({
        data: { organizationId: tenant.organizationId, userId: user.id, role: input.role },
        select: MEMBER_SELECT,
      });
      await tx.auditLog.create({
        data: auditData(tenant.organizationId, audit, 'member.added', 'user', user.id, { role: input.role }),
      });
      return toMember(row);
    });
  }

  /**
   * Changes a member's role. The organization always keeps at least one OWNER; the check runs in a
   * serializable transaction so two concurrent demotions cannot both succeed.
   */
  async updateMemberRole(
    tenant: TenantContext,
    memberId: string,
    role: OrganizationRole,
    audit: RequestAuditContext,
  ): Promise<MemberRecord> {
    return this.prisma.$transaction(
      async (tx) => {
        const current = await tx.organizationMember.findFirst({
          where: { id: memberId, organizationId: tenant.organizationId },
          select: { role: true, userId: true },
        });
        if (!current) throw new OrganizationStoreError('not_found', 'Member not found');
        if (current.role === 'OWNER' && role !== 'OWNER') await assertAnotherOwner(tx, tenant, memberId);
        const row = await tx.organizationMember.update({
          where: { id: memberId },
          data: { role },
          select: MEMBER_SELECT,
        });
        await tx.auditLog.create({
          data: auditData(tenant.organizationId, audit, 'member.role_changed', 'user', current.userId, {
            from: current.role,
            to: role,
          }),
        });
        return toMember(row);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async removeMember(tenant: TenantContext, memberId: string, audit: RequestAuditContext): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        const current = await tx.organizationMember.findFirst({
          where: { id: memberId, organizationId: tenant.organizationId },
          select: { role: true, userId: true },
        });
        if (!current) throw new OrganizationStoreError('not_found', 'Member not found');
        if (current.role === 'OWNER') await assertAnotherOwner(tx, tenant, memberId);
        await tx.organizationMember.delete({ where: { id: memberId } });
        await tx.auditLog.create({
          data: auditData(tenant.organizationId, audit, 'member.removed', 'user', current.userId, {
            role: current.role,
          }),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  // ---------------- policy ----------------

  async getPolicy(tenant: TenantContext): Promise<OrganizationPolicy & { updatedAt: Date | null }> {
    const row = await this.prisma.organizationSettings.findUnique({ where: { organizationId: tenant.organizationId } });
    if (!row) return { ...DEFAULT_ORGANIZATION_POLICY, updatedAt: null };
    return {
      reviewsEnabled: row.reviewsEnabled,
      allowClaude: row.allowClaude,
      allowOpenai: row.allowOpenai,
      allowOllama: row.allowOllama,
      allowFixProposals: row.allowFixProposals,
      minimumSeverityFloor: row.minimumSeverityFloor,
      minimumConfidenceFloor: row.minimumConfidenceFloor,
      updatedAt: row.updatedAt,
    };
  }

  async savePolicy(tenant: TenantContext, policy: OrganizationPolicy, audit: RequestAuditContext) {
    return this.prisma.$transaction(async (tx) => {
      const data = { ...policy, updatedById: audit.actorUserId };
      const row = await tx.organizationSettings.upsert({
        where: { organizationId: tenant.organizationId },
        create: { organizationId: tenant.organizationId, ...data },
        update: data,
        select: { updatedAt: true },
      });
      await tx.auditLog.create({
        data: auditData(tenant.organizationId, audit, 'settings.updated', 'organization', tenant.organizationId, {
          ...policy,
        }),
      });
      return { ...policy, updatedAt: row.updatedAt };
    });
  }

  // ---------------- repositories & connections ----------------

  async listRepositories(tenant: TenantContext) {
    const rows = await this.prisma.repository.findMany({
      where: { organizationId: tenant.organizationId, deletedAt: null },
      select: {
        id: true,
        provider: true,
        fullName: true,
        defaultBranch: true,
        webUrl: true,
        isActive: true,
        connectionId: true,
        webhookId: true,
        createdAt: true,
        connection: { select: { name: true } },
        sessions: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { fullName: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      fullName: r.fullName,
      defaultBranch: r.defaultBranch,
      webUrl: r.webUrl,
      isActive: r.isActive,
      connectionId: r.connectionId,
      connectionName: r.connection?.name ?? null,
      webhookConfigured: r.provider === 'GITHUB' || r.webhookId !== null,
      lastReviewAt: r.sessions[0]?.createdAt ?? null,
      createdAt: r.createdAt,
    }));
  }

  async setRepositoryActive(
    tenant: TenantContext,
    repositoryId: string,
    isActive: boolean,
    audit: RequestAuditContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.repository.updateMany({
        where: { id: repositoryId, organizationId: tenant.organizationId, deletedAt: null },
        data: { isActive },
      });
      if (result.count !== 1) throw new OrganizationStoreError('not_found', 'Repository not found');
      await tx.auditLog.create({
        data: auditData(
          tenant.organizationId,
          audit,
          isActive ? 'repository.activated' : 'repository.deactivated',
          'repository',
          repositoryId,
          {},
        ),
      });
    });
  }

  async listConnections(tenant: TenantContext) {
    const rows = await this.prisma.providerConnection.findMany({
      where: { organizationId: tenant.organizationId, deletedAt: null },
      select: {
        id: true,
        provider: true,
        name: true,
        baseUrl: true,
        accountLogin: true,
        installationId: true,
        tokenKeyId: true,
        createdAt: true,
        _count: { select: { repositories: { where: { deletedAt: null } } } },
      },
      orderBy: [{ provider: 'asc' }, { name: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      name: r.name,
      baseUrl: r.baseUrl,
      accountLogin: r.accountLogin,
      installationId: r.installationId,
      hasStoredToken: r.tokenKeyId !== null,
      repositoryCount: r._count.repositories,
      createdAt: r.createdAt,
    }));
  }
}

async function assertAnotherOwner(tx: Prisma.TransactionClient, tenant: TenantContext, exceptMemberId: string) {
  const owners = await tx.organizationMember.count({
    where: { organizationId: tenant.organizationId, role: 'OWNER', id: { not: exceptMemberId } },
  });
  if (owners === 0) throw new OrganizationStoreError('last_owner', 'An organization must keep at least one owner');
}

export function auditData(
  organizationId: string,
  audit: RequestAuditContext,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, unknown>,
): Prisma.AuditLogUncheckedCreateInput {
  return {
    organizationId,
    actorType: 'USER',
    actorUserId: audit.actorUserId,
    action,
    targetType,
    targetId,
    metadata: metadata as Prisma.InputJsonValue,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
  };
}
