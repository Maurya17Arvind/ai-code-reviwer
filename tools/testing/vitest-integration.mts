import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export interface IntegrationConfigOptions {
  /** Environment variables the suite needs (default: PostgreSQL + Redis). Use [] for git-only suites. */
  readonly requiredEnv?: readonly string[];
  /** Spec file pattern (default: integration specs). */
  readonly include?: string;
}

/**
 * Shared Vitest configuration for `*.integration.spec.ts` files.
 * Each project has a tiny vitest.integration.config.mts that calls this factory.
 */
export function integrationConfig(projectDir: string, name: string, options: IntegrationConfigOptions = {}) {
  const requiredEnv = options.requiredEnv ?? ['DATABASE_URL', 'REDIS_URL'];
  return defineConfig({
    root: projectDir,
    cacheDir: resolve(import.meta.dirname, '../../node_modules/.vite/integration', name),
    resolve: { tsconfigPaths: true },
    test: {
      name: `${name}-integration`,
      watch: false,
      globals: true,
      environment: 'node',
      include: [options.include ?? 'src/**/*.integration.spec.ts'],
      // Only database suites prepare the isolated test database (git-only suites need no Docker).
      globalSetup: requiredEnv.includes('DATABASE_URL')
        ? [resolve(import.meta.dirname, 'integration-global-setup.mts')]
        : [],
      setupFiles: [resolve(import.meta.dirname, 'integration-env.mts')],
      env: { ACRA_REQUIRED_ENV: requiredEnv.join(',') },
      testTimeout: options.include?.includes('.live.') ? 600_000 : 30_000,
      hookTimeout: 30_000,
      fileParallelism: false,
      reporters: ['default'],
    },
  });
}
