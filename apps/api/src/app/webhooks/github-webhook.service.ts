import { ConnectionStore, ReviewStore } from '@acra/database';
import { ReviewQueueProducer } from '@acra/queue';
import { hashToken, verifyWebhookSignature } from '@acra/security';
import { Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as z from 'zod';
import { API_CONFIG, type ApiConfig } from '../api-config';
import { type WebhookResult } from './gitlab-webhook.service';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const RepoRef = z.object({ id, full_name: z.string().min(3).max(500) });

const PullRequestEventSchema = z.object({
  action: z.string().max(50),
  installation: z.object({ id }),
  repository: RepoRef.extend({
    default_branch: z.string().max(255).optional(),
    html_url: z.string().max(2048).optional(),
  }),
  pull_request: z.object({
    number: id,
    state: z.string().max(20),
    head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/) }),
  }),
});

const InstallationRepositoriesEventSchema = z.object({
  action: z.enum(['added', 'removed']),
  installation: z.object({ id }),
  repositories_added: z.array(RepoRef).max(5000).default([]),
  repositories_removed: z.array(RepoRef).max(5000).default([]),
});

const InstallationEventSchema = z.object({ action: z.string().max(50), installation: z.object({ id }) });

/** Pull request actions that put new code in front of the reviewer. */
const REVIEW_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

export interface GitHubWebhookHeaders {
  readonly signature: string | undefined;
  readonly event: string | undefined;
  readonly deliveryId: string | undefined;
}

/**
 * GitHub App webhook intake (one URL for the whole App).
 *
 * Security:
 *  - X-Hub-Signature-256 (HMAC-SHA256 over the raw body with the App's webhook secret) is verified
 *    in constant time before anything in the payload is read.
 *  - Routing trusts only (installation id, repository id) from the signed payload, and only for
 *    installations an administrator connected to an organization; unknown installations are ignored.
 *  - X-GitHub-Delivery ids are recorded once (replay protection); review job ids are idempotent per
 *    head SHA. Payload text (titles, bodies) is never stored or forwarded.
 */
