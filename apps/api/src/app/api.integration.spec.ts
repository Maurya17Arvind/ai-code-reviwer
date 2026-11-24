import { loadEnv } from '@acra/configuration';
import { ApiConfigSchema } from './api-config';
import { ApiErrorSchema, LivenessResponseSchema, ReadinessResponseSchema } from '@acra/shared-contracts';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_OPTIONS, configureApp } from './configure-app';

/** Boots the real API against local PostgreSQL + Redis and exercises it over HTTP. */
describe('API (integration)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const config = loadEnv(ApiConfigSchema, { ...process.env, API_CORS_ORIGINS: 'http://localhost:4300' });
    app = await NestFactory.create(AppModule.forRoot(config), APP_OPTIONS);
    configureApp(app, config);
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health/live → 200', async () => {
    const response = await fetch(`${baseUrl}/api/health/live`);
    expect(response.status).toBe(200);
    expect(LivenessResponseSchema.parse(await response.json()).status).toBe('ok');
  });

  it('GET /api/health/ready → 200 with database and redis up', async () => {
    const response = await fetch(`${baseUrl}/api/health/ready`);
    const body = ReadinessResponseSchema.parse(await response.json());
    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual([
      expect.objectContaining({ name: 'database', status: 'up' }),
      expect.objectContaining({ name: 'redis', status: 'up' }),
    ]);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('applies security headers and request ids', async () => {
    const response = await fetch(`${baseUrl}/api/health/live`, { headers: { 'X-Request-Id': 'trace-abc-12345' } });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('x-request-id')).toBe('trace-abc-12345');
  });

  it('replaces malformed request ids', async () => {
    const response = await fetch(`${baseUrl}/api/health/live`, { headers: { 'X-Request-Id': '<script>' } });
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the ApiError envelope for unknown routes', async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(response.status).toBe(404);
    const body = ApiErrorSchema.parse(await response.json());
    expect(body.requestId).toBe(response.headers.get('x-request-id'));
  });

  it('allows CORS only for configured origins', async () => {
    const allowed = await fetch(`${baseUrl}/api/health/live`, { headers: { Origin: 'http://localhost:4300' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:4300');
    const denied = await fetch(`${baseUrl}/api/health/live`, { headers: { Origin: 'https://evil.example' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});
