import { createReviewers } from '@acra/ai-providers-factory';
import { createLoggerOptions } from '@acra/configuration';
import { DatabaseModule } from '@acra/database';
import { QueueModule } from '@acra/queue';
import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { HostedProviderFactory } from './reviews/hosted-provider.factory';
import { MergeRequestReviewService } from './reviews/merge-request-review.service';
import { ReviewProcessor } from './reviews/review.processor';
import { SystemProcessor } from './system.processor';
import { REVIEWER_FACTORY, WORKER_CONFIG, type WorkerConfig } from './worker-config';

/** Background job processor. Runs as a Nest application context (no HTTP server). */
@Module({})
export class WorkerModule {
  static forRoot(config: WorkerConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: createLoggerOptions({ service: 'worker', level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV }),
        }),
        DatabaseModule.forRoot({ databaseUrl: config.DATABASE_URL }),
        QueueModule.forRoot({ redisUrl: config.REDIS_URL, role: 'worker' }),
      ],
      providers: [
        { provide: WORKER_CONFIG, useValue: config },
        { provide: REVIEWER_FACTORY, useValue: createReviewers },
        SystemProcessor,
        HostedProviderFactory,
        MergeRequestReviewService,
        ReviewProcessor,
      ],
    };
  }
}
