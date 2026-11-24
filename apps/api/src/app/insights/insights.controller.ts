import { InsightsStore, type TenantContext } from '@acra/database';
import {
  type AnalyticsResponse,
  type AuditLogEntry,
  type AuditLogQuery,
  AuditLogQuerySchema,
  type InsightsQuery,
  InsightsQuerySchema,
  type Page,
  type UsageResponse,
} from '@acra/shared-contracts';
import { type AuditActorType } from '@acra/shared-types';
import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { CurrentMembership, type MembershipContext, MinRole } from '../auth/auth-context';
import { OrganizationGuard } from '../auth/guards';
import { zod } from '../common/zod-validation.pipe';
import { OrganizationsService } from '../organizations/organizations.service';

const tenantOf = (m: MembershipContext): TenantContext => ({ organizationId: m.organizationId });

/** Keys whose values are never shown in the audit log view, even if a writer stored them. */
const SECRET_KEY = /token|secret|password|key|authorization|cookie/i;

function safeMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key) && !/^(tokenKeyId)$/.test(key)) continue;
    out[key] = typeof v === 'string' ? v.slice(0, 500) : v;
  }
  return out;
}

/** Review analytics, AI usage and cost, and the organization audit log. */
@Controller('v1/organizations/:orgId')
@UseGuards(OrganizationGuard)
export class InsightsController {
  constructor(
    @Inject(InsightsStore) private readonly store: InsightsStore,
    @Inject(OrganizationsService) private readonly organizations: OrganizationsService,
  ) {}

  @Get('analytics')
  async analytics(
    @CurrentMembership() membership: MembershipContext,
    @Query(zod(InsightsQuerySchema)) query: InsightsQuery,
  ): Promise<AnalyticsResponse> {
    const result = await this.store.analytics(tenantOf(membership), {
      days: query.days,
      ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
    });
    return { ...result, from: result.from.toISOString(), to: result.to.toISOString() };
  }

  @Get('usage')
  async usage(
    @CurrentMembership() membership: MembershipContext,
    @Query(zod(InsightsQuerySchema)) query: InsightsQuery,
  ): Promise<UsageResponse> {
    const [result, providers] = await Promise.all([
      this.store.usage(tenantOf(membership), {
        days: query.days,
        ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
      }),
      this.organizations.providerStatus(membership),
    ]);
    return { ...result, from: result.from.toISOString(), to: result.to.toISOString(), providers };
  }

  /** The audit log can reveal who did what across the organization: ADMIN or higher. */
  @Get('audit-logs')
  @MinRole('ADMIN')
  async auditLogs(
    @CurrentMembership() membership: MembershipContext,
    @Query(zod(AuditLogQuerySchema)) query: AuditLogQuery,
  ): Promise<Page<AuditLogEntry>> {
    const result = await this.store.listAuditLogs(tenantOf(membership), {
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.action ? { action: query.action } : {}),
    });
    return {
      items: result.items.map((row) => ({
        id: row.id,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        actorType: row.actorType as AuditActorType,
        actor: row.actorUser,
        metadata: safeMetadata(row.metadata),
        requestId: row.requestId,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  }
}
