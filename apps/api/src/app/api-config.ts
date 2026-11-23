import { ApiEnvSchema, GitHubAppEnvSchema } from '@acra/configuration';
import type * as z from 'zod';

/**
 * API configuration. The API verifies GitHub webhooks only, so it receives the webhook secret but
 * never the GitHub App private key (that stays with the worker and the admin CLI).
 */
export const ApiConfigSchema = ApiEnvSchema.extend({
  GITHUB_WEBHOOK_SECRET: GitHubAppEnvSchema.shape.GITHUB_WEBHOOK_SECRET,
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

/** Injection token for the validated API configuration. */
export const API_CONFIG = Symbol('API_CONFIG');
