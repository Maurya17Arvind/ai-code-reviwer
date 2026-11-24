import { AuthStore } from '@acra/database';
import { generateToken, hashToken } from '@acra/security';
import { type SessionResponse } from '@acra/shared-contracts';
import { HttpException, HttpStatus, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { API_CONFIG, type ApiConfig, dashboardUrl } from '../api-config';
import { type AuthContext } from './auth-context';
import { RATE_LIMITER } from '../common/rate-limit/rate-limit.service';
import { type RateLimiter } from '../common/rate-limit/rate-limiter';
import { dummyPasswordHash, hashPassword, needsRehash, verifyPassword } from './password';
import { csrfTokenFor, isWellFormedSessionToken } from './session-token';

/** Sign-in budgets (Redis, cluster-wide): per client IP, and per account from one client IP. */
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_PER_IP = 30;
export const LOGIN_PER_ACCOUNT_AND_IP = 5;
/** Setup links (invitations, resets) are valid for 72 hours. */
export const SETUP_LINK_TTL_MS = 72 * 3_600_000;
/** lastSeenAt is written at most once a minute per session. */
const TOUCH_INTERVAL_MS = 60_000;

const INVALID_CREDENTIALS = 'Invalid e-mail or password';

interface RequestInfo {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

/**
 * Dashboard authentication (ADR-035): password sign-in with scrypt, server-side sessions in an
 * HttpOnly SameSite=Strict cookie, session-bound CSRF tokens, per-account lockout and per-IP /
 * per-e-mail attempt limits. Responses never reveal whether an e-mail is registered.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(AuthStore) private readonly store: AuthStore,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(RATE_LIMITER) private readonly limits: RateLimiter,
  ) {}

  get sessionTtlMs(): number {
    return this.config.SESSION_TTL_HOURS * 3_600_000;
  }

  /** Verifies credentials and opens a session. Returns the raw session token for the cookie. */
  async login(
    email: string,
    password: string,
    info: RequestInfo,
    now = new Date(),
  ): Promise<{ token: string; session: SessionResponse }> {
    const normalized = email.trim().toLowerCase();
    // Throttled per client IP and per (account, client IP). There is no account-wide lock or budget:
    // otherwise anyone could lock a victim out just by sending wrong passwords for their e-mail.
    const ip = info.ipAddress ?? 'unknown';
    const accountKey = `${normalized}|${ip}`;
    const [byIp, byAccount] = await Promise.all([
      this.limits.consume('login-ip', ip, LOGIN_PER_IP, LOGIN_WINDOW_MS),
      this.limits.consume('login-account-ip', accountKey, LOGIN_PER_ACCOUNT_AND_IP, LOGIN_WINDOW_MS),
    ]);
    if (!byIp.allowed || !byAccount.allowed) {
      throw new HttpException('Too many sign-in attempts. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = await this.store.findUserByEmail(normalized);
    if (!user?.passwordHash) {
      await verifyPassword(password, await dummyPasswordHash()); // equalise timing
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      await this.store.recordFailedLogin(user.id);
      await this.store.audit({
        action: 'auth.login_failed',
        userId: user.id,
        metadata: { reason: 'bad_password' },
        requestId: info.requestId,
        ipAddress: info.ipAddress,
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (needsRehash(user.passwordHash)) await this.store.setPassword(user.id, await hashPassword(password), now);
    await this.limits.reset('login-account-ip', accountKey);
    const token = generateToken();
    const sessionId = await this.store.createSession({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + this.sessionTtlMs),
      ipAddress: info.ipAddress,
      userAgent: info.userAgent,
      now,
    });
    await this.store.audit({
      action: 'auth.login',
      userId: user.id,
      metadata: { sessionId },
      requestId: info.requestId,
      ipAddress: info.ipAddress,
    });
    return {
      token,
      session: await this.sessionResponse(
        { userId: user.id, email: user.email, displayName: user.displayName, lastLoginAt: user.lastLoginAt },
        token,
      ),
    };
  }

  /** Resolves a session cookie to its user, enforcing absolute and idle expiry. */
  async authenticate(token: string | null, now = new Date()): Promise<AuthContext | null> {
    if (!isWellFormedSessionToken(token)) return null;
    const session = await this.store.findActiveSession(hashToken(token), now);
    if (!session) return null;
    if (now.getTime() - session.lastSeenAt.getTime() > this.config.SESSION_IDLE_MINUTES * 60_000) {
      await this.store.revokeSession(session.sessionId, now);
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.store.touchSession(session.sessionId, now);
    }
    return {
      userId: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      lastLoginAt: session.user.lastLoginAt,
      sessionId: session.sessionId,
      sessionToken: token,
    };
  }

  async logout(auth: AuthContext, info: RequestInfo): Promise<void> {
    await this.store.revokeSession(auth.sessionId, new Date());
    await this.store.audit({
      action: 'auth.logout',
      userId: auth.userId,
      requestId: info.requestId,
      ipAddress: info.ipAddress,
    });
  }

  async sessionResponse(
    user: Pick<AuthContext, 'userId' | 'email' | 'displayName' | 'lastLoginAt'>,
    token: string,
  ): Promise<SessionResponse> {
    return {
      user: {
        id: user.userId,
        email: user.email,
        displayName: user.displayName,
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      },
      memberships: await this.store.memberships(user.userId),
      csrfToken: csrfTokenFor(token),
    };
  }

  /** Changes the password of the signed-in user and signs out every other session. */
  async changePassword(auth: AuthContext, currentPassword: string, newPassword: string, info: RequestInfo) {
    const user = await this.store.findUserById(auth.userId);
    if (!user?.passwordHash || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('The current password is incorrect');
    }
    const now = new Date();
    await this.store.setPassword(user.id, await hashPassword(newPassword), now);
    const revoked = await this.store.revokeUserSessions(user.id, now, auth.sessionId);
    // An outstanding invitation/reset link must not survive a password change.
    const linksVoided = await this.store.voidSetupTokens(user.id, now);
    await this.store.audit({
      action: 'auth.password_changed',
      userId: user.id,
      metadata: { otherSessionsRevoked: revoked, setupLinksVoided: linksVoided },
      requestId: info.requestId,
      ipAddress: info.ipAddress,
    });
  }

  /** Accepts an invitation or reset link. The link works once; all sessions are revoked. */
  async setupPassword(token: string, password: string, info: RequestInfo): Promise<void> {
    if (!(await this.limits.consume('setup-ip', info.ipAddress ?? 'unknown', 20, 15 * 60_000)).allowed) {
      throw new HttpException('Too many attempts. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const userId = await this.store.consumeSetupToken(hashToken(token), await hashPassword(password), new Date());
    if (!userId) throw new UnauthorizedException('This link is invalid, expired or already used');
    await this.store.audit({
      action: 'auth.password_set',
      userId,
      requestId: info.requestId,
      ipAddress: info.ipAddress,
    });
    this.logger.log({ userId }, 'Password set from setup link');
  }

  /** Issues a single-use setup link for a user. Returns the URL (shown once) and its expiry. */
  async issueSetupLink(userId: string, purpose: 'INVITE' | 'RESET', createdById: string | null) {
    const token = generateToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SETUP_LINK_TTL_MS);
    await this.store.createSetupToken({ userId, tokenHash: hashToken(token), purpose, createdById, expiresAt, now });
    // Token in the fragment: never sent to servers, proxies or Referer headers.
    return {
      setupUrl: `${dashboardUrl(this.config)}/setup-password#token=${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }
}
