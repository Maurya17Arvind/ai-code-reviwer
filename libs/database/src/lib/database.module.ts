import { type DynamicModule, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type CreatePrismaClientOptions, createPrismaClient, PrismaClient } from './prisma-client';
import { ApprovalStore } from './stores/approval-store';
import { AuthStore } from './stores/auth-store';
import { ConnectionStore } from './stores/connection-store';
import { InsightsStore } from './stores/insights-store';
import { MaintenanceStore } from './stores/maintenance-store';
import { OrganizationStore } from './stores/organization-store';
import { ReviewStore } from './stores/review-store';
import { PRISMA_CLIENT } from './tokens';

export { PRISMA_CLIENT };

/** Lightweight connectivity probe used by readiness checks. */
@Injectable()
export class DatabaseHealth {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}

@Injectable()
class PrismaLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

@Module({})
export class DatabaseModule {
  static forRoot(options: CreatePrismaClientOptions): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        { provide: PRISMA_CLIENT, useFactory: () => createPrismaClient(options) },
        DatabaseHealth,
        PrismaLifecycle,
        ReviewStore,
        ConnectionStore,
        ApprovalStore,
        AuthStore,
        OrganizationStore,
        InsightsStore,
        MaintenanceStore,
      ],
      exports: [
        PRISMA_CLIENT,
        DatabaseHealth,
        ReviewStore,
        ConnectionStore,
        ApprovalStore,
        AuthStore,
        OrganizationStore,
        InsightsStore,
        MaintenanceStore,
      ],
    };
  }
}
