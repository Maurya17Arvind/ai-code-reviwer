import { ConnectionStore, OrganizationStore, ReviewStore } from '@acra/database';
import { GitProviderError, ProviderApiError } from '@acra/git-providers-core';
import { type MasterKey, parseMasterKey, UnsafeOutboundUrlError } from '@acra/security';
import {
  type Connection,
  type ConnectGitLabRequest,
  type ConnectGitLabResponse,
  type IntegrationCapabilities,
  type Repository,
} from '@acra/shared-contracts';
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { connectGitLabProject } from '../../admin/connect-gitlab';
import { API_CONFIG, type ApiConfig } from '../api-config';
import { type AuthContext, type MembershipContext } from '../auth/auth-context';
import { mapErrors } from '../common/domain-errors';
import { audit, type RequestMeta, tenant } from '../organizations/organizations.service';

const iso = (date: Date) => date.toISOString();

/** Optional seam so tests can point the GitLab client at a fake server. */
export const GITLAB_FETCH = Symbol('GITLAB_FETCH');

@Injectable()
export class RepositoriesService {
  private readonly logger = new Logger(RepositoriesService.name);
  private readonly masterKey: MasterKey | null;

  constructor(
    @Inject(OrganizationStore) private readonly store: OrganizationStore,
    @Inject(ConnectionStore) private readonly connections: ConnectionStore,
    @Inject(ReviewStore) private readonly reviews: ReviewStore,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    this.masterKey = null;
    if (config.CREDENTIALS_MASTER_KEY) {
      try {
        this.masterKey = parseMasterKey(config.CREDENTIALS_MASTER_KEY);
      } catch {
        this.logger.warn(
          'CREDENTIALS_MASTER_KEY is invalid; connecting GitLab projects from the dashboard is disabled',
        );
      }
    }
  }

  capabilities(): IntegrationCapabilities {
    return {
      gitlabConnect: this.masterKey !== null,
      gitlabWebhooks: Boolean(this.config.WEBHOOK_PUBLIC_BASE_URL),
      gitlabAllowedHosts: [...this.config.GITLAB_ALLOWED_HOSTS],
      githubWebhooks: Boolean(this.config.GITHUB_WEBHOOK_SECRET),
    };
  }

  async list(membership: MembershipContext): Promise<Repository[]> {
    return (await this.store.listRepositories(tenant(membership))).map((r) => ({
      ...r,
      lastReviewAt: r.lastReviewAt ? iso(r.lastReviewAt) : null,
      createdAt: iso(r.createdAt),
    }));
  }

  async setActive(auth: AuthContext, membership: MembershipContext, id: string, isActive: boolean, meta: RequestMeta) {
    await mapErrors(() => this.store.setRepositoryActive(tenant(membership), id, isActive, audit(auth, meta)));
    const repository = (await this.list(membership)).find((r) => r.id === id);
    if (!repository) throw new NotFoundException('Repository not found');
    return repository;
  }

  async listConnections(membership: MembershipContext): Promise<Connection[]> {
    return (await this.store.listConnections(tenant(membership))).map((c) => ({ ...c, createdAt: iso(c.createdAt) }));
  }

  /**
   * Connects a GitLab project with a token the admin enters once. The token is validated against
   * GitLab, envelope-encrypted with the connection id as associated data and never returned. The
   * base URL must pass the SSRF policy (GITLAB_ALLOWED_HOSTS).
   */
  async connectGitLab(
    auth: AuthContext,
    membership: MembershipContext,
    input: ConnectGitLabRequest,
    meta: RequestMeta,
    fetchImpl?: typeof fetch,
  ): Promise<ConnectGitLabResponse> {
    if (!this.masterKey) {
      throw new ForbiddenException('Connecting GitLab from the dashboard is not enabled on this server');
    }
    if (input.webhook !== 'none' && !this.config.WEBHOOK_PUBLIC_BASE_URL) {
      throw new BadRequestException(
        'Webhooks need WEBHOOK_PUBLIC_BASE_URL on the server; choose "none" or ask an operator',
      );
    }
    const org = await this.store.getOrganization(tenant(membership));
    if (!org) throw new NotFoundException('Organization not found');
    const masterKey = this.masterKey;
    try {
      const result = await mapErrors(() =>
        connectGitLabProject(
          {
            connections: this.connections,
            reviews: this.reviews,
            masterKey,
            policy: {
              allowedHosts: this.config.GITLAB_ALLOWED_HOSTS,
              allowPrivateNetwork: this.config.GITLAB_ALLOW_PRIVATE_NETWORK,
            },
            ...(fetchImpl ? { fetchImpl } : {}),
          },
          {
            organizationSlug: org.slug,
            organizationName: org.name,
            connectionName: input.connectionName,
            baseUrl: input.baseUrl,
            project: input.project,
            token: input.token,
            ...(input.webhook !== 'none' && this.config.WEBHOOK_PUBLIC_BASE_URL
              ? { webhookBaseUrl: this.config.WEBHOOK_PUBLIC_BASE_URL }
              : {}),
            registerWebhook: input.webhook === 'register',
            actorUserId: auth.userId,
          },
        ),
      );
      this.logger.log({ repositoryId: result.repositoryId, requestId: meta.requestId }, 'GitLab project connected');
      return {
        repositoryId: result.repositoryId,
        projectPath: result.projectPath,
        webhookUrl: result.webhookUrl,
        webhookId: result.webhookId,
        webhookToken: result.webhookToken,
      };
    } catch (error) {
      // Provider/SSRF errors carry our own messages (no token, no response body).
      if (error instanceof UnsafeOutboundUrlError) throw new BadRequestException(error.message);
      if (error instanceof ProviderApiError) {
        const hint =
          error.status === 401 || error.status === 403
            ? 'the token is invalid or lacks the api scope / Maintainer role'
            : error.status === 404
              ? 'the project was not found or the token cannot see it'
              : error.message;
        throw new BadRequestException(`GitLab rejected the request: ${hint}`);
      }
      if (error instanceof GitProviderError) throw new BadRequestException(`GitLab: ${error.message}`);
      throw error;
    }
  }
}
