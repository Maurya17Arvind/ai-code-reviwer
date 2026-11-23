import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { type DynamicModule, Injectable, Module } from '@nestjs/common';
import { type Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { type HeartbeatJob, HeartbeatJobSchema, QueueName, SystemJobName } from './queues';
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
        BullModule.registerQueue({ name: QueueName.System }),
      ],
      providers: [SystemQueueProducer, QueueHealth],
      exports: [BullModule, SystemQueueProducer, QueueHealth],
    };
  }
}
