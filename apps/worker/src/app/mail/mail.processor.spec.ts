import { MailDeliveryError } from '@acra/mail';
import { MailJobName, type SendMailJob } from '@acra/queue';
import { type Job, UnrecoverableError } from 'bullmq';
import { WorkerMetrics } from '../ops/worker-metrics';
import { type MailDeliveryService } from './mail-delivery.service';
import { MailProcessor } from './mail.processor';

const PAYLOAD: SendMailJob = {
  purpose: 'password_reset',
  userId: '0193a0d2-6b1e-7c3a-9f00-123456789abc',
  correlationId: '0193a0d2-6b1e-7c3a-9f00-123456789abd',
  requestId: null,
};

function fakeJob(overrides: { name?: string; data?: unknown; attemptsMade?: number; attempts?: number } = {}): Job {
  return {
    id: 'mail_1',
    name: overrides.name ?? MailJobName.Send,
    data: overrides.data ?? PAYLOAD,
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 6 },
  } as unknown as Job;
}

function setup(deliver: MailDeliveryService['deliver']) {
  const delivery = { deliver: vi.fn(deliver), recordFailure: vi.fn(async () => undefined) };
  const metrics = new WorkerMetrics();
  const processor = new MailProcessor(delivery as unknown as MailDeliveryService, metrics);
  const count = (outcome: string) =>
    metrics.mail.render().includes(`acra_mail_messages_total{purpose="password_reset",outcome="${outcome}"} 1`);
  return { processor, delivery, count };
}

describe('MailProcessor', () => {
  it('counts a sent message', async () => {
    const { processor, count } = setup(async () => ({ status: 'sent', messageId: '<m@x>' }));
    await expect(processor.process(fakeJob())).resolves.toEqual({ status: 'sent', messageId: '<m@x>' });
    expect(count('sent')).toBe(true);
  });

  it('rethrows a transient failure for a retry, without auditing it as final', async () => {
    const { processor, delivery, count } = setup(async () => {
      throw new MailDeliveryError('Mail delivery failed: SMTP 451 during RCPT', false);
    });
    const error = await processor.process(fakeJob({ attemptsMade: 0 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailDeliveryError);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(delivery.recordFailure).not.toHaveBeenCalled();
    expect(count('retry')).toBe(true);
  });

  it('audits the last transient failure once retries are exhausted', async () => {
    const { processor, delivery, count } = setup(async () => {
      throw new MailDeliveryError('Mail delivery failed: ETIMEDOUT', false);
    });
    await expect(processor.process(fakeJob({ attemptsMade: 5, attempts: 6 }))).rejects.toThrow('ETIMEDOUT');
    expect(delivery.recordFailure).toHaveBeenCalledTimes(1);
    expect(count('failed')).toBe(true);
  });

  it('stops a permanent rejection immediately', async () => {
    const { processor, delivery } = setup(async () => {
      throw new MailDeliveryError('Mail delivery failed: SMTP 550 during RCPT', true);
    });
    const error = await processor.process(fakeJob()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(delivery.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('refuses unknown job names and payloads with extra fields, without retrying', async () => {
    const { processor, delivery } = setup(async () => ({ status: 'sent', messageId: '<m@x>' }));
    await expect(processor.process(fakeJob({ name: 'other' }))).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(processor.process(fakeJob({ data: { ...PAYLOAD, token: 'x' } }))).rejects.toThrow(
      'Invalid mail job payload',
    );
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('lets unexpected errors (e.g. database) propagate for a normal retry', async () => {
    const { processor, delivery } = setup(async () => {
      throw new Error('connection terminated');
    });
    await expect(processor.process(fakeJob())).rejects.toThrow('connection terminated');
    expect(delivery.recordFailure).not.toHaveBeenCalled();
  });
});
