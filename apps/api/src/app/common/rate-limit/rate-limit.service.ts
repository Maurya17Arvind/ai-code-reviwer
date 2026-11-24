import { type ExecutionContext, HttpException, HttpStatus, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Response } from 'express';
import { API_CONFIG, type ApiConfig } from '../../api-config';
import { type AuthenticatedRequest, clientIp } from '../../auth/auth-context';
import { type RateLimiter } from './rate-limiter';

export const RATE_LIMITER = Symbol('RATE_LIMITER');

export type RateLimitPolicy = 'default' | 'webhook' | 'none';
export const RATE_LIMIT_POLICY = 'acra:rateLimitPolicy';
/** Selects the rate-limit policy of a route. `none` is for health probes only. */
export const RateLimit = (policy: RateLimitPolicy) => SetMetadata(RATE_LIMIT_POLICY, policy);

const WINDOW_MS = 60_000;

/**
 * Global rate limit, applied by SessionGuard to every HTTP request (including ones that end in 401,
 * so session tokens cannot be guessed without limit):
 *  - signed-in: RATE_LIMIT_USER_PER_MINUTE per user;
 *  - no valid session: RATE_LIMIT_ANONYMOUS_PER_MINUTE per client IP;
 *  - webhooks: RATE_LIMIT_WEBHOOK_PER_MINUTE per client IP (GitHub/GitLab send from shared IPs).
 * Sign-in and password setup additionally have strict per-IP / per-e-mail limits in AuthService.
 * Responses carry RateLimit-* headers; refusals are 429 with Retry-After.
 */
@Injectable()
export class RateLimitService {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async check(context: ExecutionContext, userId: string | null): Promise<void> {
    if (context.getType() !== 'http' || !this.config.RATE_LIMIT_ENABLED) return;
    const policy =
      this.reflector.getAllAndOverride<RateLimitPolicy | undefined>(RATE_LIMIT_POLICY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'default';
    if (policy === 'none') return;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const ip = clientIp(request) ?? 'unknown';
    const [bucket, key, limit] =
      policy === 'webhook'
        ? ['webhook', ip, this.config.RATE_LIMIT_WEBHOOK_PER_MINUTE]
        : userId
          ? ['user', userId, this.config.RATE_LIMIT_USER_PER_MINUTE]
          : ['anonymous', ip, this.config.RATE_LIMIT_ANONYMOUS_PER_MINUTE];

    const result = await this.limiter.consume(bucket, key, limit, WINDOW_MS);
    const resetSeconds = Math.max(1, Math.ceil(result.resetMs / 1000));
    response.setHeader('RateLimit-Limit', String(result.limit));
    response.setHeader('RateLimit-Remaining', String(result.remaining));
    response.setHeader('RateLimit-Reset', String(resetSeconds));
    if (!result.allowed) {
      response.setHeader('Retry-After', String(resetSeconds));
      throw new HttpException('Too many requests. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
