import { MailDeliveryError } from '@acra/mail';
import { MailJobName, QueueName, SendMailJobSchema } from '@acra/queue';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { WorkerMetrics } from '../ops/worker-metrics';
import { MailDeliveryService, type MailOutcome } from './mail-delivery.service';

/**
 * Consumes the `mail` queue (ADR-040). Transient SMTP failures are rethrown so BullMQ retries them with
 * backoff; a permanent rejection stops at once. The final outcome is audited either way.
 */
@Processor(QueueName.Mail, { concurrency: 4 })
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(
    @Inject(MailDeliveryService) private readonly delivery: MailDeliveryService,
    @Inject(WorkerMetrics) private readonly metrics: WorkerMetrics,
  ) {
    super();
  }

  async process(job: Job): Promise<MailOutcome> {
    if (job.name !== MailJobName.Send) throw new UnrecoverableError(`Unknown mail job "${job.name.slice(0, 64)}"`);
    const parsed = SendMailJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('Invalid mail job payload');
    const payload = parsed.data;

    try {
      const outcome = await this.delivery.deliver(payload);
      this.metrics.mail.inc({ purpose: payload.purpose, outcome: outcome.status });
      return outcome;
    } catch (error) {
      if (!(error instanceof MailDeliveryError)) throw error;
      const final = error.permanent || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      this.metrics.mail.inc({ purpose: payload.purpose, outcome: final ? 'failed' : 'retry' });
      this.logger.warn(
        { jobId: job.id, purpose: payload.purpose, attempt: job.attemptsMade + 1, final, reason: error.message },
        'Mail delivery failed',
      );
      if (final) await this.delivery.recordFailure(payload, error);
      if (error.permanent) throw new UnrecoverableError(error.message);
      throw error;
    }
  }
}
