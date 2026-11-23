import { ReviewStore } from '@acra/database';
import { ReviewQueueProducer } from '@acra/queue';
import { hashToken, tokenMatchesHash } from '@acra/security';
import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as z from 'zod';

const MergeRequestHookSchema = z.object({
  object_kind: z.literal('merge_request'),
  project: z.object({ id: z.number().int().positive() }),
  object_attributes: z.object({
    iid: z.number().int().positive(),
    action: z.string().max(50).optional(),
    state: z.string().max(20),
    oldrev: z.string().max(64).optional(),
    last_commit: z.object({ id: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/) }),
  }),
});

export interface WebhookHeaders {
  readonly token: string | undefined;
  readonly event: string | undefined;
  readonly deliveryId: string | undefined;
}

export type WebhookResult =
  | { readonly status: 'queued'; readonly jobId: string }
  | { readonly status: 'ignored'; readonly reason: string }
  | { readonly status: 'duplicate' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GitLab merge request webhook intake. Fast and side-effect-light: verify, deduplicate, enqueue.
 *
 * Security:
 *  - The per-repository token (X-Gitlab-Token) is compared against a stored SHA-256 hash in
 *    constant time; unknown repositories and bad tokens get the same 401 (no enumeration).
 *  - The payload's project id must match the repository the URL names, so a token for one project
 *    cannot trigger reviews for another.
 *  - Delivery ids are recorded once (replay protection); the job id is idempotent per head SHA.
 *  - Payload text (titles, descriptions) is never stored or forwarded — only identifiers.
 */
@Injectable()
export class GitLabWebhookService {
  private readonly logger = new Logger(GitLabWebhookService.name);

  constructor(
    @Inject(ReviewStore) private readonly store: ReviewStore,
    @Inject(ReviewQueueProducer) private readonly queue: ReviewQueueProducer,
  ) {}

  async handle(repositoryId: string, headers: WebhookHeaders, body: unknown): Promise<WebhookResult> {
    const repository = UUID.test(repositoryId) ? await this.store.findRepositoryForReview(repositoryId) : null;
    if (
      !repository?.webhookSecretHash ||
      !headers.token ||
      !tokenMatchesHash(headers.token, repository.webhookSecretHash)
    ) {
      this.logger.warn(
        { repositoryId: repositoryId.slice(0, 64) },
        'Rejected GitLab webhook (unknown repository or bad token)',
      );
      throw new UnauthorizedException('Invalid webhook token');
    }

    if (headers.event !== 'Merge Request Hook') {
      return this.ignore(repository.id, headers, 'unsupported event');
    }
    const parsed = MergeRequestHookSchema.safeParse(body);
    if (!parsed.success) return this.ignore(repository.id, headers, 'unrecognised payload');
    const { project, object_attributes: mr } = parsed.data;
    if (String(project.id) !== repository.externalId) {
      throw new UnauthorizedException('Invalid webhook token');
    }
    if (!repository.isActive) return this.ignore(repository.id, headers, 'repository inactive');
    if (mr.state !== 'opened') return this.ignore(repository.id, headers, `merge request ${mr.state}`);

    const action = mr.action ?? '';
    const newCommits = action === 'update' && Boolean(mr.oldrev);
    if (!(action === 'open' || action === 'reopen' || newCommits)) {
      return this.ignore(repository.id, headers, `action "${action}" does not change code`);
    }

    const deliveryId = this.deliveryId(headers, repository.id, mr.last_commit.id, action);
    const recorded = await this.store.recordWebhookDelivery({
      provider: 'GITLAB',
      deliveryId,
      repositoryId: repository.id,
      event: headers.event,
      status: 'ACCEPTED',
    });
    if (recorded === 'duplicate') return { status: 'duplicate' };

    const { jobId } = await this.queue.enqueueMergeRequestReview({
      organizationId: repository.organizationId,
      repositoryId: repository.id,
      provider: 'gitlab',
      requestId: mr.iid,
      headSha: mr.last_commit.id,
      deliveryId,
      trigger: 'webhook',
    });
    this.logger.log({ repositoryId: repository.id, iid: mr.iid, jobId }, 'Queued merge request review');
    return { status: 'queued', jobId };
  }

  private async ignore(repositoryId: string, headers: WebhookHeaders, reason: string): Promise<WebhookResult> {
    if (headers.deliveryId) {
      await this.store.recordWebhookDelivery({
        provider: 'GITLAB',
        deliveryId: headers.deliveryId,
        repositoryId,
        event: headers.event ?? 'unknown',
        status: 'IGNORED',
        reason,
      });
    }
    return { status: 'ignored', reason };
  }

  /** GitLab sends X-Gitlab-Event-UUID per delivery; fall back to a stable hash of the change. */
  private deliveryId(headers: WebhookHeaders, repositoryId: string, headSha: string, action: string): string {
    const header = headers.deliveryId?.trim();
    if (header && /^[A-Za-z0-9-]{8,100}$/.test(header)) return header;
    return `derived-${hashToken(`${repositoryId}:${headSha}:${action}`).slice(0, 40)}`;
  }
}
