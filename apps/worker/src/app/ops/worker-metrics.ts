import { MetricsRegistry, REVIEW_BUCKETS } from '@acra/observability';
import { Injectable } from '@nestjs/common';

/** Metrics of the worker process. Label values are fixed enums (outcomes, providers, error kinds). */
@Injectable()
export class WorkerMetrics {
  readonly registry = new MetricsRegistry();
  readonly reviews = this.registry.counter('reviews_total', 'Review jobs by outcome.', ['outcome']);
  readonly reviewDuration = this.registry.histogram(
    'review_duration_seconds',
    'Wall-clock duration of review jobs.',
    ['outcome'],
    REVIEW_BUCKETS,
  );
  readonly aiExecutions = this.registry.counter('ai_executions_total', 'AI reviewer runs.', [
    'provider',
    'status',
    'error_kind',
  ]);
  readonly approvals = this.registry.counter('approval_executions_total', 'Approved operations executed.', ['status']);
  /** outcome: sent | skipped | retry (transient failure, will retry) | failed (permanent or retries exhausted). */
  readonly mail = this.registry.counter('mail_messages_total', 'Transactional mail delivery attempts.', [
    'purpose',
    'outcome',
  ]);
  readonly maintenance = this.registry.counter('maintenance_actions_total', 'Records changed by maintenance.', [
    'action',
  ]);

  recordReview(outcome: string, seconds: number): void {
    this.reviews.inc({ outcome });
    this.reviewDuration.observe({ outcome }, seconds);
  }

  recordExecutions(
    executions: ReadonlyArray<{ provider: string; status: string; errorKind?: string | undefined }>,
  ): void {
    for (const e of executions) {
      this.aiExecutions.inc({ provider: e.provider, status: e.status, error_kind: e.errorKind ?? 'none' });
    }
  }
}
