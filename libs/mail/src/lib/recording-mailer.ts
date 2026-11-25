import { MailDeliveryError, type Mailer, type MailMessage, type MailReceipt } from './mailer';

/**
 * In-memory {@link Mailer} for tests: records every message instead of sending it, and can be told to
 * fail the next sends (transiently or permanently) to exercise retry handling.
 */
export class RecordingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  private failures: boolean[] = [];
  private counter = 0;

  /** The next `count` sends throw a {@link MailDeliveryError} with the given permanence. */
  failNext(count = 1, permanent = false): void {
    for (let i = 0; i < count; i++) this.failures.push(permanent);
  }

  async send(message: MailMessage): Promise<MailReceipt> {
    const failure = this.failures.shift();
    if (failure !== undefined) throw new MailDeliveryError('Simulated delivery failure', failure);
    this.sent.push(message);
    return { messageId: `<recorded-${++this.counter}@test>` };
  }

  async close(): Promise<void> {
    this.failures = [];
  }

  /** Messages sent to one address, oldest first. */
  to(address: string): MailMessage[] {
    return this.sent.filter((m) => m.to.address === address);
  }
}
