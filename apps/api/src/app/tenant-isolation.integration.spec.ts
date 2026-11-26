import { loadEnv } from '@acra/configuration';
import { AuthStore, createPrismaClient, type PrismaClient } from '@acra/database';
import { SessionResponseSchema } from '@acra/shared-contracts';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { ApiConfigSchema } from './api-config';
import { AppModule } from './app.module';
import { hashPassword } from './auth/password';
import { APP_OPTIONS, configureApp } from './configure-app';

/** Routes that are intentionally reachable without a session. Anything else must answer 401. */
const PUBLIC_ROUTES = new Set([
  'GET /api/health/live',
  'GET /api/health/ready',
  'GET /api/metrics',
  'POST /api/webhooks/gitlab/:repositoryId',
  'POST /api/webhooks/github',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/setup-password',
  // Phase 9: self-service password reset (always 202, rate limited) and the features it depends on.
  'POST /api/v1/auth/password-reset',
  'GET /api/v1/auth/features',
]);

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

interface RouteInfo {
  readonly method: string;
  readonly path: string;
}

/** Every route registered on the Express router (Express 5: app.router.stack). */
function registeredRoutes(app: INestApplication): RouteInfo[] {
  const express = app.getHttpAdapter().getInstance() as {
    router?: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
  };
  const routes: RouteInfo[] = [];
  for (const layer of express.router?.stack ?? []) {
    if (!layer.route) continue;
    // Nest's own not-found handler (`/api{/*splat}`, all methods) only ever answers 404.
    if (layer.route.path.includes('{/*splat}')) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled && method !== '_all') routes.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return routes;
}

/** Replaces route parameters with random UUIDs. */
const concrete = (path: string, orgId: string) =>
  path.replace(':orgId', orgId).replace(/:[A-Za-z]+/g, () => randomUUID());

/**
 * Multi-tenant guarantees for every route the API exposes (Phase 8): deny by default, and an
 * organization's resources are invisible to members of other organizations, whatever the method.
 * New routes are covered automatically.
 */
describe('Tenant isolation across all routes (integration)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaClient;
  let routes: RouteInfo[];
  let cookie: string;
  let csrf: string;
  let ownOrgId: string;
  const password = 'tenant isolation passphrase';

  beforeAll(async () => {
    const config = loadEnv(ApiConfigSchema, { ...process.env, API_CORS_ORIGINS: 'http://localhost:4300' });
    app = await NestFactory.create(AppModule.forRoot(config), APP_OPTIONS);
    configureApp(app, config);
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    routes = registeredRoutes(app);
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL, poolMax: 2 });

    // An outsider: member (OWNER) of their own organization only.
    const email = `iso-${randomUUID().slice(0, 8)}@example.com`;
    const user = await new AuthStore(prisma).ensureUser(email, 'Outsider');
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
    const own = await prisma.organization.create({ data: { slug: `iso-${randomUUID().slice(0, 8)}`, name: 'Own' } });
    ownOrgId = own.id;
    await prisma.organizationMember.create({ data: { organizationId: own.id, userId: user.id, role: 'OWNER' } });

    const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    csrf = SessionResponseSchema.parse(await login.json()).csrfToken;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  it('discovers the dashboard routes (sanity check of the introspection)', () => {
    expect(routes.every((r) => HTTP_METHODS.has(r.method))).toBe(true);
    expect(routes.length).toBeGreaterThan(30);
    expect(routes).toContainEqual({ method: 'GET', path: '/api/v1/organizations/:orgId/findings' });
    for (const publicRoute of PUBLIC_ROUTES) {
      const [method, path] = publicRoute.split(' ');
      expect(routes).toContainEqual({ method, path });
    }
  });

  it('answers 401 on every non-public route without a session', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      if (PUBLIC_ROUTES.has(`${route.method} ${route.path}`)) continue;
      const response = await fetch(`${baseUrl}${concrete(route.path, randomUUID())}`, {
        method: route.method,
        headers: { 'content-type': 'application/json' },
        ...(route.method === 'GET' || route.method === 'HEAD' ? {} : { body: '{}' }),
      });
      if (response.status !== 401) failures.push(`${route.method} ${route.path} → ${response.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('answers 404 on every organization route of another organization, for every method', async () => {
    const foreign = await prisma.organization.create({
      data: { slug: `iso-f-${randomUUID().slice(0, 8)}`, name: 'Foreign' },
    });
    const failures: string[] = [];
    const orgRoutes = routes.filter((r) => r.path.includes(':orgId'));
    expect(orgRoutes.length).toBeGreaterThan(20);
    for (const route of orgRoutes) {
      for (const orgId of [foreign.id, randomUUID()]) {
        const response = await fetch(`${baseUrl}${concrete(route.path, orgId)}`, {
          method: route.method,
          headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
          ...(route.method === 'GET' ? {} : { body: '{}' }),
        });
        if (response.status !== 404)
          failures.push(
            `${route.method} ${route.path} (${orgId === foreign.id ? 'foreign' : 'unknown'}) → ${response.status}`,
          );
      }
    }
    expect(failures).toEqual([]);
  });

  it('still lets the same user reach their own organization (the 404s are not a blanket failure)', async () => {
    const response = await fetch(`${baseUrl}/api/v1/organizations/${ownOrgId}/findings`, { headers: { cookie } });
    expect(response.status).toBe(200);
  });
});
