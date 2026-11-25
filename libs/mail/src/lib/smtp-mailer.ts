import { createTransport, type NodemailerError } from 'nodemailer';
import {
  type MailAddress,
  MailDeliveryError,
  type Mailer,
  type MailMessage,
  type MailReceipt,
  singleLine,
} from './mailer';

export interface SmtpMailerOptions {
  /** `smtp://` or `smtps://` URL, optionally with credentials (`smtps://user:pass@host:465`). */
  readonly url: string;
  readonly from: MailAddress;
  readonly replyTo?: MailAddress;
  /** Applies to connecting, the greeting and an idle socket. Default 30 s. */
  readonly timeoutMs?: number;
  /**
   * For `smtp://`: refuse to send unless the connection upgrades with STARTTLS. Default true, because
   * messages carry single-use sign-in links. `smtps://` is always encrypted.
   */
  readonly requireTls?: boolean;
}

/** Commands whose 5xx reply rejects this message or recipient (as opposed to the session or our config). */
const MESSAGE_COMMANDS = /^(RCPT|DATA)\b/i;

/**
 * Sends mail over SMTP with nodemailer (ADR-040). One connection per message: transactional volume is
 * low and a pool would hold idle connections that relays drop anyway.
 */
export class SmtpMailer implements Mailer {
  private readonly transport;

  constructor(private readonly options: SmtpMailerOptions) {
    const timeout = options.timeoutMs ?? 30_000;
    this.transport = createTransport({
      url: options.url,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
      requireTLS: options.requireTls ?? true,
      // Messages are composed only from rendered strings: never read files or fetch URLs while composing.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(message: MailMessage): Promise<MailReceipt> {
    try {
      const info = await this.transport.sendMail({
        from: toNodemailerAddress(this.options.from),
        ...(this.options.replyTo ? { replyTo: toNodemailerAddress(this.options.replyTo) } : {}),
        to: toNodemailerAddress(message.to),
        subject: singleLine(message.subject),
        text: message.text,
        html: message.html,
      });
      return { messageId: info.messageId };
    } catch (error) {
      throw toDeliveryError(error);
    }
  }

  async close(): Promise<void> {
    this.transport.close();
  }
}

function toNodemailerAddress(mailbox: MailAddress): { name: string; address: string } {
  return { name: singleLine(mailbox.name ?? ''), address: singleLine(mailbox.address) };
}

/** Maps a nodemailer error to a {@link MailDeliveryError}; the message never includes credentials. */
export function toDeliveryError(error: unknown): MailDeliveryError {
  const e = (error ?? {}) as NodemailerError;
  const rejectsMessage =
    e.permanent === true &&
    (MESSAGE_COMMANDS.test(e.command ?? '') || e.recipient !== undefined || (e.rejected?.length ?? 0) > 0);
  const detail = e.responseCode ? `SMTP ${e.responseCode}` : (e.code ?? 'unknown error');
  const step = e.command ? ` during ${singleLine(e.command).split(' ')[0]}` : '';
  return new MailDeliveryError(`Mail delivery failed: ${detail}${step}`, rejectsMessage, { cause: error });
}

/** `smtps://user:secret@mail.example.com:465` → `smtps://mail.example.com:465`, for logs and health output. */
export function describeSmtpUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return '(invalid SMTP URL)';
  }
}
