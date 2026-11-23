import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Vitest setup file for integration tests (`nx run-many -t integration`).
 * Integration tests talk to the real PostgreSQL and Redis started by `pnpm infra:up`.
 * They never call external AI or Git provider APIs.
 */
const workspaceRoot = resolve(import.meta.dirname, '..', '..');
const dotEnvPath = resolve(workspaceRoot, '.env');

if (existsSync(dotEnvPath)) {
  process.loadEnvFile(dotEnvPath);
}

for (const name of ['DATABASE_URL', 'REDIS_URL']) {
  if (!process.env[name]) {
    throw new Error(
      `${name} is not set. Integration tests need local infrastructure: copy .env.example to .env and run "pnpm infra:up".`,
    );
  }
}

// Keep test output readable; individual tests can override.
process.env['LOG_LEVEL'] ??= 'warn';
process.env['NODE_ENV'] = 'test';
