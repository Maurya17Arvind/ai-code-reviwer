import { type INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { type ApiConfig } from './api-config';

export const GLOBAL_PREFIX = 'api';

/** HTTP hardening shared by main.ts and the integration tests, so tests exercise the real setup. */
export function configureApp(app: INestApplication, config: ApiConfig): void {
  app.useLogger(app.get(Logger));
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
