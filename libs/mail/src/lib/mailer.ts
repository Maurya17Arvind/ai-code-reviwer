/** A mailbox: an address and an optional display name. */
export interface MailAddress {
  readonly address: string;
  readonly name?: string;
}

/** A fully rendered message. Bodies are produced by the templates in this library, never by callers. */
export interface MailMessage {
  readonly to: MailAddress;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface MailReceipt {
  /** Message-ID the server accepted the message under. */
  readonly messageId: string;
}

/**
 * Outbound mail port (ADR-040). Implementations send one message per call and throw
 * {@link MailDeliveryError} on failure, so callers can decide whether a retry can help.
 */
export interface Mailer {
  send(message: MailMessage): Promise<MailReceipt>;
  /** Releases connections. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * A failed delivery. `permanent` is true only when the server refused this message or recipient for
 * good (an SMTP 5xx reply to RCPT TO or DATA): retrying the same message would be refused again.
 * Connection errors, timeouts, 4xx replies and rejected credentials are not permanent: they are
 * either transient or an operator configuration problem that a later retry may find fixed.
 */
export class MailDeliveryError extends Error {
  override readonly name = 'MailDeliveryError';

  constructor(
    message: string,
    readonly permanent: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Removes CR and LF so a value can never start a new header line (header injection). */
export function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}
