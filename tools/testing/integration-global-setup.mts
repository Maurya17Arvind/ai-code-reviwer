import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Redis } from 'ioredis';
import pg from 'pg';
import { TEST_REDIS_DB, testDatabaseUrl, testRedisUrl } from './integration-targets.mts';

const workspaceRoot = resolve(import.meta.dirname, '..', '..');

/**
 * Vitest global setup for integration suites: makes sure the isolated test database exists and is
 * migrated. Runs once per project; both steps are idempotent. Skipped for git-only suites (no
 * DATABASE_URL) and when ACRA_TEST_USE_DEV_DB=1.
 */
export default async function setup(): Promise<void> {
  const dotEnv = resolve(workspaceRoot, '.env');
  if (existsSync(dotEnv)) process.loadEnvFile(dotEnv);
  const devUrl = process.env['DATABASE_URL'];
  if (!devUrl || process.env['ACRA_TEST_USE_DEV_DB'] === '1') return;

  // Start every run with empty test queues and rate-limit counters (test-only Redis database).
  const redisUrl = process.env['REDIS_URL'];
  if (redisUrl) {
    const target = testRedisUrl(redisUrl);
    if (new URL(target).pathname !== `/${TEST_REDIS_DB}`)
      throw new Error('Refusing to flush a non-test Redis database');
    const redis = new Redis(target, { maxRetriesPerRequest: 1, lazyConnect: true });
    try {
      await redis.connect();
      await redis.flushdb();
    } finally {
      redis.disconnect();
    }
  }

  const testUrl = testDatabaseUrl(devUrl);
  const testName = new URL(testUrl).pathname.slice(1);
  if (!/^[A-Za-z0-9_]+$/.test(testName)) throw new Error('Unexpected test database name');

  const admin = new pg.Client({ connectionString: devUrl });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testName]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${testName}"`);
  } finally {
    await admin.end();
  }

  execFileSync(
    process.execPath,
    [
      resolve(workspaceRoot, 'node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--config',
      'libs/database/prisma.config.ts',
    ],
    { cwd: workspaceRoot, env: { ...process.env, DATABASE_URL: testUrl }, stdio: 'pipe' },
  );
}
