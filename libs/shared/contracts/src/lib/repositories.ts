// Browser-safe: `zod/mini` keeps dashboard bundles small.
import { GitProviderKindSchema } from '@acra/shared-types';
import * as z from 'zod/mini';
import { NullableTimestampSchema, TimestampSchema } from './common';

export const RepositorySchema = z.object({
  id: z.string(),
  provider: GitProviderKindSchema,
  fullName: z.string(),
  defaultBranch: z.string(),
  webUrl: z.nullable(z.string()),
  isActive: z.boolean(),
  connectionId: z.nullable(z.string()),
  connectionName: z.nullable(z.string()),
  /** GitLab: a webhook is registered. GitHub uses the App webhook and is always true. */
  webhookConfigured: z.boolean(),
  lastReviewAt: NullableTimestampSchema,
  createdAt: TimestampSchema,
});
export type Repository = z.infer<typeof RepositorySchema>;

export const UpdateRepositoryRequestSchema = z.object({ isActive: z.boolean() });
export type UpdateRepositoryRequest = z.infer<typeof UpdateRepositoryRequestSchema>;

/** A provider connection. Credentials are write-only and never returned. */
export const ConnectionSchema = z.object({
  id: z.string(),
  provider: GitProviderKindSchema,
  name: z.string(),
  baseUrl: z.string(),
  accountLogin: z.nullable(z.string()),
  installationId: z.nullable(z.string()),
  hasStoredToken: z.boolean(),
  repositoryCount: z.int(),
  createdAt: TimestampSchema,
});
export type Connection = z.infer<typeof ConnectionSchema>;

/** Which connection flows this API instance can perform (depends on server configuration). */
export const IntegrationCapabilitiesSchema = z.object({
  /** CREDENTIALS_MASTER_KEY is configured on the API, so GitLab tokens can be stored. */
  gitlabConnect: z.boolean(),
  /** WEBHOOK_PUBLIC_BASE_URL is configured, so GitLab hooks can be registered. */
  gitlabWebhooks: z.boolean(),
  gitlabAllowedHosts: z.array(z.string()),
  /** GITHUB_WEBHOOK_SECRET is configured. Installations are connected with the operator CLI. */
  githubWebhooks: z.boolean(),
});
export type IntegrationCapabilities = z.infer<typeof IntegrationCapabilitiesSchema>;

export const ConnectGitLabRequestSchema = z.object({
  connectionName: z.string().check(z.trim(), z.minLength(1), z.maxLength(200), z.regex(/^[A-Za-z0-9 ._-]+$/)),
  baseUrl: z.url({ protocol: /^https?$/ }).check(z.maxLength(2048)),
  /** Project id or "group/sub/project". */
  project: z.string().check(z.trim(), z.minLength(1), z.maxLength(500), z.regex(/^[A-Za-z0-9_.\-/]+$/)),
  /** Personal/project access token with `api` scope. Write-only: encrypted and never returned. */
  token: z.string().check(z.minLength(10), z.maxLength(500)),
  webhook: z.enum(['register', 'manual', 'none']),
});
export type ConnectGitLabRequest = z.infer<typeof ConnectGitLabRequestSchema>;

export const ConnectGitLabResponseSchema = z.object({
  repositoryId: z.string(),
  projectPath: z.string(),
  webhookUrl: z.nullable(z.string()),
  webhookId: z.nullable(z.string()),
  /** Manual webhook setup only: the secret token, shown once and not stored. */
  webhookToken: z.nullable(z.string()),
});
export type ConnectGitLabResponse = z.infer<typeof ConnectGitLabResponseSchema>;
