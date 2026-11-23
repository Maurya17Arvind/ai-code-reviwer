import {
  type ApprovalOperation,
  ApprovalError,
  type ApprovalRequest,
  beginExecution,
  completeExecution,
  expire,
  invalidate,
} from '@acra/approvals';
import { ApprovalStore, ReviewStore, type StoredFix, type TenantContext } from '@acra/database';
import { applyProposal, FixRejection, type LineChange } from '@acra/fix-engine';
import { type HostedGitProvider, type RepositoryWriter } from '@acra/git-providers-core';
import { fixReviewRequestText } from '@acra/publishing';
import { ExecuteApprovalJobSchema } from '@acra/queue';
import { sha256Hex } from '@acra/repository-context';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { HostedProviderFactory, ProviderConfigurationError } from '../reviews/hosted-provider.factory';

export type ExecutionOutcome =
  | { readonly status: 'executed'; readonly result: Record<string, unknown> }
  | { readonly status: 'failed' | 'invalidated' | 'expired' | 'skipped'; readonly reason: string };

/** Operations that exist on hosted repositories (no working tree there). */
const HOSTED_OPERATIONS = new Set(['commit_and_push_fix', 'create_merge_request', 'create_pull_request']);

/**
 * Executes one human-approved operation on GitLab/GitHub. Everything is re-verified here, right
 * before writing, from storage and the provider — never from the job payload:
 *   approval status + binding hash + expiry + the MR/PR's *current* head commit + the patch hash,
 *   and for writes the original file hash and the recomputed result hash.
 * The approval moves APPROVED → EXECUTING with compare-and-set, so it runs at most once.
 */
@Injectable()
export class ApprovalExecutionService {
  private readonly logger = new Logger(ApprovalExecutionService.name);

  constructor(
    @Inject(ApprovalStore) private readonly approvals: ApprovalStore,
    @Inject(ReviewStore) private readonly reviews: ReviewStore,
    @Inject(HostedProviderFactory) private readonly providers: HostedProviderFactory,
  ) {}

  async run(rawJob: unknown): Promise<ExecutionOutcome> {
    const job = ExecuteApprovalJobSchema.safeParse(rawJob);
    if (!job.success) return { status: 'skipped', reason: 'invalid job payload' };
    const tenant: TenantContext = { organizationId: job.data.organizationId };
    const stored = await this.approvals.getApproval(tenant, job.data.approvalId);
    if (!stored) return { status: 'skipped', reason: 'approval not found' };
    const request = stored.request;
    if (request.status !== 'approved') return { status: 'skipped', reason: `approval is ${request.status}` };
    if (!HOSTED_OPERATIONS.has(request.operation.kind)) {
      return this.void(tenant, request, 'invalidated', 'operation is not available on hosted repositories');
    }

    const fix = stored.proposedFixId ? await this.approvals.getFix(tenant, stored.proposedFixId) : null;
    if (!fix || fix.id !== request.operation.fixId || fix.baseSha !== request.headSha) {
      return this.void(tenant, request, 'invalidated', 'the fix does not match the approval');
    }
    const repository = await this.reviews.findRepositoryForReview(request.repositoryId);
    if (
      !repository ||
      repository.organizationId !== tenant.organizationId ||
      !repository.isActive ||
      !repository.connection ||
      repository.connection.deletedAt
    ) {
      return this.void(tenant, request, 'invalidated', 'repository is not active');
    }

    let host: HostedGitProvider & RepositoryWriter;
    try {
      host = await this.providers.writerForRepository({ ...repository, connection: repository.connection });
    } catch (error) {
      if (error instanceof ProviderConfigurationError) return this.void(tenant, request, 'invalidated', error.message);
      throw error;
    }
    const mr = await host.getReviewRequest(stored.requestId);
    if (mr.state !== 'opened') return this.void(tenant, request, 'invalidated', `merge/pull request is ${mr.state}`);

    let executing: ApprovalRequest;
    try {
      executing = beginExecution(request, {
        now: new Date(),
        currentHeadSha: mr.refs.headSha,
        patchSha256: sha256Hex(fix.patch),
      });
    } catch (error) {
      if (error instanceof ApprovalError) {
        return this.void(tenant, request, error.code === 'expired' ? 'expired' : 'invalidated', error.message);
      }
      throw error;
    }
    if (!(await this.approvals.transition(tenant, executing, 'approved'))) {
      return { status: 'skipped', reason: 'approval was changed concurrently' };
    }

    try {
      const result = await this.execute(tenant, executing.operation, fix, host, repository.provider);
      await this.approvals.transition(
        tenant,
        completeExecution(executing, { ok: true, result }, new Date()),
        'executing',
      );
      await this.reviews.audit(tenant.organizationId, {
        action: 'approval.executed',
        targetType: 'approval_request',
        targetId: request.id,
        metadata: { operation: executing.operation.kind, fixId: fix.id, ...result },
      });
      this.logger.log({ approvalId: request.id, operation: executing.operation.kind }, 'Approved operation executed');
      return { status: 'executed', result };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : 'execution failed';
      await this.approvals.transition(
        tenant,
        completeExecution(executing, { ok: false, result: { error: message } }, new Date()),
        'executing',
      );
      await this.reviews.audit(tenant.organizationId, {
        action: 'approval.failed',
        targetType: 'approval_request',
        targetId: request.id,
        metadata: { operation: executing.operation.kind, error: message },
      });
      this.logger.warn({ approvalId: request.id, err: error }, 'Approved operation failed');
      return { status: 'failed', reason: message };
    }
  }

