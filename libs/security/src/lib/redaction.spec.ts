import { LOG_REDACT_PATHS, maskUrlCredentials } from './redaction';

describe('maskUrlCredentials', () => {
  it('masks username and password', () => {
    const masked = maskUrlCredentials('postgresql://app:s3cr3t@db.internal:5432/acra');
    expect(masked).toBe('postgresql://***:***@db.internal:5432/acra');
    expect(masked).not.toContain('s3cr3t');
  });

  it('masks password-only redis URLs', () => {
    expect(maskUrlCredentials('redis://:hunter2@localhost:6379/0')).toBe('redis://:***@localhost:6379/0');
  });

  it('leaves credential-free URLs unchanged', () => {
    expect(maskUrlCredentials('https://gitlab.example.com/api/v4')).toBe('https://gitlab.example.com/api/v4');
  });

  it('never echoes unparseable input', () => {
    expect(maskUrlCredentials('not a url but maybe a token')).toBe('[invalid-url]');
  });
});

describe('LOG_REDACT_PATHS', () => {
  it('covers authorization headers and webhook secrets', () => {
    expect(LOG_REDACT_PATHS).toContain('req.headers.authorization');
    expect(LOG_REDACT_PATHS).toContain('req.headers["x-gitlab-token"]');
    expect(LOG_REDACT_PATHS).toContain('req.headers["x-hub-signature-256"]');
  });
});
