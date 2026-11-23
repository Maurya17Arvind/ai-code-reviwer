import { type RedisOptions } from 'bullmq';

/**
 * Converts a redis:// or rediss:// URL into BullMQ (ioredis-backed) connection options.
 *
 * BullMQ requirements:
 *  - Workers need `maxRetriesPerRequest: null` so blocking commands are never aborted.
 *  - Producers should fail fast instead of buffering commands while Redis is down,
 *    so API requests do not hang (`enableOfflineQueue: false`).
 */
export function createRedisConnectionOptions(redisUrl: string, role: 'producer' | 'worker'): RedisOptions {
  const url = new URL(redisUrl);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use the redis:// or rediss:// scheme');
  }

  const dbSegment = url.pathname.replace(/^\//, '');
  const db = dbSegment === '' ? 0 : Number(dbSegment);
  if (!Number.isInteger(db) || db < 0) {
    throw new Error('REDIS_URL database index must be a non-negative integer');
  }

  const options: RedisOptions = {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
    db,
    connectTimeout: 5_000,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: { servername: url.hostname } } : {}),
  };

  return role === 'worker'
    ? { ...options, maxRetriesPerRequest: null }
    : { ...options, maxRetriesPerRequest: 1, enableOfflineQueue: false };
}
