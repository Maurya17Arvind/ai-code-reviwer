import { type FindingStatus as DomainFindingStatus, type ReviewFinding } from '@acra/shared-types';
import { Inject, Injectable } from '@nestjs/common';
import { type FindingStatus, Prisma, type PrismaClient, type ReviewSessionStatus } from '../../generated/prisma/client';
import { PRISMA_CLIENT } from '../tokens';

/**
 * Every tenant-owned query takes a TenantContext and filters by organization_id (ADR-010).
 * Services never receive a raw Prisma client.
 */
export interface TenantContext {
  readonly organizationId: string;
}

export interface ExecutionRecord {
  readonly provider: string;
  readonly model: string;
  readonly servedByModel: string | null;
  readonly status: 'succeeded' | 'failed' | 'skipped';
  readonly errorKind?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly costUsd: number | null;
  readonly latencyMs: number;
}

export interface PriorFindingRecord {
  readonly id: string;
  readonly fingerprint: string;
  readonly filePath: string;
  readonly status: DomainFindingStatus;
  readonly createdAt: string;
}

const toDbStatus = (status: DomainFindingStatus): FindingStatus => status.toUpperCase() as FindingStatus;
const fromDbStatus = (status: FindingStatus): DomainFindingStatus => status.toLowerCase() as DomainFindingStatus;

@Injectable()
export class ReviewStore {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /**
   * Webhook trust anchor: resolves a repository by id (from the webhook URL) before any tenant is
   * known. Returns only what is needed to verify and route the delivery.
   */
  async findRepositoryForReview(repositoryId: string) {
    return this.prisma.repository.findFirst({
      where: { id: repositoryId, deletedAt: null },
      select: {
        id: true,
        organizationId: true,
        provider: true,
        externalId: true,
        fullName: true,
        isActive: true,
        webhookSecretHash: true,
        connection: {
          select: {
            id: true,
            provider: true,
            baseUrl: true,
            encryptedToken: true,
            tokenKeyId: true,
            installationId: true,
            deletedAt: true,
          },
        },
      },
    });
  }

  /** GitHub webhook routing: the active repository behind (installation, GitHub repository id). */
  async findGitHubRepository(installationId: number, githubRepositoryId: number) {
    return this.prisma.repository.findFirst({
      where: {
        provider: 'GITHUB',
        externalId: String(githubRepositoryId),
        deletedAt: null,
        connection: { provider: 'GITHUB', installationId: String(installationId), deletedAt: null },
      },
      select: { id: true, organizationId: true, isActive: true },
    });
  }

  /** Returns `duplicate` when this provider delivery id was already seen (replay protection). */
  async recordWebhookDelivery(input: {
    provider: 'GITLAB' | 'GITHUB';
    deliveryId: string;
    repositoryId: string | null;
    event: string;
    status: 'ACCEPTED' | 'IGNORED' | 'REJECTED';
    reason?: string;
  }): Promise<'recorded' | 'duplicate'> {
    try {
      await this.prisma.webhookDelivery.create({
        data: {
          provider: input.provider,
          deliveryId: input.deliveryId.slice(0, 200),
          repositoryId: input.repositoryId,
          event: input.event.slice(0, 100),
          status: input.status,
          ...(input.reason ? { reason: input.reason.slice(0, 200) } : {}),
        },
      });
      return 'recorded';
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 'duplicate';
      throw error;
    }
  }

  /** Idempotent: one session per idempotency key (repository + MR + head SHA). */
  async beginSession(
    tenant: TenantContext,
    input: { repositoryId: string; requestId: number; headSha: string; idempotencyKey: string },
  ): Promise<{ id: string; status: ReviewSessionStatus; created: boolean }> {
    try {
      const session = await this.prisma.reviewSession.create({
        data: { organizationId: tenant.organizationId, ...input, status: 'QUEUED' },
        select: { id: true, status: true },
      });
      return { ...session, created: true };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      const existing = await this.prisma.reviewSession.findFirstOrThrow({
        where: { idempotencyKey: input.idempotencyKey, organizationId: tenant.organizationId },
        select: { id: true, status: true },
      });
      return { ...existing, created: false };
    }
  }

  async updateSessionStatus(
    tenant: TenantContext,
    sessionId: string,
    status: ReviewSessionStatus,
    extra: { baseSha?: string; errorCode?: string; errorMessage?: string } = {},
  ): Promise<void> {
    const terminal = ['COMPLETED', 'PARTIAL', 'FAILED', 'SUPERSEDED', 'SKIPPED'].includes(status);
    await this.prisma.reviewSession.updateMany({
      where: { id: sessionId, organizationId: tenant.organizationId },
      data: {
        status,
        ...(status === 'RUNNING' ? { startedAt: new Date() } : {}),
        ...(terminal ? { finishedAt: new Date() } : {}),
        ...(extra.baseSha ? { baseSha: extra.baseSha } : {}),
        ...(extra.errorCode ? { errorCode: extra.errorCode.slice(0, 100) } : {}),
        ...(extra.errorMessage ? { errorMessage: extra.errorMessage.slice(0, 1000) } : {}),
      },
    });
  }

