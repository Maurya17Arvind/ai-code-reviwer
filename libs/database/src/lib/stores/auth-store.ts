import { Inject, Injectable } from '@nestjs/common';
import { type PrismaClient, type SetupTokenPurpose } from '../../generated/prisma/client';
import { PRISMA_CLIENT } from '../tokens';

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string | null;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
  readonly lastLoginAt: Date | null;
  readonly emailVerifiedAt: Date | null;
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly lastLoginAt: Date | null;
    readonly emailVerifiedAt: Date | null;
  };
}

const USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  passwordHash: true,
  failedLoginCount: true,
  lockedUntil: true,
  lastLoginAt: true,
  emailVerifiedAt: true,
} as const;

/**
 * Users, browser sessions and password setup links (ADR-035). Tokens are stored as SHA-256
 * hashes only; the caller hashes before calling. Not tenant-scoped: identity is platform-wide,
 * authorization happens per organization membership.
 */
@Injectable()
export class AuthStore {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    return this.prisma.user.findFirst({
      where: { email: email.trim().toLowerCase(), deletedAt: null },
      select: USER_SELECT,
    });
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    return this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: USER_SELECT });
  }

  /**
   * Counts a failed sign-in (shown to operators). There is deliberately no account-wide lock: anyone
   * could otherwise keep a victim locked out by sending wrong passwords. Brute force is throttled per
   * account and client IP instead (AuthService, Redis).
   */
  async recordFailedLogin(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { failedLoginCount: { increment: 1 } } });
  }

  /** Voids every unused setup link of a user (after a password change). */
  async voidSetupTokens(userId: string, now: Date): Promise<number> {
    const result = await this.prisma.userSetupToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    });
    return result.count;
  }

  /** Number of live organizations the user belongs to. */
  async membershipCount(userId: string): Promise<number> {
    return this.prisma.organizationMember.count({ where: { userId, organization: { deletedAt: null } } });
  }

  /** Successful sign-in: clears the failure counter and opens a session. */
  async createSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
    now: Date;
  }): Promise<string> {
    const [, session] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: input.userId },
        data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: input.now },
      }),
      this.prisma.userSession.create({
        data: {
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          lastSeenAt: input.now,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent?.slice(0, 300) ?? null,
        },
        select: { id: true },
      }),
    ]);
    return session.id;
  }

  /** Active (not revoked, not expired) session by token hash, with its user. */
  async findActiveSession(tokenHash: string, now: Date): Promise<SessionRecord | null> {
    const row = await this.prisma.userSession.findFirst({
      where: { tokenHash, revokedAt: null, expiresAt: { gt: now }, user: { deletedAt: null } },
      select: {
        id: true,
        expiresAt: true,
        lastSeenAt: true,
        user: { select: { id: true, email: true, displayName: true, lastLoginAt: true, emailVerifiedAt: true } },
      },
    });
    return row ? { sessionId: row.id, expiresAt: row.expiresAt, lastSeenAt: row.lastSeenAt, user: row.user } : null;
  }

  async touchSession(sessionId: string, now: Date): Promise<void> {
    await this.prisma.userSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { lastSeenAt: now } });
  }

  async revokeSession(sessionId: string, now: Date): Promise<void> {
    await this.prisma.userSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
  }

  /** Revokes every session of a user except `keepSessionId` (password change / reset). */
  async revokeUserSessions(userId: string, now: Date, keepSessionId?: string): Promise<number> {
    const result = await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
      data: { revokedAt: now },
    });
    return result.count;
  }

  async setPassword(userId: string, passwordHash: string, now: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
    });
  }

  /**
   * Issues a setup link; earlier unused links of the user are voided so only the newest works.
   * `deliveredByEmail` is set only by the mail worker (ADR-040): using such a link verifies the address.
   */
  async createSetupToken(input: {
    userId: string;
    tokenHash: string;
    purpose: SetupTokenPurpose;
    createdById: string | null;
    expiresAt: Date;
    now: Date;
    deliveredByEmail?: boolean;
  }): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.userSetupToken.updateMany({
        where: { userId: input.userId, usedAt: null },
        data: { usedAt: input.now },
      }),
      this.prisma.userSetupToken.create({
        data: {
          userId: input.userId,
          tokenHash: input.tokenHash,
          purpose: input.purpose,
          createdById: input.createdById,
          expiresAt: input.expiresAt,
          deliveredByEmail: input.deliveredByEmail ?? false,
        },
      }),
    ]);
  }

  /**
   * Consumes a setup link and sets the password atomically. The token is marked used with a
   * compare-and-set, so a link works exactly once even under concurrent requests. All existing
   * sessions of the user are revoked. A link that arrived by e-mail also verifies the address (kept at
   * its first verification). Returns the user id, or null for an unknown/used/expired link.
   */
  async consumeSetupToken(tokenHash: string, passwordHash: string, now: Date): Promise<string | null> {
    return this.prisma.$transaction(async (tx) => {
      const token = await tx.userSetupToken.findFirst({
        where: { tokenHash, usedAt: null, expiresAt: { gt: now }, user: { deletedAt: null } },
        select: { id: true, userId: true, deliveredByEmail: true },
      });
      if (!token) return null;
      const claimed = await tx.userSetupToken.updateMany({
        where: { id: token.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return null;
      await tx.user.update({
        where: { id: token.userId },
        data: { passwordHash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
      });
      if (token.deliveredByEmail) {
        await tx.user.updateMany({
          where: { id: token.userId, emailVerifiedAt: null },
          data: { emailVerifiedAt: now },
        });
      }
      await tx.userSession.updateMany({ where: { userId: token.userId, revokedAt: null }, data: { revokedAt: now } });
      return token.userId;
    });
  }

  /** Memberships of a user in live organizations, for the session payload and access checks. */
  async memberships(userId: string) {
    const rows = await this.prisma.organizationMember.findMany({
      where: { userId, organization: { deletedAt: null } },
      select: { role: true, organization: { select: { id: true, slug: true, name: true } } },
      orderBy: { organization: { name: 'asc' } },
    });
    return rows.map((r) => ({
      organizationId: r.organization.id,
      slug: r.organization.slug,
      name: r.organization.name,
      role: r.role,
    }));
  }

  /** Role of a user in one organization, or null when not a member (or the org is deleted). */
  async roleIn(userId: string, organizationId: string) {
    const row = await this.prisma.organizationMember.findFirst({
      where: { userId, organizationId, organization: { deletedAt: null } },
      select: { role: true },
    });
    return row?.role ?? null;
  }

  /** Platform-level audit entry for an identity event (sign-in, password change). */
  async audit(entry: {
    action: string;
    userId: string | null;
    metadata?: Record<string, unknown>;
    requestId?: string | null;
    ipAddress?: string | null;
    /** `system` records the platform as the actor and the user only as the target (e.g. mail delivery). */
    actor?: 'user' | 'system';
  }): Promise<void> {
    const byUser = entry.actor !== 'system' && entry.userId !== null;
    await this.prisma.auditLog.create({
      data: {
        organizationId: null,
        actorType: byUser ? 'USER' : 'SYSTEM',
        actorUserId: byUser ? entry.userId : null,
        action: entry.action,
        targetType: 'user',
        targetId: entry.userId,
        metadata: (entry.metadata ?? {}) as object,
        requestId: entry.requestId ?? null,
        ipAddress: entry.ipAddress ?? null,
      },
    });
  }

  /** Creates (or finds) a user by e-mail. Used by the operator CLI for bootstrap. */
  async ensureUser(email: string, displayName: string) {
    return this.prisma.user.upsert({
      where: { email: email.trim().toLowerCase() },
      create: { email: email.trim().toLowerCase(), displayName },
      update: {},
      select: { id: true, email: true },
    });
  }
}
