import { loadEnv } from '@acra/configuration';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ApiConfigSchema } from './api-config';

const workspaceRoot = resolve(import.meta.dirname, '..', '..', '..', '..');

function template(name: string): Record<string, string> {
  return parseEnv(readFileSync(resolve(workspaceRoot, name), 'utf8')) as Record<string, string>;
}

const REQUIRED = {
  DATABASE_URL: 'postgresql://acra_app:x@postgres:5432/acra?schema=public',
  REDIS_URL: 'redis://:x@redis:6379/0',
  API_CORS_ORIGINS: 'https://review.example.com',
};

describe('API configuration from the committed env templates', () => {
  it('starts from .env.production.example with optional settings empty; mail features off', () => {
    // docker-compose.prod.yml passes MAIL_ENABLED as "${MAIL_SMTP_URL:+true}", i.e. empty while mail is off.
    const config = loadEnv(ApiConfigSchema, { ...template('.env.production.example'), ...REQUIRED, MAIL_ENABLED: '' });
    expect(config.MAIL_ENABLED).toBe(false);
    expect(config.GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(config.METRICS_TOKEN).toBeUndefined();
  });

  it('starts from .env.example with self-service mail features on, and holds no SMTP settings', () => {
    const config = loadEnv(ApiConfigSchema, { ...template('.env.example'), ...REQUIRED });
    expect(config.MAIL_ENABLED).toBe(true);
    expect(config).not.toHaveProperty('MAIL_SMTP_URL');
  });
});
