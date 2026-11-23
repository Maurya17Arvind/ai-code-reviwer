import { randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from './prisma-client';

/** Sentinel used to roll back every test transaction so tests leave no data behind. */
class Rollback extends Error {}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

describe('database (PostgreSQL integration)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient({ databaseUrl: process.env['DATABASE_URL'] as string, poolMax: 2 });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function inRolledBackTransaction(work: (tx: Tx) => Promise<void>): Promise<void> {
    await expect(
      prisma.$transaction(async (tx) => {
        await work(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  it('connects and executes a query', async () => {
    const rows = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
    expect(rows[0]?.ok).toBe(1);
  });

  it('does not connect as a superuser', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ is_superuser: string }>
    >`SELECT current_setting('is_superuser') AS is_superuser`;
    expect(rows[0]?.is_superuser).toBe('off');
  });

  it('persists the tenancy foundation with relations', async () => {
    await inRolledBackTransaction(async (tx) => {
      const suffix = randomUUID().slice(0, 8);
      const org = await tx.organization.create({ data: { name: 'Acme', slug: `acme-${suffix}` } });
      const user = await tx.user.create({ data: { email: `dev-${suffix}@example.com`, displayName: 'Dev' } });
      await tx.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: 'OWNER' } });
      await tx.repository.create({
        data: { organizationId: org.id, provider: 'GITLAB', externalId: '42', fullName: 'acme/api' },
      });

      const loaded = await tx.organization.findUniqueOrThrow({
        where: { id: org.id },
        include: { members: true, repositories: true },
      });
      expect(loaded.members).toHaveLength(1);
      expect(loaded.members[0]?.role).toBe('OWNER');
      expect(loaded.repositories[0]?.defaultBranch).toBe('main');
      // UUIDv7: version nibble is 7
      expect(org.id[14]).toBe('7');
    });
  });

  it('enforces one membership per user and organization', async () => {
    await inRolledBackTransaction(async (tx) => {
      const suffix = randomUUID().slice(0, 8);
      const org = await tx.organization.create({ data: { name: 'Acme', slug: `dup-${suffix}` } });
      const user = await tx.user.create({ data: { email: `dup-${suffix}@example.com`, displayName: 'Dup' } });
      await tx.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: 'MEMBER' } });
      await expect(
        tx.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  it('rejects malformed slugs and non-normalised emails (CHECK constraints)', async () => {
    await expect(prisma.organization.create({ data: { name: 'Bad', slug: 'Not A Slug' } })).rejects.toThrow();
    await expect(
      prisma.user.create({ data: { email: `Upper-${randomUUID()}@Example.com`, displayName: 'X' } }),
    ).rejects.toThrow();
  });

  it('keeps audit_logs append-only', async () => {
    await inRolledBackTransaction(async (tx) => {
      const entry = await tx.auditLog.create({
        data: { actorType: 'SYSTEM', action: 'test.executed', targetType: 'test', metadata: { ok: true } },
      });
      await expect(tx.auditLog.update({ where: { id: entry.id }, data: { action: 'test.tampered' } })).rejects.toThrow(
        /append-only/,
      );
    });
  });
});
