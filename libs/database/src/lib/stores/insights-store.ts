import { Inject, Injectable } from '@nestjs/common';
import { type FindingStatus, Prisma, type PrismaClient, type ReviewSessionStatus } from '../../generated/prisma/client';
import { PRISMA_CLIENT } from '../tokens';
import { auditData, type RequestAuditContext } from './organization-store';
import { type TenantContext } from './review-store';

/** Keyset cursor over (created_at DESC, id DESC). Opaque to clients. */
export interface Cursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id]), 'utf8').toString('base64url');
}

/** Returns null for anything that is not a cursor this API produced. */
export function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [at, id] = parsed as [unknown, unknown];
    if (typeof at !== 'string' || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const createdAt = new Date(at);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
  } catch {
    return null;
  }
}

function afterCursor(cursor: Cursor | null) {
  return cursor
    ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
    : {};
}

function page<T extends { id: string; createdAt: Date }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

export const microsToUsd = (micros: bigint | null): number | null =>
  micros === null ? null : Number(micros) / 1_000_000;

const FINDING_SUMMARY_SELECT = {
  id: true,
  repositoryId: true,
  requestId: true,
  filePath: true,
  lineNumber: true,
  endLineNumber: true,
  severity: true,
  category: true,
  title: true,
  confidence: true,
  sources: true,
  placement: true,
  status: true,
  firstSeenSha: true,
  lastSeenSha: true,
  createdAt: true,
  updatedAt: true,
  repository: { select: { fullName: true } },
} as const;

const SESSION_SUMMARY_SELECT = {
  id: true,
  repositoryId: true,
  requestId: true,
  baseSha: true,
  headSha: true,
  status: true,
  errorCode: true,
  errorMessage: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  repository: { select: { fullName: true, provider: true, webUrl: true } },
  executions: { select: { costMicros: true } },
} as const;

