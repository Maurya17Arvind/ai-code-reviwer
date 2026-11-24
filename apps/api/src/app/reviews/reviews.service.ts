import { InsightsStore, microsToUsd } from '@acra/database';
import { FINDING_TRANSITIONS } from '@acra/review-engine';
import {
  type FindingDetail,
  type FindingListQuery,
  type FindingSummary,
  type Page,
  type ReviewDetail,
  type ReviewListQuery,
  type ReviewSessionStatus,
  type ReviewSummary,
  type UpdateFindingStatusRequest,
} from '@acra/shared-contracts';
import {
  type FindingPlacement,
  type FindingStatus,
  type GitProviderKind,
  type ReviewCategory,
  type Severity,
} from '@acra/shared-types';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type AuthContext, type MembershipContext } from '../auth/auth-context';
import { audit, type RequestMeta, tenant } from '../organizations/organizations.service';

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);
const upper = <T extends string>(value: T) => value.toUpperCase() as Uppercase<T>;

interface FindingRow {
  id: string;
  repositoryId: string;
  requestId: number;
  filePath: string;
  lineNumber: number | null;
  endLineNumber: number | null;
  severity: string;
  category: string;
  title: string;
  confidence: number;
  sources: string[];
  placement: string;
  status: string;
  firstSeenSha: string;
  lastSeenSha: string;
  createdAt: Date;
  updatedAt: Date;
  repository: { fullName: string };
}

function toFindingSummary(row: FindingRow): FindingSummary {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    repositoryName: row.repository.fullName,
    requestId: row.requestId,
    filePath: row.filePath,
    lineNumber: row.lineNumber,
    endLineNumber: row.endLineNumber,
    severity: row.severity as Severity,
    category: row.category as ReviewCategory,
    title: row.title,
    confidence: row.confidence,
    sources: row.sources,
    placement: row.placement as FindingPlacement,
    status: row.status.toLowerCase() as FindingStatus,
    firstSeenSha: row.firstSeenSha,
    lastSeenSha: row.lastSeenSha,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

interface SessionRow {
  id: string;
  repositoryId: string;
  requestId: number | null;
  baseSha: string | null;
  headSha: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  repository: { fullName: string; provider: string; webUrl: string | null };
  executions: Array<{ costMicros: bigint | null }>;
}

/**
 * Coarse reason shown to users. Skip/supersede reasons are written by the worker; failure messages
 * may come from provider errors, so only the error code is exposed for failed sessions.
 */
function statusReason(row: SessionRow): string | null {
  if (row.status === 'SKIPPED' || row.status === 'SUPERSEDED') return row.errorMessage?.slice(0, 200) ?? null;
  if (row.status === 'FAILED') return row.errorCode ? `Review failed (${row.errorCode})` : 'Review failed';
  return null;
}

function toReviewSummary(row: SessionRow, findingCount: number): ReviewSummary {
  const priced = row.executions.filter((e) => e.costMicros !== null);
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    repositoryName: row.repository.fullName,
    provider: row.repository.provider as GitProviderKind,
    requestId: row.requestId,
    baseSha: row.baseSha,
    headSha: row.headSha,
    status: row.status.toLowerCase() as ReviewSessionStatus,
    errorCode: row.errorCode,
    statusReason: statusReason(row),
    findingCount,
    costUsd: priced.length === 0 ? null : priced.reduce((sum, e) => sum + (microsToUsd(e.costMicros) ?? 0), 0),
    createdAt: iso(row.createdAt),
    startedAt: isoOrNull(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
  };
}

/** Review history, review details and finding triage (Modules F and I). */
@Injectable()
export class ReviewsService {
  constructor(@Inject(InsightsStore) private readonly store: InsightsStore) {}

  async listReviews(membership: MembershipContext, query: ReviewListQuery): Promise<Page<ReviewSummary>> {
    const result = await this.store.listReviews(tenant(membership), {
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
      ...(query.status ? { status: upper(query.status) } : {}),
    });
    return { items: result.items.map((r) => toReviewSummary(r, r.findingCount)), nextCursor: result.nextCursor };
  }

  async getReview(membership: MembershipContext, id: string): Promise<ReviewDetail> {
    const row = await this.store.getReview(tenant(membership), id);
    if (!row) throw new NotFoundException('Review not found');
    return {
      ...toReviewSummary(row, row.findings.length),
      repositoryWebUrl: row.repository.webUrl,
      executions: row.executions
        .map((e) => ({
          ...e,
          costUsd: microsToUsd(e.costMicros),
          createdAt: iso(e.createdAt),
        }))
        .map(({ costMicros: _omit, ...rest }) => rest),
      findings: row.findings.map(toFindingSummary),
      comments: row.comments,
    };
  }

  async listFindings(membership: MembershipContext, query: FindingListQuery): Promise<Page<FindingSummary>> {
    const result = await this.store.listFindings(tenant(membership), {
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.status ? { status: upper(query.status) } : {}),
      ...(query.category ? { category: query.category } : {}),
    });
    return { items: result.items.map(toFindingSummary), nextCursor: result.nextCursor };
  }

  async getFinding(membership: MembershipContext, id: string): Promise<FindingDetail> {
    const row = await this.store.getFinding(tenant(membership), id);
    if (!row) throw new NotFoundException('Finding not found');
    const summary = toFindingSummary(row);
    return {
      ...summary,
      description: row.description,
      evidence: row.evidence,
      suggestion: row.suggestion,
      lastSessionId: row.lastSessionId,
      fixes: row.fixes.map((f) => ({ id: f.id, status: f.status.toLowerCase(), createdAt: iso(f.createdAt) })),
      allowedTransitions: triageTransitions(summary.status),
    };
  }

  /** Dismiss or mark a finding as a false positive. Future reviews keep it suppressed. */
  async updateFindingStatus(
    auth: AuthContext,
    membership: MembershipContext,
    id: string,
    input: UpdateFindingStatusRequest,
    meta: RequestMeta,
  ): Promise<FindingDetail> {
    const current = await this.getFinding(membership, id);
    if (current.status === input.status) return current;
    if (!triageTransitions(current.status).includes(input.status)) {
      throw new BadRequestException(
        `A ${current.status.replace('_', ' ')} finding cannot be marked ${input.status.replace('_', ' ')}`,
      );
    }
    const changed = await this.store.setFindingStatus(
      tenant(membership),
      id,
      upper(current.status),
      upper(input.status),
      audit(auth, meta),
      input.reason,
    );
    if (!changed) throw new ConflictException('The finding was updated concurrently. Reload and try again.');
    return this.getFinding(membership, id);
  }
}

/** Statuses a human may set: only the triage outcomes allowed by the lifecycle (Module F). */
function triageTransitions(status: FindingStatus): FindingStatus[] {
  return FINDING_TRANSITIONS[status].filter((s) => s === 'dismissed' || s === 'false_positive');
}
