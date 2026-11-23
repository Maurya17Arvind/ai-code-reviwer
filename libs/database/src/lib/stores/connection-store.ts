import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type Prisma, type PrismaClient } from '../../generated/prisma/client';
import { PRISMA_CLIENT } from '../tokens';
import { type TenantContext } from './review-store';

/** Administration of organizations, provider connections and repositories. */
@Injectable()
export class ConnectionStore {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async ensureOrganization(slug: string, name: string): Promise<TenantContext & { slug: string }> {
    const org = await this.prisma.organization.upsert({
      where: { slug },
      create: { slug, name },
      update: {},
      select: { id: true, slug: true },
    });
    return { organizationId: org.id, slug: org.slug };
  }

  /** Existing organization by slug (never creates). */
  async findOrganization(slug: string): Promise<TenantContext | null> {
    const org = await this.prisma.organization.findFirst({ where: { slug, deletedAt: null }, select: { id: true } });
    return org ? { organizationId: org.id } : null;
  }

  /**
   * Returns the connection id for (org, provider, name), creating it if needed. The id is known
   * before encryption because it is bound into the ciphertext as associated data.
   */
  async connectionIdFor(tenant: TenantContext, provider: 'GITLAB' | 'GITHUB', name: string): Promise<string> {
    const existing = await this.prisma.providerConnection.findFirst({
      where: { organizationId: tenant.organizationId, provider, name, deletedAt: null },
      select: { id: true },
    });
    return existing?.id ?? randomUUID();
  }

  async saveConnection(
    tenant: TenantContext,
    input: {
      id: string;
      provider: 'GITLAB' | 'GITHUB';
      name: string;
      baseUrl: string;
      encryptedToken: unknown;
      tokenKeyId: string;
    },
  ): Promise<void> {
    const data = {
      baseUrl: input.baseUrl,
      encryptedToken: input.encryptedToken as Prisma.InputJsonValue,
      tokenKeyId: input.tokenKeyId,
    };
    await this.prisma.providerConnection.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        organizationId: tenant.organizationId,
        provider: input.provider,
        name: input.name,
        ...data,
      },
      update: data,
    });
  }

  async upsertRepository(
    tenant: TenantContext,
    input: {
      connectionId: string;
      provider: 'GITLAB' | 'GITHUB';
      externalId: string;
      fullName: string;
      defaultBranch: string;
      webUrl: string;
    },
  ): Promise<{ id: string }> {
    return this.prisma.repository.upsert({
      where: {
        organizationId_provider_externalId: {
          organizationId: tenant.organizationId,
          provider: input.provider,
          externalId: input.externalId,
        },
      },
      create: { organizationId: tenant.organizationId, ...input },
      update: {
        connectionId: input.connectionId,
        fullName: input.fullName,
        defaultBranch: input.defaultBranch,
        webUrl: input.webUrl,
        isActive: true,
        deletedAt: null,
      },
      select: { id: true },
    });
  }

  /**
   * Creates or updates the GitHub App connection for an installation. An installation belongs to
   * exactly one organization: claiming one already connected elsewhere is refused.
   */
  async saveGitHubConnection(
    tenant: TenantContext,
    input: { installationId: number; accountLogin: string; apiBaseUrl: string },
  ): Promise<{ id: string }> {
    const installationId = String(input.installationId);
    const existing = await this.prisma.providerConnection.findFirst({
      where: { provider: 'GITHUB', installationId },
      select: { id: true, organizationId: true },
    });
    if (existing && existing.organizationId !== tenant.organizationId) {
      throw new Error(`GitHub installation ${installationId} is already connected to another organization`);
    }
    const data = { baseUrl: input.apiBaseUrl, accountLogin: input.accountLogin.slice(0, 100), deletedAt: null };
    if (existing) {
      await this.prisma.providerConnection.update({ where: { id: existing.id }, data });
      return { id: existing.id };
    }
    return this.prisma.providerConnection.create({
      data: {
        id: randomUUID(),
        organizationId: tenant.organizationId,
        provider: 'GITHUB',
        name: `github-installation-${installationId}`,
        installationId,
        ...data,
      },
      select: { id: true },
    });
  }

  /** Webhook trust anchor (signature already verified): the connection for an installation. */
  async findGitHubConnection(installationId: number) {
    return this.prisma.providerConnection.findFirst({
      where: { provider: 'GITHUB', installationId: String(installationId), deletedAt: null },
      select: { id: true, organizationId: true },
    });
  }

  /** Activates the given repositories under the connection and, when `exclusive`, deactivates the rest. */
  async syncGitHubRepositories(
    tenant: TenantContext,
    connectionId: string,
    repositories: ReadonlyArray<{ id: number; fullName: string; defaultBranch?: string; webUrl?: string }>,
    options: { exclusive: boolean },
  ): Promise<{ active: number }> {
    for (const repo of repositories) {
      // installation_repositories webhooks carry no default branch / URL: keep what is stored.
      const details = {
        fullName: repo.fullName.slice(0, 500),
        ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch.slice(0, 255) } : {}),
        ...(repo.webUrl ? { webUrl: repo.webUrl.slice(0, 2048) } : {}),
      };
      await this.prisma.repository.upsert({
        where: {
          organizationId_provider_externalId: {
            organizationId: tenant.organizationId,
            provider: 'GITHUB',
            externalId: String(repo.id),
          },
        },
        create: {
          organizationId: tenant.organizationId,
          provider: 'GITHUB',
          externalId: String(repo.id),
          connectionId,
          ...details,
        },
        update: { connectionId, ...details, isActive: true, deletedAt: null },
        select: { id: true },
      });
    }
    if (options.exclusive) {
      await this.prisma.repository.updateMany({
        where: {
          organizationId: tenant.organizationId,
          connectionId,
          externalId: { notIn: repositories.map((r) => String(r.id)) },
        },
        data: { isActive: false },
      });
    }
    return { active: repositories.length };
  }

  async deactivateGitHubRepositories(
    tenant: TenantContext,
    connectionId: string,
    repositoryIds: readonly number[],
  ): Promise<number> {
    const result = await this.prisma.repository.updateMany({
      where: { organizationId: tenant.organizationId, connectionId, externalId: { in: repositoryIds.map(String) } },
      data: { isActive: false },
    });
    return result.count;
  }

  /**
   * Deactivates every repository of a connection (GitHub App suspended or uninstalled). With
   * `deleteConnection`, the connection is soft-deleted too; `connect-github` restores it.
   */
  async deactivateConnectionRepositories(
    tenant: TenantContext,
    connectionId: string,
    options: { deleteConnection: boolean },
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.repository.updateMany({
        where: { organizationId: tenant.organizationId, connectionId, isActive: true },
        data: { isActive: false },
      });
      if (options.deleteConnection) {
        await tx.providerConnection.updateMany({
          where: { id: connectionId, organizationId: tenant.organizationId },
          data: { deletedAt: new Date() },
        });
      }
      return result.count;
    });
  }

  async setWebhook(
    tenant: TenantContext,
    repositoryId: string,
    input: { secretHash: string; webhookId: string },
  ): Promise<void> {
    await this.prisma.repository.updateMany({
      where: { id: repositoryId, organizationId: tenant.organizationId },
      data: { webhookSecretHash: input.secretHash, webhookId: input.webhookId },
    });
  }
}
