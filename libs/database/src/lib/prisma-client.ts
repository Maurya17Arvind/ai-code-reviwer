import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

export interface CreatePrismaClientOptions {
  readonly databaseUrl: string;
  /** Maximum pool size per process. */
  readonly poolMax?: number;
  /** Milliseconds to wait for a new connection before failing. */
  readonly connectionTimeoutMs?: number;
}

/**
 * Creates a Prisma client backed by the node-postgres driver adapter (Prisma 7 architecture).
 * One client per process; it owns its connection pool and must be disconnected on shutdown.
 */
export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.databaseUrl,
    max: options.poolMax ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
  });
  return new PrismaClient({ adapter });
}

export { PrismaClient };
