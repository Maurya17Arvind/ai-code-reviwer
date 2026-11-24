import { ApprovalJobName, QueueName } from '@acra/queue';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { WorkerMetrics } from '../ops/worker-metrics';
import { ApprovalExecutionService, type ExecutionOutcome } from './approval-execution.service';

/**
 * Consumes the `approvals` queue. One job at a time per worker: approved writes are rare, and
 * serial execution keeps provider-side effects easy to reason about. Jobs are never retried
 * automatically — a failed write needs a new human approval.
 */
@Processor(QueueName.Approvals, { concurrency: 1 })
export class ApprovalProcessor extends WorkerHost {
  private readonly logger = new Logger(ApprovalProcessor.name);

  constructor(
    @Inject(ApprovalExecutionService) private readonly executor: ApprovalExecutionService,
    @Inject(WorkerMetrics) private readonly metrics: WorkerMetrics,
  ) {
    super();
  }

  async process(job: Job): Promise<ExecutionOutcome> {
    if (job.name !== ApprovalJobName.Execute)
      throw new UnrecoverableError(`Unknown approval job "${job.name.slice(0, 64)}"`);
    const outcome = await this.executor.run(job.data);
    this.metrics.approvals.inc({ status: outcome.status });
    this.logger.log({ jobId: job.id, outcome: outcome.status }, 'Approval job finished');
    return outcome;
  }
}
