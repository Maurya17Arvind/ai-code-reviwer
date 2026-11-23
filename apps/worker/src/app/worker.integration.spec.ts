import { loadEnv, WorkerEnvSchema } from '@acra/configuration';
import { createRedisConnectionOptions, HeartbeatResultSchema, QueueName, SystemQueueProducer } from '@acra/queue';
import { type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue, QueueEvents } from 'bullmq';
import { WorkerModule } from './worker.module';

/**
 * End-to-end queue wiring against real Redis:
 * SystemQueueProducer (the producer the API uses) → Redis → SystemProcessor in the worker.
 */
describe('worker (integration)', () => {
  let worker: INestApplicationContext;
  let queueEvents: QueueEvents;
  let inspectionQueue: Queue;

  beforeAll(async () => {
    const config = loadEnv(WorkerEnvSchema);
    worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { bufferLogs: true });
    await worker.init();
    const connection = createRedisConnectionOptions(config.REDIS_URL, 'worker');
    queueEvents = new QueueEvents(QueueName.System, { connection });
    inspectionQueue = new Queue(QueueName.System, { connection });
    await Promise.all([queueEvents.waitUntilReady(), inspectionQueue.waitUntilReady()]);
  });

  afterAll(async () => {
    await queueEvents.close();
    await inspectionQueue.close();
    await worker.close();
  });

  it('processes a heartbeat enqueued by the producer', async () => {
    const producer = worker.get(SystemQueueProducer);
    const payload = await producer.enqueueHeartbeat('test');

    const job = await inspectionQueue.getJob(payload.correlationId);
    expect(job).toBeDefined();
    const result = HeartbeatResultSchema.parse(await job?.waitUntilFinished(queueEvents, 10_000));
    expect(result.correlationId).toBe(payload.correlationId);
  });

  it('enqueueing is idempotent per correlation id', async () => {
    const producer = worker.get(SystemQueueProducer);
    const payload = await producer.enqueueHeartbeat('test');
    // Re-adding a job with the same id must not create a second job.
    await inspectionQueue.add('heartbeat', payload, { jobId: payload.correlationId });
    const job = await inspectionQueue.getJob(payload.correlationId);
    await job?.waitUntilFinished(queueEvents, 10_000);
    const counts = await inspectionQueue.getJobCounts('waiting', 'active', 'delayed');
    expect(counts['waiting'] ?? 0).toBe(0);
  });
});