@Injectable()
export class GitHubWebhookService {
  private readonly logger = new Logger(GitHubWebhookService.name);

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(ReviewStore) private readonly store: ReviewStore,
    @Inject(ConnectionStore) private readonly connections: ConnectionStore,
    @Inject(ReviewQueueProducer) private readonly queue: ReviewQueueProducer,
  ) {}

  async handle(headers: GitHubWebhookHeaders, rawBody: Buffer | undefined): Promise<WebhookResult> {
    const secret = this.config.GITHUB_WEBHOOK_SECRET;
    if (!secret) throw new NotFoundException();
    if (!rawBody || !verifyWebhookSignature(secret, rawBody, headers.signature)) {
      this.logger.warn('Rejected GitHub webhook (bad or missing signature)');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { status: 'ignored', reason: 'payload is not JSON' };
    }
    const event = headers.event ?? 'unknown';
    const deliveryId = this.deliveryId(headers, rawBody);

    switch (event) {
      case 'ping':
        return { status: 'ignored', reason: 'ping' };
      case 'pull_request':
        return this.pullRequest(event, deliveryId, body);
      case 'installation_repositories':
        return this.installationRepositories(event, deliveryId, body);
      case 'installation':
        return this.installation(event, deliveryId, body);
      default:
        return this.ignore(deliveryId, event, null, 'unsupported event');
    }
  }

  private async pullRequest(event: string, deliveryId: string, body: unknown): Promise<WebhookResult> {
    const parsed = PullRequestEventSchema.safeParse(body);
    if (!parsed.success) return this.ignore(deliveryId, event, null, 'unrecognised payload');
    const { action, installation, repository: repo, pull_request: pr } = parsed.data;

    let repository = await this.store.findGitHubRepository(installation.id, repo.id);
    if (!repository) {
      // A repository of a connected installation that is not registered yet (e.g. created after an
      // "all repositories" install): register it. Unknown installations are ignored.
      const connection = await this.connections.findGitHubConnection(installation.id);
      if (!connection) return this.ignore(deliveryId, event, null, 'installation not connected');
      await this.connections.syncGitHubRepositories(
        { organizationId: connection.organizationId },
        connection.id,
        [
          {
            id: repo.id,
            fullName: repo.full_name,
            ...(repo.default_branch ? { defaultBranch: repo.default_branch } : {}),
            ...(repo.html_url?.startsWith('https://') ? { webUrl: repo.html_url } : {}),
          },
        ],
        { exclusive: false },
      );
      repository = await this.store.findGitHubRepository(installation.id, repo.id);
      if (!repository) return this.ignore(deliveryId, event, null, 'repository not connected');
    }

    if (!repository.isActive) return this.ignore(deliveryId, event, repository.id, 'repository inactive');
    if (pr.state !== 'open') return this.ignore(deliveryId, event, repository.id, `pull request ${pr.state}`);
    if (!REVIEW_ACTIONS.has(action)) {
      return this.ignore(deliveryId, event, repository.id, `action "${action}" does not change code`);
    }

    const recorded = await this.store.recordWebhookDelivery({
      provider: 'GITHUB',
      deliveryId,
      repositoryId: repository.id,
      event,
      status: 'ACCEPTED',
    });
    if (recorded === 'duplicate') return { status: 'duplicate' };

    const { jobId } = await this.queue.enqueueMergeRequestReview({
      organizationId: repository.organizationId,
      repositoryId: repository.id,
      provider: 'github',
      requestId: pr.number,
      headSha: pr.head.sha,
      deliveryId,
      trigger: 'webhook',
    });
    this.logger.log({ repositoryId: repository.id, number: pr.number, jobId }, 'Queued pull request review');
    return { status: 'queued', jobId };
  }

  private async installationRepositories(event: string, deliveryId: string, body: unknown): Promise<WebhookResult> {
    const parsed = InstallationRepositoriesEventSchema.safeParse(body);
    if (!parsed.success) return this.ignore(deliveryId, event, null, 'unrecognised payload');
    const { installation, repositories_added: added, repositories_removed: removed } = parsed.data;
    const connection = await this.connections.findGitHubConnection(installation.id);
    if (!connection) return this.ignore(deliveryId, event, null, 'installation not connected');

    const recorded = await this.store.recordWebhookDelivery({
      provider: 'GITHUB',
      deliveryId,
      repositoryId: null,
      event,
      status: 'ACCEPTED',
    });
    if (recorded === 'duplicate') return { status: 'duplicate' };

    const tenant = { organizationId: connection.organizationId };
    if (added.length > 0) {
      await this.connections.syncGitHubRepositories(
        tenant,
        connection.id,
        added.map((r) => ({ id: r.id, fullName: r.full_name })),
        { exclusive: false },
      );
    }
    const deactivated =
      removed.length > 0
        ? await this.connections.deactivateGitHubRepositories(
            tenant,
            connection.id,
            removed.map((r) => r.id),
          )
        : 0;
    await this.store.audit(tenant.organizationId, {
      action: 'github.installation_repositories',
      targetType: 'provider_connection',
      targetId: connection.id,
      actorType: 'WEBHOOK',
      metadata: { added: added.length, removed: deactivated },
    });
    return { status: 'ignored', reason: `synced ${added.length} added, ${deactivated} removed` };
  }

  private async installation(event: string, deliveryId: string, body: unknown): Promise<WebhookResult> {
    const parsed = InstallationEventSchema.safeParse(body);
    if (!parsed.success) return this.ignore(deliveryId, event, null, 'unrecognised payload');
    const { action, installation } = parsed.data;
    if (action !== 'deleted' && action !== 'suspend') {
      return this.ignore(deliveryId, event, null, `installation ${action}`);
    }
    const connection = await this.connections.findGitHubConnection(installation.id);
    if (!connection) return this.ignore(deliveryId, event, null, 'installation not connected');
    const recorded = await this.store.recordWebhookDelivery({
      provider: 'GITHUB',
      deliveryId,
      repositoryId: null,
      event,
      status: 'ACCEPTED',
    });
    if (recorded === 'duplicate') return { status: 'duplicate' };

    const tenant = { organizationId: connection.organizationId };
    const count = await this.connections.deactivateConnectionRepositories(tenant, connection.id, {
      deleteConnection: action === 'deleted',
    });
    await this.store.audit(tenant.organizationId, {
      action: `github.installation_${action}`,
      targetType: 'provider_connection',
      targetId: connection.id,
      actorType: 'WEBHOOK',
      metadata: { deactivatedRepositories: count },
    });
    return { status: 'ignored', reason: `installation ${action}: ${count} repositories deactivated` };
  }

  private async ignore(
    deliveryId: string,
    event: string,
    repositoryId: string | null,
    reason: string,
  ): Promise<WebhookResult> {
    await this.store.recordWebhookDelivery({
      provider: 'GITHUB',
      deliveryId,
      repositoryId,
      event,
      status: 'IGNORED',
      reason,
    });
    return { status: 'ignored', reason };
  }

  /** GitHub sends a GUID per delivery (redeliveries reuse it); fall back to a hash of the body. */
  private deliveryId(headers: GitHubWebhookHeaders, rawBody: Buffer): string {
    const header = headers.deliveryId?.trim();
    if (header && /^[A-Za-z0-9-]{8,100}$/.test(header)) return header;
    return `derived-${hashToken(rawBody.toString('utf8')).slice(0, 40)}`;
  }
}
