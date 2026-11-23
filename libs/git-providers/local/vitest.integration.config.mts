import { integrationConfig } from '../../../tools/testing/vitest-integration.mts';

export default integrationConfig(import.meta.dirname, 'git-providers-local', { requiredEnv: [] });
