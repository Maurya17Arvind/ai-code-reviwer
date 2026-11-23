import { integrationConfig } from '../../../tools/testing/vitest-integration.mts';

/** Opt-in: calls the local Ollama server. Run with `pnpm nx run ai-providers-ollama:live`. */
export default integrationConfig(import.meta.dirname, 'ai-providers-ollama-live', {
  requiredEnv: [],
  include: 'src/**/*.live.spec.ts',
});
