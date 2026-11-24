import { createLoggerOptions } from '@acra/configuration';
import { DatabaseModule } from '@acra/database';
import { QueueModule } from '@acra/queue';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { LoggerModule } from 'nestjs-pino';
import { type ApiConfig, API_CONFIG } from './api-config';
import { ApprovalsController } from './approvals/approvals.controller';
import { ApprovalsService } from './approvals/approvals.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { OrganizationGuard, SessionGuard } from './auth/guards';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { HealthController } from './health/health.controller';
import { HEALTH_PROBE_TIMEOUT_MS, HealthService } from './health/health.service';
import { GitHubWebhookController } from './webhooks/github-webhook.controller';
import { GitHubWebhookService } from './webhooks/github-webhook.service';
import { GitLabWebhookController } from './webhooks/gitlab-webhook.controller';
import { GitLabWebhookService } from './webhooks/gitlab-webhook.service';
import { InsightsController } from './insights/insights.controller';
import { OrganizationController, OrganizationsController } from './organizations/organizations.controller';
import { OrganizationsService } from './organizations/organizations.service';
import { RepositoriesController } from './repositories/repositories.controller';
import { RepositoriesService } from './repositories/repositories.service';
import { ReviewsController } from './reviews/reviews.controller';
import { ReviewsService } from './reviews/reviews.service';

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
      controllers: [
        HealthController,
        GitLabWebhookController,
        GitHubWebhookController,
        AuthController,
        OrganizationsController,
        OrganizationController,
        RepositoriesController,
        ReviewsController,
        ApprovalsController,
        InsightsController,
      ],
      providers: [
        { provide: API_CONFIG, useValue: config },
        { provide: HEALTH_PROBE_TIMEOUT_MS, useValue: 2_000 },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        // Deny by default: every route needs a session unless it is marked @Public() (ADR-035).
        { provide: APP_GUARD, useClass: SessionGuard },
        OrganizationGuard,
        AuthService,
        OrganizationsService,
        RepositoriesService,
        ReviewsService,
        ApprovalsService,
        HealthService,
        GitLabWebhookService,
        GitHubWebhookService,
      ],
    };
  }
}
