import { type HeartbeatResult, HeartbeatJobSchema, QueueName, SystemJobName } from '@acra/queue';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';

/**
 * Consumes the `system` queue. Payloads are re-validated on the consumer side:
 * Redis content is treated as untrusted input, and malformed jobs fail permanently
 * (UnrecoverableError) instead of being retried.
 */
@Processor(QueueName.System, { concurrency: 1 })
export class SystemProcessor extends WorkerHost {
  private readonly logger = new Logger(SystemProcessor.name);

  async process(job: Job): Promise<HeartbeatResult> {
    switch (job.name) {
      case SystemJobName.Heartbeat:
        return this.heartbeat(job);
      default:
        throw new UnrecoverableError(`Unknown system job "${job.name.slice(0, 64)}"`);
    }
  }

  private async heartbeat(job: Job): Promise<HeartbeatResult> {
    const parsed = HeartbeatJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new UnrecoverableError('Invalid heartbeat payload');
    }
    const result: HeartbeatResult = {
      correlationId: parsed.data.correlationId,
      processedAt: new Date().toISOString(),
    };
    this.logger.log(
      { jobId: job.id, correlationId: result.correlationId, source: parsed.data.source },
      'Heartbeat processed',
    );
    return result;
  }
}
