import { type AiProviderName, type AiReviewer } from '@acra/ai-providers-core';
import { type ReviewerFactory } from '@acra/ai-providers-factory';
import { runReview } from '@acra/agent-core';
import {
  DEFAULT_EXCLUDE_GLOBS,
  parseReviewConfig,
  REVIEW_CONFIG_FILENAME,
  type ReviewConfig,
  ReviewConfigError,
  defaultReviewConfig,
} from '@acra/configuration';
import { ApprovalStore, ReviewStore, type TenantContext } from '@acra/database';
import { fixBranchName } from '@acra/approvals';
import { generateFix } from '@acra/fix-engine';
import { SEVERITY_RANK } from '@acra/review-engine';
import { type ReviewFinding } from '@acra/shared-types';
import {
  GitProviderError,
  type HostedGitProvider,
  InlinePositionRejectedError,
  ProviderApiError,
  type ReviewRequest,
} from '@acra/git-providers-core';
import { executePublication, planPublication } from '@acra/publishing';
import { type ReviewMergeRequestJob, ReviewMergeRequestJobSchema } from '@acra/queue';
import { buildReviewContext } from '@acra/repository-context';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { REVIEWER_FACTORY, WORKER_CONFIG, type WorkerConfig } from '../worker-config';
import { HostedProviderFactory, ProviderConfigurationError } from './hosted-provider.factory';

export type ReviewOutcome =
  | {
      readonly status: 'completed' | 'partial' | 'failed';
      readonly sessionId: string;
      readonly findings: number;
      readonly inlineComments: number;
      readonly fixesProposed: number;
    }
  | { readonly status: 'skipped' | 'superseded' | 'duplicate'; readonly sessionId?: string; readonly reason: string };

/** Error that must not be retried (bad configuration, missing data). */
export class PermanentReviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentReviewError';
  }
}

const TERMINAL = new Set(['COMPLETED', 'PARTIAL', 'SUPERSEDED', 'SKIPPED']);

/**
 * Reviews one merge request / pull request at one head commit (the worker side of Modules B, D, E, F),
 * for any hosted provider (GitLab, GitHub). Idempotent: re-running the same job never posts duplicate
 * comments.
 */
@Injectable()
export class MergeRequestReviewService {
  private readonly logger = new Logger(MergeRequestReviewService.name);

  constructor(
    @Inject(ReviewStore) private readonly store: ReviewStore,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(REVIEWER_FACTORY) private readonly createReviewers: ReviewerFactory,
    @Inject(HostedProviderFactory) private readonly providers: HostedProviderFactory,
    @Inject(ApprovalStore) private readonly approvals: ApprovalStore,
  ) {}

  async run(rawJob: unknown): Promise<ReviewOutcome> {
    const parsed = ReviewMergeRequestJobSchema.safeParse(rawJob);
    if (!parsed.success) throw new PermanentReviewError('invalid_job', 'Invalid review job payload');
    const job = parsed.data;

    const repository = await this.store.findRepositoryForReview(job.repositoryId);
    if (!repository || repository.organizationId !== job.organizationId) {
      throw new PermanentReviewError('repository_not_found', 'Repository not found for this organization');
    }
    const expectedProvider = job.provider === 'github' ? 'GITHUB' : 'GITLAB';
    if (repository.provider !== expectedProvider) {
      throw new PermanentReviewError('provider_mismatch', 'Job provider does not match the repository');
    }
    const connection = repository.connection;
    if (!repository.isActive || !connection || connection.deletedAt) {
      return { status: 'skipped', reason: 'repository inactive or not connected' };
    }
    const tenant: TenantContext = { organizationId: repository.organizationId };

    const session = await this.store.beginSession(tenant, {
      repositoryId: repository.id,
      requestId: job.requestId,
      headSha: job.headSha,
      idempotencyKey: `${job.provider}:${repository.id}:${job.requestId}:${job.headSha}`,
    });
    if (!session.created && TERMINAL.has(session.status)) {
      return { status: 'duplicate', sessionId: session.id, reason: `already ${session.status.toLowerCase()}` };
    }
    await this.store.updateSessionStatus(tenant, session.id, 'RUNNING');

    try {
      const provider = await this.providers.forRepository({ ...repository, connection }).catch((error: unknown) => {
        if (error instanceof ProviderConfigurationError) throw new PermanentReviewError(error.code, error.message);
        throw error;
      });
      return await this.review(job, tenant, session.id, repository.id, provider);
    } catch (error) {
      const code =
        error instanceof PermanentReviewError
          ? error.code
          : error instanceof ProviderApiError
            ? `${job.provider}_${error.status}`
            : 'review_failed';
      await this.store.updateSessionStatus(tenant, session.id, 'FAILED', {
        errorCode: code,
        errorMessage: error instanceof Error ? error.message : 'unknown error',
      });
      throw error;
    }
  }

