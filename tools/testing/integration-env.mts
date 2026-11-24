import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { useTestTargets } from './integration-targets.mts';

/**
 * Vitest setup file for integration tests (`nx run-many -t integration`).
 * Database/queue suites talk to the real PostgreSQL and Redis started by `pnpm infra:up`;
 * git suites only need the git CLI. Integration tests never call external AI or Git provider APIs.
 */
const workspaceRoot = resolve(import.meta.dirname, '..', '..');
const dotEnvPath = resolve(workspaceRoot, '.env');

if (existsSync(dotEnvPath)) {
  process.loadEnvFile(dotEnvPath);
}
// Never run against the development database or queues (see integration-targets.mts).
useTestTargets();

const required = (process.env['ACRA_REQUIRED_ENV'] ?? '').split(',').filter((name) => name.length > 0);
for (const name of required) {
  if (!process.env[name]) {
    throw new Error(
      `${name} is not set. Integration tests need local infrastructure: copy .env.example to .env and run "pnpm infra:up".`,
    );
  }
}

// Keep test output readable; individual tests can override.
process.env['LOG_LEVEL'] ??= 'warn';
process.env['NODE_ENV'] = 'test';
