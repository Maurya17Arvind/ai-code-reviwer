import { createLoggerOptions, type WorkerEnv } from '@acra/configuration';
import { QueueModule } from '@acra/queue';
import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { SystemProcessor } from './system.processor';

/**
 * Background job processor. Runs as a Nest application context (no HTTP server).
 * The database connection is added in the phase that introduces the first DB-backed job.
 */
@Module({})
export class WorkerModule {
  static forRoot(config: WorkerEnv): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: createLoggerOptions({ service: 'worker', level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV }),
        }),
        QueueModule.forRoot({ redisUrl: config.REDIS_URL, role: 'worker' }),
      ],
      providers: [SystemProcessor],
    };
  }
}