  private async review(
    job: ReviewMergeRequestJob,
    tenant: TenantContext,
    sessionId: string,
    repositoryId: string,
    host: HostedGitProvider,
  ): Promise<ReviewOutcome> {
    const mr = await host.getReviewRequest(job.requestId);
    if (mr.state !== 'opened') return this.finish(tenant, sessionId, 'SKIPPED', `merge request is ${mr.state}`);
    if (mr.refs.headSha !== job.headSha)
      return this.finish(tenant, sessionId, 'SUPERSEDED', 'a newer commit was pushed');
    await this.store.updateSessionStatus(tenant, sessionId, 'RUNNING', { baseSha: mr.refs.baseSha });
    // This commit is now the reviewed one: approvals and fixes bound to an older commit are void.
    const voided = await this.approvals.invalidateForHead(tenant, repositoryId, mr.id, mr.refs.headSha);
    if (voided.approvals + voided.fixes > 0)
      this.logger.log({ repositoryId, requestId: mr.id, ...voided }, 'Invalidated approvals/fixes for an older commit');

    const config = await this.loadConfig(host, mr);
    if (!config.review.enabled) return this.finish(tenant, sessionId, 'SKIPPED', 'review.enabled is false');

    const changeSet = await host.getReviewRequestChanges(mr);
    const context = await buildReviewContext(changeSet, host, {
      exclude: [...DEFAULT_EXCLUDE_GLOBS, ...config.review.exclude],
      budget: config.review.context,
    });
    if (context.files.length === 0) return this.finish(tenant, sessionId, 'SKIPPED', 'no reviewable files');

    const allowed: Record<AiProviderName, boolean> = {
      claude: config.review.providers.claude,
      gpt: config.review.providers.openai,
      ollama: config.review.providers.ollama,
    };
    const setup = this.createReviewers(
      this.config,
      new Set((Object.keys(allowed) as AiProviderName[]).filter((p) => allowed[p])),
    );
    for (const skipped of setup.skipped)
      this.logger.warn({ provider: skipped.provider, reason: skipped.reason }, 'AI provider skipped');

    const report = await runReview({
      context,
      reviewers: setup.reviewers,
      skippedProviders: setup.skipped,
      settings: {
        categories: config.review.categories,
        minimumSeverity: config.review.minimumSeverity,
        minimumConfidence: config.review.minimumConfidence,
        ...(config.project.framework ? { framework: config.project.framework } : {}),
        ...(config.project.language ? { language: config.project.language } : {}),
        providerTimeoutMs: this.config.AI_REVIEW_TIMEOUT_MS,
      },
      repository: { rootPath: '', branch: mr.sourceBranch, headSha: mr.refs.headSha, repositoryId },
      priorFindings: await this.store.priorFindings(tenant, repositoryId, mr.id),
      reviewId: sessionId,
    });

    // A newer commit may have arrived while the models were thinking: never publish stale results.
    const latest = await host.getReviewRequest(mr.id);
    if (latest.refs.headSha !== mr.refs.headSha)
      return this.finish(tenant, sessionId, 'SUPERSEDED', 'a newer commit arrived during the review');

    const existing = await host.listComments(mr.id);
    const plan = planPublication(report, context, existing, config.review.publishing);
    const published = await executePublication(host, mr.id, mr.refs, report, plan, {
      summary: config.review.publishing.summary,
      isPositionRejection: (error) => error instanceof InlinePositionRejectedError,
    });

    const publishedFingerprints = new Set([
      ...published.comments.flatMap((c) => (c.fingerprint ? [c.fingerprint] : [])),
      ...plan.alreadyPublished.keys(),
    ]);
    const status = report.status === 'completed' ? 'COMPLETED' : report.status === 'partial' ? 'PARTIAL' : 'FAILED';
    await this.store.completeReview(tenant, {
      sessionId,
      repositoryId,
      requestId: mr.id,
      headSha: mr.refs.headSha,
      status,
      contextHash: report.contextHash,
      promptHash: report.promptHash,
      report,
      executions: report.executions.map((e) => ({
        provider: e.provider,
        model: e.model,
        servedByModel: e.servedByModel,
        status: e.status,
        ...(e.errorKind ? { errorKind: e.errorKind } : {}),
        inputTokens: e.usage.inputTokens,
        outputTokens: e.usage.outputTokens,
        cacheReadTokens: e.usage.cacheReadInputTokens ?? 0,
        costUsd: e.costUsd,
        latencyMs: e.latencyMs,
      })),
      findings: report.findings,
      publishedFingerprints,
      resolvedFingerprints: new Set(report.resolved.map((r) => r.fingerprint)),
      comments: published.comments.map((c) => ({
        kind: c.kind === 'inline' ? ('INLINE' as const) : ('SUMMARY' as const),
        noteId: c.noteId,
        ...(c.findingId ? { findingId: c.findingId } : {}),
        ...(c.discussionId ? { discussionId: c.discussionId } : {}),
      })),
    });
    await this.store.audit(tenant.organizationId, {
      action: 'review.published',
      targetType: 'merge_request',
      targetId: `${repositoryId}!${mr.id}`,
      metadata: {
        sessionId,
        headSha: mr.refs.headSha,
        status: report.status,
        findings: report.findings.length,
        inlineComments: published.comments.filter((c) => c.kind === 'inline').length,
        resolved: published.resolvedDiscussions.length,
      },
    });

    // Fix proposals are automatic (Module H) but optional and never fail the review.
    let fixesProposed = 0;
    if (config.fixes.enabled && report.findings.length > 0) {
      fixesProposed = await this.proposeFixes(tenant, {
        sessionId,
        repositoryId,
        mr,
        host,
        config,
        reviewers: setup.reviewers,
        findings: report.findings,
      }).catch((error: unknown) => {
        this.logger.warn({ err: error, sessionId }, 'Fix generation failed');
        return 0;
      });
    }

    return {
      status: report.status,
      sessionId,
      findings: report.findings.length,
      inlineComments: published.comments.filter((c) => c.kind === 'inline').length,
      fixesProposed,
    };
  }

