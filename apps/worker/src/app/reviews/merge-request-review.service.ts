import { type AiProviderName } from '@acra/ai-providers-core';
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
import { ReviewStore, type TenantContext } from '@acra/database';
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

    return {
      status: report.status,
      sessionId,
      findings: report.findings.length,
      inlineComments: published.comments.filter((c) => c.kind === 'inline').length,
    };
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
