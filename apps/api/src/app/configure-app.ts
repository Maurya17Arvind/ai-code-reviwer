import { type INestApplication } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { type Request, type Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { type ApiConfig } from './api-config';
import { ApiMetrics } from './metrics/api-metrics';

export const GLOBAL_PREFIX = 'api';

/** NestFactory options shared by main.ts and tests: raw bodies are kept for webhook signatures. */
// bodyParser: false + useBodyParser('json') below: only JSON bodies are parsed. A cross-site HTML form
// (urlencoded or multipart) can therefore never reach the sign-in endpoint (login CSRF).
export const APP_OPTIONS = { bufferLogs: true, rawBody: true, bodyParser: false } as const;

/** HTTP hardening shared by main.ts and the integration tests, so tests exercise the real setup. */
export function configureApp(app: INestApplication, config: ApiConfig): void {
  app.useLogger(app.get(Logger));
  // Webhook payloads exceed the 100 kB default; cap at 2 MB (rawBody is kept for HMAC checks).
  (app as NestExpressApplication).useBodyParser('json', { limit: '2mb' });
  app.use(helmet());
  // Request metrics by route template (bounded label values), recorded when the response finishes.
  const metrics = app.get(ApiMetrics);
  app.use((request: Request, response: Response, next: () => void) => {
    const started = process.hrtime.bigint();
    response.on('finish', () => {
      const routePath = (request as Request & { route?: { path?: unknown } }).route?.path;
      const route = typeof routePath === 'string' ? `${request.baseUrl}${routePath}` : 'unmatched';
      metrics.record(request.method, route, response.statusCode, Number(process.hrtime.bigint() - started) / 1e9);
    });
    next();
  });
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
