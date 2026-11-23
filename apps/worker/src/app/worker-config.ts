import { AiEnvSchema, GitProviderEnvSchema, WorkerEnvSchema } from '@acra/configuration';
import type * as z from 'zod';

/** Full worker configuration: runtime + AI providers + Git provider access. */
export const WorkerConfigSchema = WorkerEnvSchema.extend(AiEnvSchema.shape).extend(GitProviderEnvSchema.shape);
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const WORKER_CONFIG = Symbol('WORKER_CONFIG');
/** Injection token for the AI reviewer factory (tests replace it with fakes). */
export const REVIEWER_FACTORY = Symbol('REVIEWER_FACTORY');
