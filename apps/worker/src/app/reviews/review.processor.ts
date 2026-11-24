import { QueueName, ReviewJobName } from '@acra/queue';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { WorkerMetrics } from '../ops/worker-metrics';
import { isRetryable, MergeRequestReviewService, type ReviewOutcome } from './merge-request-review.service';

/**
 * Consumes the `reviews` queue. Reviews are long-running (minutes); BullMQ keeps renewing the
 * job lock while the event loop is free. Non-retryable failures become UnrecoverableError so
 * BullMQ does not burn retries (and AI spend) on them.
 */
@Processor(QueueName.Reviews, { concurrency: 2 })
export class ReviewProcessor extends WorkerHost {
  private readonly logger = new Logger(ReviewProcessor.name);

  constructor(
    @Inject(MergeRequestReviewService) private readonly reviews: MergeRequestReviewService,
    @Inject(WorkerMetrics) private readonly metrics: WorkerMetrics,
  ) {
    super();
  }

  async process(job: Job): Promise<ReviewOutcome> {
    if (job.name !== ReviewJobName.MergeRequest)
      throw new UnrecoverableError(`Unknown review job "${job.name.slice(0, 64)}"`);
    const started = performance.now();
    try {
      const outcome = await this.reviews.run(job.data);
      this.metrics.recordReview(outcome.status, (performance.now() - started) / 1000);
      this.logger.log({ jobId: job.id, outcome }, 'Review job finished');
      return outcome;
    } catch (error) {
      this.metrics.recordReview('error', (performance.now() - started) / 1000);
      this.logger.error({ jobId: job.id, err: error, attempt: job.attemptsMade + 1 }, 'Review job failed');
      if (!isRetryable(error)) throw new UnrecoverableError(error instanceof Error ? error.message : 'Review failed');
      throw error;
    }
  }
}
