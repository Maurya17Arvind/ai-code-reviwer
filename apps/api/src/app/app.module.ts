import { createLoggerOptions } from '@acra/configuration';
import { DatabaseModule } from '@acra/database';
import { QueueModule } from '@acra/queue';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { LoggerModule } from 'nestjs-pino';
import { type ApiConfig, API_CONFIG } from './api-config';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { HealthController } from './health/health.controller';
import { HEALTH_PROBE_TIMEOUT_MS, HealthService } from './health/health.service';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Accepts a well-formed upstream X-Request-Id, otherwise generates one; echoes it back. */
function requestId(request: IncomingMessage, response: ServerResponse): string {
  const header = request.headers['x-request-id'];
  const id = typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
  response.setHeader('X-Request-Id', id);
  return id;
}

@Module({})
export class AppModule {
  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            ...createLoggerOptions({ service: 'api', level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV }),
            genReqId: requestId,
            autoLogging: { ignore: (request) => request.url?.startsWith('/api/health') ?? false },
          },
        }),
        DatabaseModule.forRoot({ databaseUrl: config.DATABASE_URL }),
        QueueModule.forRoot({ redisUrl: config.REDIS_URL, role: 'producer' }),
      ],
      controllers: [HealthController],
      providers: [
        { provide: API_CONFIG, useValue: config },
        { provide: HEALTH_PROBE_TIMEOUT_MS, useValue: 2_000 },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        HealthService,
      ],
    };
  }
}
