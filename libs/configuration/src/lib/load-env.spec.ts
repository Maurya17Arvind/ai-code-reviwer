import { GitHubAppEnvSchema } from './server-env.schema';
import { MailEnvSchema } from './mail-env.schema';
import { ConfigValidationError, loadEnv } from './load-env';

describe('loadEnv', () => {
  it('treats empty variables as unset (docker compose passes `${VAR:-}` as an empty string)', () => {
    // Exactly what docker-compose.prod.yml hands the containers when optional settings are left blank.
    const env = loadEnv(GitHubAppEnvSchema.extend(MailEnvSchema.shape), {
      GITHUB_APP_ID: '',
      GITHUB_APP_PRIVATE_KEY: '',
      GITHUB_WEBHOOK_SECRET: '',
      MAIL_SMTP_URL: '',
      MAIL_FROM: '',
      MAIL_REQUIRE_TLS: '',
    });
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.MAIL_SMTP_URL).toBeUndefined();
    expect(env.MAIL_REQUIRE_TLS).toBe(true); // the default applies
  });

  it('still validates non-empty values and never echoes them', () => {
    try {
      loadEnv(GitHubAppEnvSchema, { GITHUB_APP_ID: 'secret-looking-value' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as Error).message).toContain('GITHUB_APP_ID');
      expect((error as Error).message).not.toContain('secret-looking-value');
    }
  });
});
