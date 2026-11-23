import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/libs/ai-providers/factory',
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: 'ai-providers-factory',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/libs/ai-providers/factory',
      provider: 'v8' as const,
    },
  },
}));
