/**
 * Integration tests never touch the development database or queues (Phase 8):
 *  - PostgreSQL: the same server, database `<name>_test` (created and migrated by the global setup);
 *  - Redis: database index 1 (development uses 0), so a running worker cannot pick up test jobs.
 * Set ACRA_TEST_USE_DEV_DB=1 to run against the development database instead (not recommended).
 */
export const TEST_REDIS_DB = 1;

export function testDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const name = url.pathname.replace(/^\//, '') || 'postgres';
  url.pathname = `/${name.endsWith('_test') ? name : `${name}_test`}`;
  return url.toString();
}

export function testRedisUrl(redisUrl: string): string {
  const url = new URL(redisUrl);
  url.pathname = `/${TEST_REDIS_DB}`;
  return url.toString();
}

/** Points DATABASE_URL and REDIS_URL of this process at the isolated test targets. */
export function useTestTargets(env: NodeJS.ProcessEnv = process.env): void {
  if (env['ACRA_TEST_USE_DEV_DB'] === '1' || env['ACRA_TEST_TARGETS_APPLIED'] === '1') return;
  if (env['DATABASE_URL']) env['DATABASE_URL'] = testDatabaseUrl(env['DATABASE_URL']);
  if (env['REDIS_URL']) env['REDIS_URL'] = testRedisUrl(env['REDIS_URL']);
  env['ACRA_TEST_TARGETS_APPLIED'] = '1';
}