  /**
   * Generates fix proposals for the most severe findings. Nothing is written to the repository:
   * proposals are stored for a human to approve (admin CLI now, dashboard in Phase 7).
   */
  private async proposeFixes(
    tenant: TenantContext,
    input: {
      sessionId: string;
      repositoryId: string;
      mr: ReviewRequest;
      host: HostedGitProvider;
      config: ReviewConfig;
      reviewers: readonly AiReviewer[];
      findings: readonly ReviewFinding[];
    },
  ): Promise<number> {
    const order: AiProviderName[] = ['claude', 'gpt', 'ollama'];
    const reviewer = order.map((p) => input.reviewers.find((r) => r.provider === p)).find((r) => r !== undefined);
    if (!reviewer) return 0;
    const threshold = SEVERITY_RANK[input.config.fixes.minimumSeverity];
    const candidates = [...input.findings]
      .filter((f) => SEVERITY_RANK[f.severity] >= threshold)
      .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.confidence - a.confidence)
      .slice(0, input.config.fixes.maxPerReview);

    let proposed = 0;
    for (const finding of candidates) {
      const file = await input.host.readFile(finding.filePath, { kind: 'commit', sha: input.mr.refs.headSha });
      if (!file || file.isBinary || file.tooLarge) continue;
      const result = await generateFix({
        reviewer,
        target: {
          id: finding.id,
          fingerprint: finding.fingerprint,
          filePath: finding.filePath,
          ...(finding.lineNumber !== undefined ? { lineNumber: finding.lineNumber } : {}),
          ...(finding.endLineNumber !== undefined ? { endLineNumber: finding.endLineNumber } : {}),
          severity: finding.severity,
          category: finding.category,
          title: finding.title,
          description: finding.description,
          evidence: finding.evidence,
          ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
        },
        content: file.content,
        baseSha: input.mr.refs.headSha,
        signal: AbortSignal.timeout(this.config.AI_REVIEW_TIMEOUT_MS),
      });
      if (result.status === 'rejected') {
        this.logger.log({ findingId: finding.id, code: result.code }, 'No fix proposed');
        continue;
      }
      const findingId = await this.approvals.findingId(tenant, input.repositoryId, input.mr.id, finding.fingerprint);
      if (!findingId) continue;
      const p = result.proposal;
      await this.approvals.saveProposedFix(tenant, {
        id: p.id,
        repositoryId: input.repositoryId,
        reviewSessionId: input.sessionId,
        findingId,
        requestId: input.mr.id,
        fingerprint: p.fingerprint,
        filePath: p.filePath,
        baseSha: p.baseSha,
        targetBranch: input.mr.sourceBranch,
        explanation: p.explanation,
        changes: p.changes,
        patch: p.patch,
        patchSha256: p.patchSha256,
        originalSha256: p.originalSha256,
        resultSha256: p.resultSha256,
        additions: p.additions,
        deletions: p.deletions,
        provider: p.provider,
        model: p.model,
        costUsd: p.costUsd,
        branch: fixBranchName(p.id),
      });
      await this.store.audit(tenant.organizationId, {
        action: 'fix.proposed',
        targetType: 'proposed_fix',
        targetId: p.id,
        metadata: { sessionId: input.sessionId, findingId, filePath: p.filePath, provider: p.provider },
      });
      proposed++;
    }
    return proposed;
  }

  /** Reads ai-review.yaml at the reviewed commit. Untrusted: a broken file fails permanently. */
  private async loadConfig(host: HostedGitProvider, mr: ReviewRequest): Promise<ReviewConfig> {
    const file = await host.readFile(REVIEW_CONFIG_FILENAME, { kind: 'commit', sha: mr.refs.headSha });
    if (!file) return defaultReviewConfig();
    if (file.isBinary || file.tooLarge)
      throw new PermanentReviewError('config_invalid', `${REVIEW_CONFIG_FILENAME} is not a readable text file`);
    try {
      return parseReviewConfig(file.content);
    } catch (error) {
      throw new PermanentReviewError(
        'config_invalid',
        error instanceof ReviewConfigError ? error.message : 'Invalid configuration',
      );
    }
  }

  private async finish(
    tenant: TenantContext,
    sessionId: string,
    status: 'SKIPPED' | 'SUPERSEDED',
    reason: string,
  ): Promise<ReviewOutcome> {
    await this.store.updateSessionStatus(tenant, sessionId, status, { errorMessage: reason });
    return { status: status === 'SKIPPED' ? 'skipped' : 'superseded', sessionId, reason };
  }
}

/** Transient failures BullMQ should retry with backoff; everything else fails permanently. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof PermanentReviewError) return false;
  if (error instanceof ProviderApiError) return error.retryable;
  if (error instanceof GitProviderError) return /not ready/.test(error.message);
  return false;
}
