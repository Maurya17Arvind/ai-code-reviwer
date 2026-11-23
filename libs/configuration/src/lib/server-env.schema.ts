import * as z from 'zod';

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
