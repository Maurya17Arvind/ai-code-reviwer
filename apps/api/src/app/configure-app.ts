import { type INestApplication } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { type ApiConfig } from './api-config';

export const GLOBAL_PREFIX = 'api';

/** NestFactory options shared by main.ts and tests: raw bodies are kept for webhook signatures. */
export const APP_OPTIONS = { bufferLogs: true, rawBody: true } as const;

/** HTTP hardening shared by main.ts and the integration tests, so tests exercise the real setup. */
export function configureApp(app: INestApplication, config: ApiConfig): void {
  app.useLogger(app.get(Logger));
  // Webhook payloads exceed the 100 kB default; cap at 2 MB (rawBody is kept for HMAC checks).
  (app as NestExpressApplication).useBodyParser('json', { limit: '2mb' });
  app.use(helmet());
  if (config.TRUST_PROXY_HOPS > 0) (app as NestExpressApplication).set('trust proxy', config.TRUST_PROXY_HOPS);
  // Tenant data must never be stored by browsers or shared caches.
  app.use(
    '/api/v1',
    (_request: unknown, response: { setHeader(name: string, value: string): void }, next: () => void) => {
      response.setHeader('Cache-Control', 'no-store');
      next();
    },
  );
  app.enableCors({
    origin: config.API_CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    maxAge: 600,
  });
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.enableShutdownHooks();
}
