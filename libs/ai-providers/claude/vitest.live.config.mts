import { integrationConfig } from '../../../tools/testing/vitest-integration.mts';

/** Opt-in: calls the real provider API (costs money). Run with `pnpm nx run ai-providers-claude:live`. */
export default integrationConfig(import.meta.dirname, 'ai-providers-claude-live', {
  requiredEnv: [],
  include: 'src/**/*.live.spec.ts',
});
