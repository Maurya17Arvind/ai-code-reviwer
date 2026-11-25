import {
  accountExistsMail,
  assertSafeLink,
  escapeHtml,
  invitationMail,
  passwordResetMail,
  signupVerificationMail,
} from './templates';

const HOSTILE = `<img src=x onerror=alert(1)> "quoted" & 'single'\r\nBcc: victim@example.com`;
const LINK = 'https://app.example.com/setup-password#token=abc123';

describe('escapeHtml', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('assertSafeLink', () => {
  it('accepts absolute http(s) links', () => {
    expect(assertSafeLink(LINK)).toBe(LINK);
    expect(assertSafeLink('http://127.0.0.1:4300/login')).toBe('http://127.0.0.1:4300/login');
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', '/relative/path', 'mailto:a@b.c', ''])('rejects %j', (link) => {
    expect(() => assertSafeLink(link)).toThrow();
  });
});

describe('templates', () => {
  const all = {
    passwordReset: () => passwordResetMail({ displayName: HOSTILE, link: LINK, expiresInHours: 2 }),
    signupVerification: () => signupVerificationMail({ displayName: HOSTILE, link: LINK, expiresInHours: 24 }),
    accountExists: () =>
      accountExistsMail({
        displayName: HOSTILE,
        signInUrl: 'https://app.example.com/login',
        forgotPasswordUrl: 'https://app.example.com/forgot-password',
      }),
    invitation: () =>
      invitationMail({
        inviterName: HOSTILE,
        organizationName: HOSTILE,
        roleLabel: HOSTILE,
        link: LINK,
        expiresInHours: 72,
        newAccount: true,
      }),
  };

  it.each(Object.entries(all))('%s escapes untrusted names in HTML', (_name, make) => {
    const mail = make();
    expect(mail.html).not.toContain('<img');
    expect(mail.html).not.toContain('onerror=alert(1)>');
    expect(mail.html).toContain('&lt;img');
  });

  it.each(Object.entries(all))('%s keeps untrusted names on one line in plain text and subject', (_name, make) => {
    const mail = make();
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text).not.toMatch(/^Bcc:/m);
  });

  it('puts the link in both parts, attribute-escaped in HTML', () => {
    const mail = passwordResetMail({
      displayName: 'Ana',
      link: 'https://app.example.com/x?a=1&b="2"',
      expiresInHours: 1,
    });
    expect(mail.text).toContain('https://app.example.com/x?a=1&b=%222%22');
    expect(mail.html).toContain('href="https://app.example.com/x?a=1&amp;b=%222%22"');
    expect(mail.text).toContain('expires in 1 hour.');
  });

  it('refuses to render an unsafe action link', () => {
    expect(() => passwordResetMail({ displayName: 'Ana', link: 'javascript:alert(1)', expiresInHours: 1 })).toThrow();
  });

  it('truncates very long names in plain text', () => {
    const mail = signupVerificationMail({ displayName: 'x'.repeat(500), link: LINK, expiresInHours: 1 });
    expect(mail.text.split('\n')[0]?.length).toBeLessThan(100);
  });

  it('words invitations differently for new and existing accounts', () => {
    const base = { inviterName: 'Ana', organizationName: 'Acme', roleLabel: 'Member', link: LINK, expiresInHours: 72 };
    expect(invitationMail({ ...base, newAccount: true }).text).toContain('choose a password');
    expect(invitationMail({ ...base, newAccount: false }).text).toContain('accept or decline');
    expect(invitationMail({ ...base, newAccount: false }).subject).toBe('Invitation to join Acme on AI Code Review');
  });

  it('never includes a token-bearing link in the account-exists mail', () => {
    const mail = all.accountExists();
    expect(mail.text).not.toContain('token=');
    expect(mail.html).not.toContain('token=');
  });
});
