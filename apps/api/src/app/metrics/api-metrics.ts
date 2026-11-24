import { HTTP_BUCKETS, MetricsRegistry } from '@acra/observability';
import { QueueName } from '@acra/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { type Queue } from 'bullmq';

const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed', 'completed'] as const;

/** Metrics of the API process: HTTP traffic and queue depth (sampled on each scrape). */
@Injectable()
export class ApiMetrics {
  readonly registry = new MetricsRegistry();
  readonly httpRequests = this.registry.counter('http_requests_total', 'HTTP requests handled by the API.', [
    'method',
    'route',
    'status',
  ]);
  readonly httpDuration = this.registry.histogram(
    'http_request_duration_seconds',
    'HTTP request duration in seconds.',
    ['method', 'route'],
    HTTP_BUCKETS,
  );
  private readonly queueJobs = this.registry.gauge('queue_jobs', 'BullMQ jobs per queue and state.', [
    'queue',
    'state',
  ]);

  constructor(
    @InjectQueue(QueueName.Reviews) reviews: Queue,
    @InjectQueue(QueueName.Approvals) approvals: Queue,
    @InjectQueue(QueueName.System) system: Queue,
  ) {
    this.registry.onCollect(async () => {
      for (const queue of [reviews, approvals, system]) {
        const counts = await queue.getJobCounts(...QUEUE_STATES);
        for (const state of QUEUE_STATES) this.queueJobs.set({ queue: queue.name, state }, counts[state] ?? 0);
      }
    });
  }

  /** Records one finished request. Routes are Express templates (e.g. /api/v1/organizations/:orgId), never raw URLs. */
  record(method: string, route: string, status: number, seconds: number): void {
    this.httpRequests.inc({ method, route, status: String(status) });
    this.httpDuration.observe({ method, route }, seconds);
  }
}
