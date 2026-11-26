import { createReviewers } from '@acra/ai-providers-factory';
import { createLoggerOptions } from '@acra/configuration';
import { DatabaseModule } from '@acra/database';
import { SmtpMailer } from '@acra/mail';
import { QueueModule } from '@acra/queue';
import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ApprovalExecutionService } from './approvals/approval-execution.service';
import { ApprovalProcessor } from './approvals/approval.processor';
import { MailDeliveryService } from './mail/mail-delivery.service';
import { MailProcessor } from './mail/mail.processor';
import { MaintenanceScheduler } from './ops/maintenance.scheduler';
import { WorkerHttpServer } from './ops/worker-http.server';
import { WorkerMetrics } from './ops/worker-metrics';
import { HostedProviderFactory } from './reviews/hosted-provider.factory';
import { MergeRequestReviewService } from './reviews/merge-request-review.service';
import { ReviewProcessor } from './reviews/review.processor';
import { SystemProcessor } from './system.processor';
import {
  MAIL_SETTINGS,
  MAILER,
  resolveWorkerMail,
  REVIEWER_FACTORY,
  WORKER_CONFIG,
  type WorkerConfig,
} from './worker-config';

/** Background job processor. Runs as a Nest application context (no HTTP server). */
@Module({})
export class WorkerModule {
  static forRoot(config: WorkerConfig): DynamicModule {
    // Validated here so a partial mail configuration stops the worker at startup (ADR-040).
    const mail = resolveWorkerMail(config);
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
        { provide: MAIL_SETTINGS, useValue: mail },
        {
          provide: MAILER,
          useFactory: () =>
            mail
              ? new SmtpMailer({
                  url: mail.smtpUrl,
                  from: mail.from,
                  ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
                  requireTls: mail.requireTls,
                })
              : null,
        },
        SystemProcessor,
        HostedProviderFactory,
        MergeRequestReviewService,
        ReviewProcessor,
        ApprovalExecutionService,
        ApprovalProcessor,
        MailDeliveryService,
        MailProcessor,
        WorkerMetrics,
        WorkerHttpServer,
        MaintenanceScheduler,
      ],
    };
  }
}
