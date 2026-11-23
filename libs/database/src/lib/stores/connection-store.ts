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
