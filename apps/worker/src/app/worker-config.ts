import {
  AiEnvSchema,
  GitHubAppEnvSchema,
  GitProviderEnvSchema,
  MailEnvSchema,
  type MailSettings,
  resolveMailSettings,
  WorkerEnvSchema,
} from '@acra/configuration';
import * as z from 'zod';

/** Full worker configuration: runtime + AI providers + Git provider access. */
export const WorkerConfigSchema = WorkerEnvSchema.extend(AiEnvSchema.shape)
  .extend(GitProviderEnvSchema.shape)
  .extend(GitHubAppEnvSchema.shape)
  .extend(MailEnvSchema.shape)
  .extend({
    /** Public dashboard URL: the only base for links in e-mails (never taken from a request). */
    DASHBOARD_PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
    /** Health and metrics endpoint of the worker (Phase 8). Port 0 picks a free port (tests). */
    WORKER_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
    WORKER_HTTP_PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
    /** Bearer token for GET /metrics. Unset: the endpoint answers 404. */
    METRICS_TOKEN: z.string().min(20, 'must be at least 20 characters').optional(),
    /** How often the maintenance job runs (stuck reviews, expired approvals, old sessions). */
    MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),
  });
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

/** Mail settings plus the link base, or null when mail is not configured (ADR-040). */
export interface WorkerMailSettings extends MailSettings {
  readonly dashboardUrl: string;
}

/** Throws at startup on partial mail configuration instead of failing on the first message. */
export function resolveWorkerMail(config: WorkerConfig): WorkerMailSettings | null {
  const mail = resolveMailSettings(config);
  if (!mail) return null;
  if (!config.DASHBOARD_PUBLIC_URL) {
    throw new Error('DASHBOARD_PUBLIC_URL is required when mail is configured: it is the base of every link');
  }
  return { ...mail, dashboardUrl: config.DASHBOARD_PUBLIC_URL.replace(/\/+$/, '') };
}

/** Injection token for {@link WorkerMailSettings} (null when mail is not configured). */
export const MAIL_SETTINGS = Symbol('MAIL_SETTINGS');
/** Injection token for the Mailer (null when mail is not configured; tests provide a fake). */
export const MAILER = Symbol('MAILER');
/** Injection token for the AI reviewer factory (tests replace it with fakes). */
export const REVIEWER_FACTORY = Symbol('REVIEWER_FACTORY');
