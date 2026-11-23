import { GitHubAppEnvSchema, resolveGitHubAppSettings } from './server-env.schema';

const PEM = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(120)}\n-----END PRIVATE KEY-----\n`;

describe('GitHub App settings', () => {
  it('is null when the app is not configured, with safe defaults', () => {
    const env = GitHubAppEnvSchema.parse({});
    expect(env.GITHUB_API_URL).toBe('https://api.github.com');
    expect(env.GITHUB_ALLOWED_HOSTS).toEqual(['api.github.com']);
    expect(resolveGitHubAppSettings(env)).toBeNull();
  });

  it('expands escaped newlines in an inline key', () => {
    const env = GitHubAppEnvSchema.parse({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, '\\n') });
    const settings = resolveGitHubAppSettings(env);
    expect(settings?.privateKey).toBe(PEM);
    expect(settings).toMatchObject({ appId: '123', apiBaseUrl: 'https://api.github.com' });
  });

  it('reads the key from a file path', () => {
    const env = GitHubAppEnvSchema.parse({ GITHUB_APP_ID: '9', GITHUB_APP_PRIVATE_KEY_PATH: '/keys/app.pem' });
    expect(resolveGitHubAppSettings(env, () => PEM)?.privateKey).toBe(PEM);
  });

  it('rejects partial or ambiguous configuration without echoing the key', () => {
    expect(() => resolveGitHubAppSettings(GitHubAppEnvSchema.parse({ GITHUB_APP_ID: '1' }))).toThrow(/partially/);
    const both = GitHubAppEnvSchema.parse({
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: PEM,
      GITHUB_APP_PRIVATE_KEY_PATH: '/k.pem',
    });
    expect(() => resolveGitHubAppSettings(both)).toThrow(/only one/);
    const notPem = GitHubAppEnvSchema.parse({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'x'.repeat(150) });
    expect(() => resolveGitHubAppSettings(notPem)).toThrow(/not a PEM private key$/);
    expect(GitHubAppEnvSchema.safeParse({ GITHUB_APP_ID: 'abc' }).success).toBe(false);
  });
});