  private async execute(
    tenant: TenantContext,
    operation: ApprovalOperation,
    fix: NonNullable<StoredFix>,
    host: HostedGitProvider & RepositoryWriter,
    provider: string,
  ): Promise<Record<string, unknown>> {
    switch (operation.kind) {
      case 'commit_and_push_fix': {
        if (fix.status !== 'PROPOSED') throw new Error(`Fix is ${fix.status.toLowerCase()}`);
        if (operation.branch !== fix.branch || operation.filePath !== fix.filePath)
          throw new Error('Approved operation does not match the fix');
        const file = await host.readFile(fix.filePath, { kind: 'commit', sha: fix.baseSha });
        if (!file || file.isBinary || file.tooLarge)
          throw new Error('The file can no longer be read at the reviewed commit');
        let content: string;
        try {
          content = applyProposal(
            {
              changes: fix.changes as unknown as LineChange[],
              originalSha256: fix.originalSha256,
              resultSha256: fix.resultSha256,
              patch: fix.patch,
              patchSha256: fix.patchSha256,
            },
            file.content,
          );
        } catch (error) {
          throw new Error(error instanceof FixRejection ? error.message : 'Fix could not be applied', { cause: error });
        }
        const { commitSha } = await host.commitFileToNewBranch({
          branch: fix.branch,
          baseSha: fix.baseSha,
          path: fix.filePath,
          content,
          message: operation.message,
        });
        await this.approvals.updateFix(tenant, fix.id, 'PROPOSED', { status: 'APPLIED', commitSha });
        return { branch: fix.branch, commitSha };
      }
      case 'create_merge_request':
      case 'create_pull_request': {
        const expected = provider === 'GITLAB' ? 'create_merge_request' : 'create_pull_request';
        if (operation.kind !== expected) throw new Error('Operation does not match the repository provider');
        if (fix.status !== 'APPLIED' || fix.commitSha !== operation.commitSha)
          throw new Error('The fix branch is not at the approved commit');
        if ((await host.branchHead(operation.sourceBranch)) !== operation.commitSha) {
          throw new Error(`Branch ${operation.sourceBranch} moved since approval`);
        }
        const text = fixReviewRequestText({
          finding: { title: fix.finding.title, severity: fix.finding.severity, category: fix.finding.category },
          proposal: {
            id: fix.id,
            fingerprint: fix.fingerprint,
            filePath: fix.filePath,
            explanation: fix.explanation,
            patch: fix.patch,
          },
        });
        const created = await host.createReviewRequest({
          sourceBranch: operation.sourceBranch,
          targetBranch: operation.targetBranch,
          title: operation.title,
          description: text.description,
        });
        await this.approvals.updateFix(tenant, fix.id, 'APPLIED', {
          status: 'OPENED',
          reviewRequestUrl: created.webUrl,
        });
        return { url: created.webUrl, id: created.id };
      }
      default:
        throw new Error('Operation is not available on hosted repositories');
    }
  }

  private async void(
    tenant: TenantContext,
    request: ApprovalRequest,
    status: 'invalidated' | 'expired',
    reason: string,
  ): Promise<ExecutionOutcome> {
    // beginExecution already established expiry; the state machine's expire() re-checks the clock.
    const next = status === 'expired' ? expire(request, new Date()) : invalidate(request, reason);
    await this.approvals.transition(tenant, next, 'approved');
    await this.reviews.audit(tenant.organizationId, {
      action: `approval.${status}`,
      targetType: 'approval_request',
      targetId: request.id,
      metadata: { reason },
    });
    return { status, reason };
  }
}
