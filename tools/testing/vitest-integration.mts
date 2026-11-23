import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest configuration for `*.integration.spec.ts` files.
 * Each project has a tiny vitest.integration.config.mts that calls this factory.
 */
export function integrationConfig(projectDir: string, name: string) {
  return defineConfig({
    root: projectDir,
    cacheDir: resolve(projectDir, '../../node_modules/.vite/integration', name),
    resolve: { tsconfigPaths: true },
    test: {
      name: `${name}-integration`,
      watch: false,
      globals: true,
      environment: 'node',
      include: ['src/**/*.integration.spec.ts'],
      setupFiles: [resolve(import.meta.dirname, 'integration-env.mts')],
      testTimeout: 30_000,
      hookTimeout: 30_000,
      fileParallelism: false,
      reporters: ['default'],
    },
  });
}
