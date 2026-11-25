import { MailEnvSchema, parseMailbox, resolveMailSettings } from './mail-env.schema';

describe('mail settings', () => {
  it('is disabled when nothing is configured, and requires TLS by default', () => {
    const env = MailEnvSchema.parse({});
    expect(env.MAIL_REQUIRE_TLS).toBe(true);
    expect(resolveMailSettings(env)).toBeNull();
  });

  it('resolves a named sender and reply-to', () => {
    const env = MailEnvSchema.parse({
      MAIL_SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
      MAIL_FROM: 'AI Code Review <noreply@example.com>',
      MAIL_REPLY_TO: 'support@example.com',
      MAIL_REQUIRE_TLS: 'false',
    });
    expect(resolveMailSettings(env)).toEqual({
      smtpUrl: 'smtps://user:pass@smtp.example.com:465',
      from: { address: 'noreply@example.com', name: 'AI Code Review' },
      replyTo: { address: 'support@example.com' },
      requireTls: false,
    });
  });

  it('rejects non-SMTP URLs', () => {
    expect(MailEnvSchema.safeParse({ MAIL_SMTP_URL: 'https://smtp.example.com' }).success).toBe(false);
  });

  it('rejects partial configuration without echoing secrets', () => {
    const url = 'smtp://user:topsecret@smtp.example.com:587';
    expect(() => resolveMailSettings(MailEnvSchema.parse({ MAIL_SMTP_URL: url }))).toThrow(/MAIL_FROM/);
    expect(() => resolveMailSettings(MailEnvSchema.parse({ MAIL_FROM: 'a@example.com' }))).toThrow(/MAIL_SMTP_URL/);
    try {
      resolveMailSettings(MailEnvSchema.parse({ MAIL_SMTP_URL: url, MAIL_FROM: 'not an address' }));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('topsecret');
    }
  });

  it('parses mailboxes strictly', () => {
    expect(parseMailbox('"Ops Team" <ops@example.com>')).toEqual({ address: 'ops@example.com', name: 'Ops Team' });
    expect(parseMailbox('ops@example.com')).toEqual({ address: 'ops@example.com' });
    expect(parseMailbox('Ops <not-an-address>')).toBeNull();
    expect(parseMailbox('ops@example.com\r\nBcc: x@example.com')).toBeNull();
  });
});
