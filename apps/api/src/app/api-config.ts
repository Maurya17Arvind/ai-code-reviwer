import { ApiEnvSchema, GitHubAppEnvSchema, GitProviderEnvSchema } from '@acra/configuration';
import * as z from 'zod';

const booleanFlag = z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1');

/**
 * API configuration. The API verifies GitHub webhooks only, so it receives the webhook secret but
 * never the GitHub App private key (that stays with the worker and the admin CLI).
 *
 * Dashboard authentication (Phase 7, ADR-035) and the optional GitLab connect flow live here too.
 * CREDENTIALS_MASTER_KEY is optional for the API: without it, GitLab projects are connected with
 * the operator CLI only.
 */
export const ApiConfigSchema = ApiEnvSchema.extend({
  GITHUB_WEBHOOK_SECRET: GitHubAppEnvSchema.shape.GITHUB_WEBHOOK_SECRET,
  /** Public URL of the dashboard; used to build password setup links. Defaults to the first CORS origin. */
  DASHBOARD_PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** Absolute session lifetime. */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  /** Sessions unused for this long are rejected. */
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
  /** Secure (HTTPS-only, `__Host-`) session cookie. Defaults to true when NODE_ENV=production. */
  SESSION_COOKIE_SECURE: booleanFlag.optional(),
  /** Express `trust proxy` hop count, so audit logs and throttling see the real client IP. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  CREDENTIALS_MASTER_KEY: GitProviderEnvSchema.shape.CREDENTIALS_MASTER_KEY.optional(),
  GITLAB_ALLOWED_HOSTS: GitProviderEnvSchema.shape.GITLAB_ALLOWED_HOSTS,
  GITLAB_ALLOW_PRIVATE_NETWORK: GitProviderEnvSchema.shape.GITLAB_ALLOW_PRIVATE_NETWORK,
  WEBHOOK_PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** Cluster-wide rate limiting through Redis (Phase 8). */
  RATE_LIMIT_ENABLED: booleanFlag.default(true),
  RATE_LIMIT_USER_PER_MINUTE: z.coerce.number().int().min(10).max(100_000).default(600),
  RATE_LIMIT_ANONYMOUS_PER_MINUTE: z.coerce.number().int().min(10).max(100_000).default(120),
  RATE_LIMIT_WEBHOOK_PER_MINUTE: z.coerce.number().int().min(10).max(100_000).default(600),
  /** Bearer token for GET /api/metrics (Prometheus). Unset: the endpoint answers 404. */
  METRICS_TOKEN: z.string().min(20, 'must be at least 20 characters').optional(),
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

/** Injection token for the validated API configuration. */
export const API_CONFIG = Symbol('API_CONFIG');

export function isSecureCookie(config: ApiConfig): boolean {
  return config.SESSION_COOKIE_SECURE ?? config.NODE_ENV === 'production';
}

export function dashboardUrl(config: ApiConfig): string {
  return (config.DASHBOARD_PUBLIC_URL ?? config.API_CORS_ORIGINS[0] ?? 'http://localhost:4300').replace(/\/+$/, '');
}
