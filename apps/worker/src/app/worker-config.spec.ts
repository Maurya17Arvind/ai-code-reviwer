import { loadEnv } from '@acra/configuration';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { resolveWorkerMail, WorkerConfigSchema } from './worker-config';

const workspaceRoot = resolve(import.meta.dirname, '..', '..', '..', '..');

/** Values the operator must fill in; everything else comes from the template as committed. */
const SECRETS = {
  DATABASE_URL: 'postgresql://acra_app:x@postgres:5432/acra?schema=public',
  REDIS_URL: 'redis://:x@redis:6379/0',
  CREDENTIALS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
};

function template(name: string): Record<string, string> {
  return parseEnv(readFileSync(resolve(workspaceRoot, name), 'utf8')) as Record<string, string>;
}

describe('worker configuration from the committed env templates', () => {
  it('starts from .env.production.example with optional settings left empty (mail off)', () => {
    const config = loadEnv(WorkerConfigSchema, { ...template('.env.production.example'), ...SECRETS });
    expect(config.GITHUB_APP_ID).toBeUndefined();
    expect(config.MAIL_REQUIRE_TLS).toBe(true);
    expect(resolveWorkerMail(config)).toBeNull();
  });

  it('starts from .env.example with mail going to the local Mailpit', () => {
    const config = loadEnv(WorkerConfigSchema, { ...template('.env.example'), ...SECRETS });
    expect(resolveWorkerMail(config)).toMatchObject({
      smtpUrl: 'smtp://127.0.0.1:1025',
      dashboardUrl: 'http://localhost:4300',
      requireTls: false,
    });
  });

  it('refuses mail without a dashboard URL, the only allowed base for links', () => {
    const config = loadEnv(WorkerConfigSchema, {
      ...SECRETS,
      MAIL_SMTP_URL: 'smtps://smtp.example.com:465',
      MAIL_FROM: 'noreply@example.com',
    });
    expect(() => resolveWorkerMail(config)).toThrow(/DASHBOARD_PUBLIC_URL is required/);
  });
});
