import { type INestApplication } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { type ApiConfig } from './api-config';

export const GLOBAL_PREFIX = 'api';

/** HTTP hardening shared by main.ts and the integration tests, so tests exercise the real setup. */
export function configureApp(app: INestApplication, config: ApiConfig): void {
  app.useLogger(app.get(Logger));
  // GitLab MR webhook payloads exceed the 100 kB default; cap at 2 MB.
  (app as NestExpressApplication).useBodyParser('json', { limit: '2mb' });
  app.use(helmet());
  app.enableCors({
    origin: config.API_CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    maxAge: 600,
  });
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.enableShutdownHooks();
}