  async priorFindings(tenant: TenantContext, repositoryId: string, requestId: number): Promise<PriorFindingRecord[]> {
    const rows = await this.prisma.reviewFinding.findMany({
      where: { organizationId: tenant.organizationId, repositoryId, requestId },
      select: { id: true, fingerprint: true, filePath: true, status: true, createdAt: true },
    });
    return rows.map((row) => ({ ...row, status: fromDbStatus(row.status), createdAt: row.createdAt.toISOString() }));
  }

  /**
   * Persists a completed review in one transaction: session result, model executions, finding
   * lifecycle (upsert by fingerprint, published/resolved statuses) and the comments posted.
   */
  async completeReview(
    tenant: TenantContext,
    input: {
      sessionId: string;
      repositoryId: string;
      requestId: number;
      headSha: string;
      status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
      contextHash: string;
      promptHash: string;
      report: unknown;
      executions: readonly ExecutionRecord[];
      findings: readonly ReviewFinding[];
      publishedFingerprints: ReadonlySet<string>;
      resolvedFingerprints: ReadonlySet<string>;
      comments: ReadonlyArray<{
        kind: 'INLINE' | 'SUMMARY';
        findingId?: string;
        discussionId?: string;
        noteId: string;
      }>;
    },
  ): Promise<void> {
    const { organizationId } = tenant;
    await this.prisma.$transaction(async (tx) => {
      await tx.reviewSession.updateMany({
        where: { id: input.sessionId, organizationId },
        data: {
          status: input.status,
          finishedAt: new Date(),
          contextHash: input.contextHash,
          promptHash: input.promptHash,
          report: input.report as Prisma.InputJsonValue,
        },
      });

      if (input.executions.length > 0) {
        await tx.modelExecution.createMany({
          data: input.executions.map((e) => ({
            organizationId,
            reviewSessionId: input.sessionId,
            provider: e.provider,
            model: e.model.slice(0, 100),
            servedByModel: e.servedByModel?.slice(0, 100) ?? null,
            status: e.status,
            errorKind: e.errorKind?.slice(0, 50) ?? null,
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            cacheReadTokens: e.cacheReadTokens ?? 0,
            costMicros: e.costUsd === null ? null : BigInt(Math.round(e.costUsd * 1_000_000)),
            latencyMs: e.latencyMs,
          })),
        });
      }

      for (const finding of input.findings) {
        const published = input.publishedFingerprints.has(finding.fingerprint);
        const data = {
          lastSessionId: input.sessionId,
          filePath: finding.filePath.slice(0, 1000),
          lineNumber: finding.lineNumber ?? null,
          endLineNumber: finding.endLineNumber ?? null,
          severity: finding.severity,
          category: finding.category,
          title: finding.title.slice(0, 300),
          description: finding.description,
          evidence: finding.evidence,
          suggestion: finding.suggestion ?? null,
          confidence: finding.confidence,
          sources: [...finding.modelSources],
          placement: finding.placement,
          lastSeenSha: input.headSha,
        };
        await tx.reviewFinding.upsert({
          where: {
            repositoryId_requestId_fingerprint: {
              repositoryId: input.repositoryId,
              requestId: input.requestId,
              fingerprint: finding.fingerprint,
            },
          },
          create: {
            id: finding.id,
            organizationId,
            repositoryId: input.repositoryId,
            requestId: input.requestId,
            fingerprint: finding.fingerprint,
            firstSeenSha: input.headSha,
            status: published ? 'PUBLISHED' : toDbStatus(finding.status),
            ...data,
          },
          update: { ...data, ...(published ? { status: 'PUBLISHED' as const } : {}) },
        });
      }

      if (input.resolvedFingerprints.size > 0) {
        await tx.reviewFinding.updateMany({
          where: {
            organizationId,
            repositoryId: input.repositoryId,
            requestId: input.requestId,
            fingerprint: { in: [...input.resolvedFingerprints] },
            status: { in: ['VALIDATED', 'PUBLISHED'] },
          },
          data: { status: 'RESOLVED' },
        });
      }

      if (input.comments.length > 0) {
        await tx.reviewComment.createMany({
          data: input.comments.map((c) => ({
            organizationId,
            reviewSessionId: input.sessionId,
            kind: c.kind,
            findingId: c.findingId ?? null,
            providerDiscussionId: c.discussionId ?? null,
            providerNoteId: c.noteId,
          })),
        });
      }
    });
  }

  async audit(
    organizationId: string | null,
    entry: {
      action: string;
      targetType: string;
      targetId?: string;
      metadata?: Record<string, unknown>;
      actorType?: 'SYSTEM' | 'WEBHOOK';
    },
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorType: entry.actorType ?? 'SYSTEM',
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }
}
