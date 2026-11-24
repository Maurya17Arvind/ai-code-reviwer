import { MaintenanceStore, type MaintenanceResult } from '@acra/database';
import { type HeartbeatResult, HeartbeatJobSchema, QueueName, SystemJobName } from '@acra/queue';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { WorkerMetrics } from './ops/worker-metrics';
import { WORKER_CONFIG, type WorkerConfig } from './worker-config';

/** Sessions and setup links are deleted this long after they expired or were used. */
const RETENTION_MS = 7 * 86_400_000;

/**
 * Consumes the `system` queue. Payloads are re-validated on the consumer side:
 * Redis content is treated as untrusted input, and malformed jobs fail permanently
 * (UnrecoverableError) instead of being retried.
 */
@Processor(QueueName.System, { concurrency: 1 })
export class SystemProcessor extends WorkerHost {
  private readonly logger = new Logger(SystemProcessor.name);

  constructor(
    @Inject(MaintenanceStore) private readonly maintenanceStore: MaintenanceStore,
    @Inject(WorkerMetrics) private readonly metrics: WorkerMetrics,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {
    super();
  }

  async process(job: Job): Promise<HeartbeatResult | MaintenanceResult> {
    switch (job.name) {
      case SystemJobName.Heartbeat:
        return this.heartbeat(job);
      case SystemJobName.Maintenance:
        return this.maintenance();
      default:
        throw new UnrecoverableError(`Unknown system job "${job.name.slice(0, 64)}"`);
    }
  }

  /** Recovers stuck reviews (no update for 2× the AI timeout, at least 30 min) and expires approvals. */
  async maintenance(now = new Date()): Promise<MaintenanceResult> {
    const result = await this.maintenanceStore.run({
      now,
      stuckAfterMs: Math.max(30 * 60_000, 2 * this.config.AI_REVIEW_TIMEOUT_MS),
      retentionMs: RETENTION_MS,
    });
    for (const [action, count] of Object.entries(result))
      if (count > 0) this.metrics.maintenance.inc({ action }, count);
    if (result.stuckReviewsFailed + result.approvalsExpired > 0)
      this.logger.warn(result, 'Maintenance recovered records');
    return result;
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
