/**
 * Paths redacted by the structured logger (pino `redact` syntax).
 * Covers HTTP credentials, provider webhook secrets and common secret-bearing keys.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-gitlab-token"]',
  'req.headers["x-hub-signature"]',
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwd',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.csrfToken',
  '*.sessionToken',
  '*.secret',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.privateKey',
  '*.authorization',
  '*.databaseUrl',
  '*.redisUrl',
];

export const REDACTED = '[REDACTED]';

/**
 * Returns the URL with username and password replaced, safe for logs and error messages.
 * Unparseable input is never echoed back, because it may itself be a secret.
 */
export function maskUrlCredentials(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return '[invalid-url]';
  }
  if (url.username) url.username = '***';
  if (url.password) url.password = '***';
  return url.toString();
}
