import { type ConnectionStore, type ReviewStore } from '@acra/database';
import {
  connectionSecretContext,
  GitLabClient,
  GitLabProvider,
  resolveGitLabProjectId,
} from '@acra/git-providers-gitlab';
import { encryptSecret, generateToken, hashToken, type MasterKey, type OutboundPolicy } from '@acra/security';

export interface ConnectGitLabOptions {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly connectionName: string;
  /** e.g. https://gitlab.com */
  readonly baseUrl: string;
  /** Numeric id or "group/project". */
  readonly project: string;
  /** Read from the environment by the caller — never from argv. */
  readonly token: string;
  /** e.g. https://review.example.com — the hook URL becomes <base>/api/webhooks/gitlab/<repositoryId>. */
  readonly webhookBaseUrl?: string;
  /** Register the project hook through the API (needs Maintainer). Otherwise print setup details. */
  readonly registerWebhook: boolean;
}

export interface ConnectGitLabDeps {
  readonly connections: ConnectionStore;
  readonly reviews: ReviewStore;
  readonly masterKey: MasterKey;
  readonly policy: OutboundPolicy;
  readonly fetchImpl?: typeof fetch;
}

export interface ConnectGitLabResult {
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly projectId: number;
  readonly projectPath: string;
  readonly webhookUrl: string | null;
  readonly webhookId: string | null;
  /** Only returned when the hook must be configured manually; shown once, never stored. */
  readonly webhookToken: string | null;
}

/**
 * Connects one GitLab project: validates access, stores the envelope-encrypted token, registers
 * the repository and its webhook. Safe to re-run (upserts; rotates the webhook token).
 */
export async function connectGitLabProject(
  deps: ConnectGitLabDeps,
  options: ConnectGitLabOptions,
): Promise<ConnectGitLabResult> {
  const client = new GitLabClient({
    baseUrl: options.baseUrl,
    token: options.token,
    policy: deps.policy,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const projectId = await resolveGitLabProjectId(client, options.project);
  const gitlab = new GitLabProvider(client, projectId);
  const project = await gitlab.getProject(); // proves the token can read the project

  const tenant = await deps.connections.ensureOrganization(options.organizationSlug, options.organizationName);
  const connectionId = await deps.connections.connectionIdFor(tenant, 'GITLAB', options.connectionName);
  await deps.connections.saveConnection(tenant, {
    id: connectionId,
    provider: 'GITLAB',
    name: options.connectionName,
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    encryptedToken: encryptSecret(options.token, deps.masterKey, connectionSecretContext(connectionId)),
    tokenKeyId: deps.masterKey.id,
  });
  const repository = await deps.connections.upsertRepository(tenant, {
    connectionId,
    provider: 'GITLAB',
    externalId: String(project.id),
    fullName: project.pathWithNamespace,
    defaultBranch: project.defaultBranch,
    webUrl: project.webUrl,
  });

  let webhookUrl: string | null = null;
  let webhookId: string | null = null;
  let webhookToken: string | null = null;
  if (options.webhookBaseUrl) {
    webhookUrl = `${options.webhookBaseUrl.replace(/\/+$/, '')}/api/webhooks/gitlab/${repository.id}`;
    const token = generateToken();
    if (options.registerWebhook) {
      webhookId = String(await gitlab.ensureWebhook(webhookUrl, token));
    } else {
      webhookToken = token;
      webhookId = 'manual';
    }
    await deps.connections.setWebhook(tenant, repository.id, { secretHash: hashToken(token), webhookId });
  }

  await deps.reviews.audit(tenant.organizationId, {
    action: 'repository.connected',
    targetType: 'repository',
    targetId: repository.id,
    metadata: {
      provider: 'gitlab',
      projectId: project.id,
      projectPath: project.pathWithNamespace,
      connectionId,
      webhook: options.webhookBaseUrl ? (options.registerWebhook ? 'registered' : 'manual') : 'none',
    },
  });

  return {
    organizationId: tenant.organizationId,
    repositoryId: repository.id,
    projectId: project.id,
    projectPath: project.pathWithNamespace,
    webhookUrl,
    webhookId,
    webhookToken,
  };
}
