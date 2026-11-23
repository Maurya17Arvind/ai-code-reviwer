import * as z from 'zod';
import { readFileSync } from 'node:fs';

const booleanFlag = z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1');

const hostList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0),
  )
  .pipe(z.array(z.string().regex(/^[a-z0-9.-]+$|^\[?[0-9a-f:.]+\]?$/, 'must be a hostname')).min(1));

/**
 * Settings for talking to hosted Git providers from the server (worker / admin).
 * Secrets are validated for presence/shape only and never echoed.
 */
export const GitProviderEnvSchema = z.object({
  /** base64 32-byte key, optionally "<kid>:<base64>" (ADR-011). */
  CREDENTIALS_MASTER_KEY: z.string().min(40, 'must be a base64-encoded 32-byte key'),
  /** Hosts the server may call (SSRF allowlist). */
  GITLAB_ALLOWED_HOSTS: hostList.default(['gitlab.com']),
  /** Allow private/loopback GitLab hosts and plain http (on-prem / development only). */
  GITLAB_ALLOW_PRIVATE_NETWORK: booleanFlag.default(false),
});
export type GitProviderEnv = z.infer<typeof GitProviderEnvSchema>;

/** Public base URL GitLab calls back (webhook registration). */
export const WebhookEnvSchema = z.object({
  WEBHOOK_PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }),
});

/**
 * GitHub App settings (Phase 5). All optional so deployments without GitHub still start; GitHub
 * webhooks and jobs are refused until the app is configured. The private key may be given inline
 * (PEM, "\n" escapes allowed) or as a file path.
 */
export const GitHubAppEnvSchema = z.object({
  GITHUB_APP_ID: z.string().regex(/^\d+$/, 'must be the numeric App ID').optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(100, 'must be a PEM private key').optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(20, 'must be at least 20 characters').optional(),
  /** REST base: https://api.github.com or https://<ghes-host>/api/v3 */
  GITHUB_API_URL: z.url({ protocol: /^https?$/ }).default('https://api.github.com'),
  GITHUB_ALLOWED_HOSTS: hostList.default(['api.github.com']),
  GITHUB_ALLOW_PRIVATE_NETWORK: booleanFlag.default(false),
});
export type GitHubAppEnv = z.infer<typeof GitHubAppEnvSchema>;

/** Resolved GitHub App credentials, or null when the app is not configured. */
export interface GitHubAppSettings {
  readonly appId: string;
  readonly privateKey: string;
  readonly apiBaseUrl: string;
  readonly policy: { readonly allowedHosts: readonly string[]; readonly allowPrivateNetwork: boolean };
}

/**
 * Builds the GitHub App settings from the environment. The private key comes from
 * GITHUB_APP_PRIVATE_KEY (literal "\n" escapes are expanded) or GITHUB_APP_PRIVATE_KEY_PATH.
 * Throws when the configuration is partial; never includes key material in messages.
 */
export function resolveGitHubAppSettings(
  env: GitHubAppEnv,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): GitHubAppSettings | null {
  const hasKey = Boolean(env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_APP_PRIVATE_KEY_PATH);
  if (!env.GITHUB_APP_ID && !hasKey) return null;
  if (!env.GITHUB_APP_ID || !hasKey) {
    throw new Error('GitHub App is partially configured: set both GITHUB_APP_ID and a private key');
  }
  if (env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_PRIVATE_KEY_PATH) {
    throw new Error('Set only one of GITHUB_APP_PRIVATE_KEY and GITHUB_APP_PRIVATE_KEY_PATH');
  }
  const privateKey = env.GITHUB_APP_PRIVATE_KEY
    ? env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n')
    : readFile(env.GITHUB_APP_PRIVATE_KEY_PATH ?? '');
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    throw new Error('GitHub App private key is not a PEM private key');
  }
  return {
    appId: env.GITHUB_APP_ID,
    privateKey,
    apiBaseUrl: env.GITHUB_API_URL.replace(/\/+$/, ''),
    policy: { allowedHosts: env.GITHUB_ALLOWED_HOSTS, allowPrivateNetwork: env.GITHUB_ALLOW_PRIVATE_NETWORK },
  };
}
