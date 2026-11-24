import { Logger } from '@nestjs/common';
import { AttemptLimiter } from '../../auth/login-throttle';

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Milliseconds until the current window ends. */
  readonly resetMs: number;
}

/** Atomic fixed-window counter. */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
  reset(key: string): Promise<void>;
  close?(): Promise<void>;
}

/** Minimal Redis surface used by the store (an ioredis client satisfies it). */
export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

// INCR + PEXPIRE on first hit, atomically; returns [count, remaining ttl].
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {count, ttl}`;

export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly redis: RedisEvalClient,
    private readonly prefix = 'acra:ratelimit:',
  ) {}

  async hit(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    const result = (await this.redis.eval(HIT_SCRIPT, 1, `${this.prefix}${key}`, windowMs)) as [number, number];
    return { count: Number(result[0]), ttlMs: Number(result[1]) };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`${this.prefix}${key}`);
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

/**
 * Cluster-wide rate limiting (Phase 8). Limits are shared by every API instance through Redis.
 * When Redis is unavailable the limiter falls back to per-process memory instead of failing
 * requests: an outage of Redis must not take the API down, and limits still apply per instance.
 */
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);
  private readonly fallbacks = new Map<string, AttemptLimiter>();
  private lastWarning = 0;

  constructor(
    private readonly store: RateLimitStore | null,
    private readonly now: () => number = Date.now,
  ) {}

  async consume(bucket: string, key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    if (this.store) {
      try {
        const { count, ttlMs } = await this.store.hit(`${bucket}:${key}`, windowMs);
        return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetMs: Math.max(0, ttlMs) };
      } catch (error) {
        if (this.now() - this.lastWarning > 60_000) {
          this.lastWarning = this.now();
          this.logger.warn({ err: error instanceof Error ? error.message : 'unknown' }, 'Rate limit store unavailable; using in-memory limits');
        }
      }
    }
    const fallbackKey = `${bucket}:${limit}:${windowMs}`;
    let limiter = this.fallbacks.get(fallbackKey);
    if (!limiter) {
      limiter = new AttemptLimiter(limit, windowMs);
      this.fallbacks.set(fallbackKey, limiter);
    }
    const allowed = limiter.tryConsume(key, this.now());
    return { allowed, limit, remaining: allowed ? 1 : 0, resetMs: windowMs };
  }

  /** Clears a key (e.g. the per-e-mail sign-in counter after a successful sign-in). */
  async reset(bucket: string, key: string): Promise<void> {
    await this.store?.reset(`${bucket}:${key}`).catch(() => undefined);
    for (const [fallbackKey, limiter] of this.fallbacks) if (fallbackKey.startsWith(`${bucket}:`)) limiter.reset(key);
  }

  async close(): Promise<void> {
    await this.store?.close?.();
  }
}