function sinceDays(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

function countBy<T>(rows: readonly T[], key: (row: T) => string, weight: (row: T) => number = () => 1) {
  const out: Record<string, number> = {};
  for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + weight(row);
  return out;
}

const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Read models for the dashboard (reviews, findings, fixes, approvals, analytics, usage, audit).
 * Every query is tenant-scoped (ADR-010) and paginated or bounded.
 */
@Injectable()
export class InsightsStore {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  // ---------------- reviews ----------------

  async listReviews(
    tenant: TenantContext,
    query: { limit: number; cursor?: string; repositoryId?: string; status?: ReviewSessionStatus },
  ) {
    const rows = await this.prisma.reviewSession.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...afterCursor(decodeCursor(query.cursor)),
      },
      select: SESSION_SUMMARY_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const result = page(rows, query.limit);
    const counts = await this.findingCounts(
      tenant,
      result.items.map((r) => r.id),
    );
    return {
      items: result.items.map((r) => ({ ...r, findingCount: counts.get(r.id) ?? 0 })),
      nextCursor: result.nextCursor,
    };
  }

  async getReview(tenant: TenantContext, id: string) {
    const row = await this.prisma.reviewSession.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: {
        ...SESSION_SUMMARY_SELECT,
        executions: {
          select: {
            id: true,
            provider: true,
            model: true,
            servedByModel: true,
            status: true,
            errorKind: true,
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            costMicros: true,
            latencyMs: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!row) return null;
    const [findings, comments] = await Promise.all([
      this.prisma.reviewFinding.findMany({
        where: { organizationId: tenant.organizationId, lastSessionId: id },
        select: FINDING_SUMMARY_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 200,
      }),
      this.prisma.reviewComment.groupBy({
        by: ['kind'],
        where: { organizationId: tenant.organizationId, reviewSessionId: id },
        _count: { _all: true },
      }),
    ]);
    return {
      ...row,
      findings,
      comments: {
        inline: comments.find((c) => c.kind === 'INLINE')?._count._all ?? 0,
        summary: comments.find((c) => c.kind === 'SUMMARY')?._count._all ?? 0,
      },
    };
  }

  private async findingCounts(tenant: TenantContext, sessionIds: string[]): Promise<Map<string, number>> {
    if (sessionIds.length === 0) return new Map();
    const rows = await this.prisma.reviewFinding.groupBy({
      by: ['lastSessionId'],
      where: { organizationId: tenant.organizationId, lastSessionId: { in: sessionIds } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.lastSessionId, r._count._all]));
  }

  // ---------------- findings ----------------

  async listFindings(
    tenant: TenantContext,
    query: {
      limit: number;
      cursor?: string;
      repositoryId?: string;
      severity?: string;
      status?: FindingStatus;
      category?: string;
    },
  ) {
    const rows = await this.prisma.reviewFinding.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
        ...(query.severity ? { severity: query.severity } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...afterCursor(decodeCursor(query.cursor)),
      },
      select: FINDING_SUMMARY_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return page(rows, query.limit);
  }

  async getFinding(tenant: TenantContext, id: string) {
    return this.prisma.reviewFinding.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: {
        ...FINDING_SUMMARY_SELECT,
        description: true,
        evidence: true,
        suggestion: true,
        lastSessionId: true,
        fixes: { select: { id: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
  }

  /**
   * Human triage (Module F): compare-and-set on the previous status so a concurrent review or
   * another member cannot be silently overwritten. Returns false when the status changed meanwhile.
   */
  async setFindingStatus(
    tenant: TenantContext,
    id: string,
    from: FindingStatus,
    to: FindingStatus,
    audit: RequestAuditContext,
    reason: string | undefined,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.reviewFinding.updateMany({
        where: { id, organizationId: tenant.organizationId, status: from },
        data: { status: to },
      });
      if (result.count !== 1) return false;
      await tx.auditLog.create({
        data: auditData(tenant.organizationId, audit, 'finding.status_changed', 'review_finding', id, {
          from: from.toLowerCase(),
          to: to.toLowerCase(),
          ...(reason ? { reason: reason.slice(0, 500) } : {}),
        }),
      });
      return true;
    });
  }

  // ---------------- fixes & approvals (read models with repository names) ----------------

  async repositoryNames(tenant: TenantContext, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.repository.findMany({
      where: { organizationId: tenant.organizationId, id: { in: [...new Set(ids)] } },
      select: { id: true, fullName: true },
    });
    return new Map(rows.map((r) => [r.id, r.fullName]));
  }

  // ---------------- analytics ----------------

  async analytics(tenant: TenantContext, query: { days: number; repositoryId?: string }, now = new Date()) {
    const from = sinceDays(query.days, now);
    const scope = {
      organizationId: tenant.organizationId,
      ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
    };
    const [sessions, findings, triaged, fixes, approvals] = await Promise.all([
      this.prisma.reviewSession.findMany({
        where: { ...scope, createdAt: { gte: from } },
        select: { status: true, createdAt: true },
      }),
      this.prisma.reviewFinding.findMany({
        where: { ...scope, createdAt: { gte: from } },
        select: { severity: true, category: true, status: true, createdAt: true },
      }),
      this.prisma.reviewFinding.groupBy({
        by: ['status'],
        where: { ...scope, updatedAt: { gte: from }, status: { in: ['DISMISSED', 'FALSE_POSITIVE', 'RESOLVED'] } },
        _count: { _all: true },
      }),
      this.prisma.proposedFix.groupBy({
        by: ['status'],
        where: { ...scope, createdAt: { gte: from } },
        _count: { _all: true },
      }),
      this.prisma.approvalRequest.groupBy({
        by: ['status'],
        where: { ...scope, createdAt: { gte: from } },
        _count: { _all: true },
      }),
    ]);

    const triagedCount = (s: string) => triaged.find((t) => t.status === s)?._count._all ?? 0;
    const falsePositives = triagedCount('FALSE_POSITIVE');
    const triagedTotal = falsePositives + triagedCount('DISMISSED') + triagedCount('RESOLVED');
    const daily = new Map<string, { reviews: number; findings: number }>();
    for (let t = from.getTime(); t <= now.getTime(); t += 86_400_000)
      daily.set(day(new Date(t)), { reviews: 0, findings: 0 });
    daily.set(day(now), daily.get(day(now)) ?? { reviews: 0, findings: 0 });
    for (const s of sessions) {
      const d = daily.get(day(s.createdAt));
      if (d) d.reviews++;
    }
    for (const f of findings) {
      const d = daily.get(day(f.createdAt));
      if (d) d.findings++;
    }
    const lower = (r: Record<string, number>) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v]));
    const grouped = (rows: ReadonlyArray<{ status: string; _count: { _all: number } }>) =>
      Object.fromEntries(rows.map((r) => [r.status.toLowerCase(), r._count._all]));

    return {
      from,
      to: now,
      reviews: { total: sessions.length, byStatus: lower(countBy(sessions, (s) => s.status)) },
      findings: {
        total: findings.length,
        bySeverity: countBy(findings, (f) => f.severity),
        byCategory: countBy(findings, (f) => f.category),
        byStatus: lower(countBy(findings, (f) => f.status)),
        published: findings.filter((f) => f.status === 'PUBLISHED').length,
      },
      falsePositiveRate: triagedTotal === 0 ? null : falsePositives / triagedTotal,
      fixes: { total: fixes.reduce((n, r) => n + r._count._all, 0), byStatus: grouped(fixes) },
      approvals: { total: approvals.reduce((n, r) => n + r._count._all, 0), byStatus: grouped(approvals) },
      daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    };
  }

  // ---------------- usage & AI providers ----------------

  async usage(tenant: TenantContext, query: { days: number; repositoryId?: string }, now = new Date()) {
    const from = sinceDays(query.days, now);
    const where: Prisma.ModelExecutionWhereInput = {
      organizationId: tenant.organizationId,
      createdAt: { gte: from },
      ...(query.repositoryId ? { session: { repositoryId: query.repositoryId } } : {}),
    };
    const [byModel, executions, fixCost] = await Promise.all([
      this.prisma.modelExecution.groupBy({
        by: ['provider', 'model', 'status'],
        where,
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, costMicros: true },
      }),
      this.prisma.modelExecution.findMany({ where, select: { createdAt: true, costMicros: true } }),
      this.prisma.proposedFix.aggregate({
        where: {
          organizationId: tenant.organizationId,
          createdAt: { gte: from },
          ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
        },
        _sum: { costMicros: true },
      }),
    ]);
    const unpriced = await this.prisma.modelExecution.groupBy({
      by: ['provider', 'model'],
      where: { ...where, costMicros: null },
      _count: { _all: true },
    });

    const models = new Map<
      string,
      {
        provider: string;
        model: string;
        executions: number;
        failures: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        costUsd: number;
        unpricedExecutions: number;
      }
    >();
    for (const row of byModel) {
      const key = `${row.provider}\u0000${row.model}`;
      const entry = models.get(key) ?? {
        provider: row.provider,
        model: row.model,
        executions: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        unpricedExecutions: 0,
      };
      entry.executions += row._count._all;
      if (row.status === 'failed') entry.failures += row._count._all;
      entry.inputTokens += row._sum.inputTokens ?? 0;
      entry.outputTokens += row._sum.outputTokens ?? 0;
      entry.cacheReadTokens += row._sum.cacheReadTokens ?? 0;
      entry.costUsd += microsToUsd(row._sum.costMicros) ?? 0;
      models.set(key, entry);
    }
    for (const row of unpriced) {
      const entry = models.get(`${row.provider}\u0000${row.model}`);
      if (entry) entry.unpricedExecutions = row._count._all;
    }
    const list = [...models.values()].sort((a, b) => b.costUsd - a.costUsd || b.executions - a.executions);

    const daily = new Map<string, { executions: number; costUsd: number }>();
    for (let t = from.getTime(); t <= now.getTime(); t += 86_400_000)
      daily.set(day(new Date(t)), { executions: 0, costUsd: 0 });
    daily.set(day(now), daily.get(day(now)) ?? { executions: 0, costUsd: 0 });
    for (const e of executions) {
      const d = daily.get(day(e.createdAt));
      if (!d) continue;
      d.executions++;
      d.costUsd += microsToUsd(e.costMicros) ?? 0;
    }

    const sum = (pick: (m: (typeof list)[number]) => number) => list.reduce((n, m) => n + pick(m), 0);
    return {
      from,
      to: now,
      totals: {
        executions: sum((m) => m.executions),
        failures: sum((m) => m.failures),
        inputTokens: sum((m) => m.inputTokens),
        outputTokens: sum((m) => m.outputTokens),
        cacheReadTokens: sum((m) => m.cacheReadTokens),
        costUsd: sum((m) => m.costUsd),
        unpricedExecutions: sum((m) => m.unpricedExecutions),
        fixProposalCostUsd: microsToUsd(fixCost._sum.costMicros) ?? 0,
      },
      byModel: list,
      daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    };
  }

  /** Last execution and 30-day counts per AI provider, as observed from recorded executions. */
  async providerActivity(tenant: TenantContext, providers: readonly string[], now = new Date()) {
    const from = sinceDays(30, now);
    return Promise.all(
      providers.map(async (provider) => {
        const [last, counts] = await Promise.all([
          this.prisma.modelExecution.findFirst({
            where: { organizationId: tenant.organizationId, provider },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true, status: true, errorKind: true, model: true },
          }),
          this.prisma.modelExecution.groupBy({
            by: ['status'],
            where: { organizationId: tenant.organizationId, provider, createdAt: { gte: from } },
            _count: { _all: true },
          }),
        ]);
        return {
          provider,
          lastExecutionAt: last?.createdAt ?? null,
          lastStatus: last?.status ?? null,
          lastErrorKind: last?.errorKind ?? null,
          lastModel: last?.model ?? null,
          executions30d: counts.reduce((n, c) => n + c._count._all, 0),
          failures30d: counts.find((c) => c.status === 'failed')?._count._all ?? 0,
        };
      }),
    );
  }

  // ---------------- audit ----------------

  async listAuditLogs(tenant: TenantContext, query: { limit: number; cursor?: string; action?: string }) {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(query.action ? { action: { startsWith: query.action } } : {}),
        ...afterCursor(decodeCursor(query.cursor)),
      },
      select: {
        id: true,
        action: true,
        targetType: true,
        targetId: true,
        actorType: true,
        metadata: true,
        requestId: true,
        ipAddress: true,
        createdAt: true,
        actorUser: { select: { id: true, email: true, displayName: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return page(rows, query.limit);
  }
}
