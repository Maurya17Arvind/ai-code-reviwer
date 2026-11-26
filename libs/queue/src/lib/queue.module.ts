import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { type DynamicModule, Injectable, Module } from '@nestjs/common';
import { type Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import {
  ApprovalJobName,
  approvalJobId,
  type ExecuteApprovalJob,
  ExecuteApprovalJobSchema,
  type HeartbeatJob,
  HeartbeatJobSchema,
  MailJobName,
  QueueName,
  ReviewJobName,
  type ReviewMergeRequestJob,
  ReviewMergeRequestJobSchema,
  reviewJobId,
  type SendMailJob,
  SendMailJobSchema,
  SystemJobName,
} from './queues';
import { createRedisConnectionOptions } from './redis-connection';

/** Default retention: keep enough history to debug, without unbounded Redis growth. */
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** Enqueues jobs on the system queue. Payloads are validated before they reach Redis. */
@Injectable()
export class SystemQueueProducer {
  constructor(@InjectQueue(QueueName.System) private readonly queue: Queue) {}

  async enqueueHeartbeat(source: HeartbeatJob['source']): Promise<HeartbeatJob> {
    const payload = HeartbeatJobSchema.parse({
      correlationId: randomUUID(),
      requestedAt: new Date().toISOString(),
      source,
    });
    // jobId = correlationId makes enqueueing idempotent: re-adding the same id is a no-op.
    await this.queue.add(SystemJobName.Heartbeat, payload, { jobId: payload.correlationId });
    return payload;
  }
}

/** Enqueues review jobs. The job id makes enqueueing idempotent per (repository, MR, head SHA). */
@Injectable()
export class ReviewQueueProducer {
  constructor(@InjectQueue(QueueName.Reviews) private readonly queue: Queue) {}

  async enqueueMergeRequestReview(input: ReviewMergeRequestJob): Promise<{ jobId: string }> {
    const payload = ReviewMergeRequestJobSchema.parse(input);
    const jobId = reviewJobId(payload);
    await this.queue.add(ReviewJobName.MergeRequest, payload, {
      jobId,
      attempts: 3,
      // Reviews are long-running and providers recover slowly: back off generously.
      backoff: { type: 'exponential', delay: 30_000 },
    });
    return { jobId };
  }
}

/**
 * Enqueues execution of an approved operation. No automatic retries: a failed write is recorded as
 * FAILED and needs a new approval, so an operation can never run twice.
 */
@Injectable()
export class ApprovalQueueProducer {
  constructor(@InjectQueue(QueueName.Approvals) private readonly queue: Queue) {}

  async enqueueExecution(input: ExecuteApprovalJob): Promise<{ jobId: string }> {
    return enqueueApprovalExecution(this.queue, input);
  }
}

/** Shared with the admin CLI, which talks to BullMQ without Nest. */
export async function enqueueApprovalExecution(queue: Queue, input: ExecuteApprovalJob): Promise<{ jobId: string }> {
  const payload = ExecuteApprovalJobSchema.parse(input);
  const jobId = approvalJobId(payload.approvalId);
  await queue.add(ApprovalJobName.Execute, payload, { jobId, attempts: 1 });
  return { jobId };
}

/**
 * Enqueues transactional mail (ADR-040). Payloads hold ids only and are validated strictly before they
 * reach Redis. Retried with backoff for transient SMTP failures: about 15 minutes in total, after which
 * a reset or verification link would be stale anyway.
 */
@Injectable()
export class MailQueueProducer {
  constructor(@InjectQueue(QueueName.Mail) private readonly queue: Queue) {}

  async enqueue(input: SendMailJob): Promise<{ jobId: string }> {
    const payload = SendMailJobSchema.parse(input);
    const jobId = `mail_${payload.correlationId}`;
    await this.queue.add(MailJobName.Send, payload, {
      jobId,
      attempts: 6,
      backoff: { type: 'exponential', delay: 15_000 },
    });
    return { jobId };
  }
}

/** Redis connectivity probe used by readiness checks. */
@Injectable()
export class QueueHealth {
  constructor(@InjectQueue(QueueName.System) private readonly queue: Queue) {}

  /**
   * Round-trips over the same connection BullMQ uses. BullMQ 6 abstracts the Redis client
   * (IRedisClient) and does not expose PING, so INFO is used as the probe.
   */
  async ping(): Promise<void> {
    const client = await this.queue.backend.client;
    const info = await client.info();
    if (!info.includes('redis_version')) {
      throw new Error('Unexpected Redis INFO reply');
    }
  }
}

export interface QueueModuleOptions {
  readonly redisUrl: string;
  /** `worker` processes jobs (blocking connections); `producer` only enqueues. */
  readonly role: 'producer' | 'worker';
}

@Module({})
export class QueueModule {
  static forRoot(options: QueueModuleOptions): DynamicModule {
    return {
      module: QueueModule,
      global: true,
      imports: [
        BullModule.forRoot({
          connection: createRedisConnectionOptions(options.redisUrl, options.role),
          defaultJobOptions: DEFAULT_JOB_OPTIONS,
        }),
        BullModule.registerQueue(
          { name: QueueName.System },
          { name: QueueName.Reviews },
          { name: QueueName.Approvals },
          { name: QueueName.Mail },
        ),
      ],
      providers: [SystemQueueProducer, ReviewQueueProducer, ApprovalQueueProducer, MailQueueProducer, QueueHealth],
      exports: [
        BullModule,
        SystemQueueProducer,
        ReviewQueueProducer,
        ApprovalQueueProducer,
        MailQueueProducer,
        QueueHealth,
      ],
    };
  }
}
