import { FakeSmtpServer } from '@acra/testing';
import { MailDeliveryError } from './mailer';
import { RecordingMailer } from './recording-mailer';
import { describeSmtpUrl, SmtpMailer, toDeliveryError } from './smtp-mailer';
import { passwordResetMail } from './templates';

const FROM = { address: 'noreply@example.com', name: 'AI Code Review' };
const LINK = 'https://app.example.com/setup-password#token=0123456789abcdef0123456789abcdef';

function message(to = 'ana@example.com', displayName = 'Ana Müller') {
  return {
    to: { address: to, name: displayName },
    ...passwordResetMail({ displayName, link: LINK, expiresInHours: 2 }),
  };
}

describe('SmtpMailer (against a real SMTP conversation)', () => {
  const server = new FakeSmtpServer({ credentials: { user: 'mailer', pass: 's3cret:/@' } });
  let mailer: SmtpMailer;

  beforeAll(async () => {
    await server.start();
    // The fake server has no TLS, like a local Mailpit.
    mailer = new SmtpMailer({ url: server.url(), from: FROM, timeoutMs: 5_000, requireTls: false });
  });
  afterAll(async () => {
    await mailer.close();
    await server.stop();
  });
  beforeEach(() => {
    server.messages.length = 0;
    server.rejectRecipients.clear();
  });

  it('delivers subject, text and HTML with authentication', async () => {
    const receipt = await mailer.send(message());
    expect(receipt.messageId).toMatch(/^<.+@.+>$/);

    const [received] = server.to('ana@example.com');
    expect(received?.from).toBe('noreply@example.com');
    expect(received?.subject).toBe('Reset your AI Code Review password');
    expect(received?.headers.get('to')).toContain('ana@example.com');
    expect(received?.text).toContain('Hi Ana Müller,');
    expect(received?.text).toContain(LINK);
    expect(received?.html).toContain(`href="${LINK}"`);
  });

  it('cannot be made to inject headers through the recipient name or subject', async () => {
    await mailer.send({
      ...message('bob@example.com', 'Bob\r\nBcc: eve@example.com'),
      subject: 'Hello\r\nBcc: eve@example.com',
    });
    const [received] = server.to('bob@example.com');
    expect(received?.to).toEqual(['bob@example.com']);
    expect(received?.headers.has('bcc')).toBe(false);
    expect(received?.raw).not.toMatch(/^Bcc:/im);
  });

  it('refuses to send in plain text by default when the server offers no STARTTLS', async () => {
    const strict = new SmtpMailer({ url: server.url(), from: FROM, timeoutMs: 5_000 });
    const error = (await strict.send(message('tls@example.com')).catch((e: unknown) => e)) as MailDeliveryError;
    await strict.close();
    expect(error).toBeInstanceOf(MailDeliveryError);
    expect(error.permanent).toBe(false);
    expect(server.to('tls@example.com')).toHaveLength(0);
  });

  it('reports a rejected recipient as permanent', async () => {
    server.rejectRecipients.set('gone@example.com', '550 5.1.1 No such user');
    const error = await mailer.send(message('gone@example.com')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailDeliveryError);
    expect((error as MailDeliveryError).permanent).toBe(true);
    expect((error as MailDeliveryError).message).toBe('Mail delivery failed: SMTP 550 during RCPT');
  });

  it('reports a temporary rejection as retryable', async () => {
    server.rejectRecipients.set('busy@example.com', '451 4.3.0 Try again later');
    const error = (await mailer.send(message('busy@example.com')).catch((e: unknown) => e)) as MailDeliveryError;
    expect(error.permanent).toBe(false);
  });

  it('treats wrong credentials as retryable configuration trouble, without echoing them', async () => {
    const port = new URL(server.url()).port;
    const wrong = new SmtpMailer({
      url: `smtp://mailer:wrong-pass@127.0.0.1:${port}`,
      from: FROM,
      timeoutMs: 5_000,
      requireTls: false,
    });
    const error = (await wrong.send(message()).catch((e: unknown) => e)) as MailDeliveryError;
    await wrong.close();
    expect(error.permanent).toBe(false);
    expect(error.message).not.toContain('wrong-pass');
  });

  it('treats an unreachable server as retryable', async () => {
    const down = new SmtpMailer({ url: 'smtp://127.0.0.1:1', from: FROM, timeoutMs: 2_000 });
    const error = (await down.send(message()).catch((e: unknown) => e)) as MailDeliveryError;
    await down.close();
    expect(error).toBeInstanceOf(MailDeliveryError);
    expect(error.permanent).toBe(false);
  });
});

describe('toDeliveryError', () => {
  it('only treats message or recipient rejections as permanent', () => {
    expect(toDeliveryError({ permanent: true, responseCode: 554, command: 'DATA' }).permanent).toBe(true);
    expect(toDeliveryError({ permanent: true, responseCode: 550, command: 'MAIL FROM' }).permanent).toBe(false);
    expect(toDeliveryError({ permanent: true, responseCode: 535, command: 'AUTH PLAIN' }).permanent).toBe(false);
    expect(toDeliveryError({ code: 'ETIMEDOUT' }).permanent).toBe(false);
    expect(toDeliveryError(undefined).message).toBe('Mail delivery failed: unknown error');
  });
});

describe('describeSmtpUrl', () => {
  it('drops credentials', () => {
    expect(describeSmtpUrl('smtps://user:secret@mail.example.com:465')).toBe('smtps://mail.example.com:465');
    expect(describeSmtpUrl('smtp://relay.internal')).toBe('smtp://relay.internal');
    expect(describeSmtpUrl('not a url')).toBe('(invalid SMTP URL)');
  });
});

describe('RecordingMailer', () => {
  it('records messages and simulates failures in order', async () => {
    const mailer = new RecordingMailer();
    mailer.failNext(1, true);
    await expect(mailer.send(message())).rejects.toMatchObject({ permanent: true });
    await mailer.send(message());
    expect(mailer.to('ana@example.com')).toHaveLength(1);
  });
});
