import { type DynamicModule, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type CreatePrismaClientOptions, createPrismaClient, PrismaClient } from './prisma-client';

/** Injection token for the process-wide Prisma client. */
export const PRISMA_CLIENT = Symbol('PRISMA_CLIENT');

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
      ],
      exports: [PRISMA_CLIENT, DatabaseHealth],
    };
  }
}
