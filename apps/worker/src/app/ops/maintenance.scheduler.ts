import { QueueName, SystemJobName } from '@acra/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Queue } from 'bullmq';
import { WORKER_CONFIG, type WorkerConfig } from '../worker-config';

/**
 * Registers the repeating maintenance job (idempotent: one scheduler id shared by all workers, so
 * several worker instances do not multiply the runs).
 */
@Injectable()
export class MaintenanceScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceScheduler.name);

  constructor(
    @InjectQueue(QueueName.System) private readonly queue: Queue,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'maintenance',
      { every: this.config.MAINTENANCE_INTERVAL_MS },
      { name: SystemJobName.Maintenance, data: {}, opts: { removeOnComplete: 50, removeOnFail: 50 } },
    );
    this.logger.log({ everyMs: this.config.MAINTENANCE_INTERVAL_MS }, 'Maintenance job scheduled');
  }
}
