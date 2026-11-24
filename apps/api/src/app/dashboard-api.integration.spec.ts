import { loadEnv } from '@acra/configuration';
import { ApprovalStore, AuthStore, createPrismaClient, type PrismaClient } from '@acra/database';
import { generateMasterKey } from '@acra/security';
import {
  AddMemberResponseSchema,
  AnalyticsResponseSchema,
  ApiErrorSchema,
  ApprovalDetailSchema,
  AuditLogEntrySchema,
  ConnectGitLabResponseSchema,
  FindingDetailSchema,
  FindingSummarySchema,
  FixDetailSchema,
  MemberSchema,
  OrganizationSchema,
  OrganizationSettingsSchema,
  pageOf,
  RepositorySchema,
  ReviewDetailSchema,
  ReviewSummarySchema,
  SessionResponseSchema,
  UsageResponseSchema,
} from '@acra/shared-contracts';
import { FakeGitLab } from '@acra/testing';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/mini';
import { ApiConfigSchema } from './api-config';
import { AppModule } from './app.module';
import { hashPassword } from './auth/password';
import { APP_OPTIONS, configureApp } from './configure-app';

const PASSWORD = 'correct horse battery staple';
const HEAD = '5'.repeat(40);
const PATCH = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A browser-like client: keeps the session cookie and sends the CSRF token on writes. */
class Client {
  cookie: string | null = null;
  csrf: string | null = null;

  constructor(private readonly baseUrl: string) {}

  async request(method: string, path: string, body?: unknown, options: { csrf?: boolean } = {}) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers['cookie'] = this.cookie;
    if (this.csrf && options.csrf !== false && method !== 'GET') headers['x-csrf-token'] = this.csrf;
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const value = setCookie.split(';')[0] ?? '';
      this.cookie = value.endsWith('=') ? null : value;
    }
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as unknown) : null };
  }

  async login(email: string, password = PASSWORD) {
    const result = await this.request('POST', '/auth/login', { email, password });
    if (result.status === 200) this.csrf = SessionResponseSchema.parse(result.body).csrfToken;
    return result;
  }
}

describe('Dashboard API (integration: PostgreSQL + Redis)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaClient;
  let gitlab: FakeGitLab;
  const run = randomUUID().slice(0, 8);
  const ownerEmail = `owner-${run}@example.com`;
  const outsiderEmail = `outsider-${run}@example.com`;
  let owner: Client;
  let orgId: string;

  async function createUser(email: string, name: string) {
    const user = await new AuthStore(prisma).ensureUser(email, name);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
    return user.id;
  }

  beforeAll(async () => {
    gitlab = await new FakeGitLab().start();
    const config = loadEnv(ApiConfigSchema, {
      ...process.env,
      API_CORS_ORIGINS: 'http://localhost:4300',
      DASHBOARD_PUBLIC_URL: 'https://dashboard.example',
      CREDENTIALS_MASTER_KEY: generateMasterKey(),
      GITLAB_ALLOWED_HOSTS: '127.0.0.1',
      GITLAB_ALLOW_PRIVATE_NETWORK: 'true',
    });
    app = await NestFactory.create(AppModule.forRoot(config), APP_OPTIONS);
    configureApp(app, config);
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL, poolMax: 2 });
    await createUser(ownerEmail, 'Owner');
    await createUser(outsiderEmail, 'Outsider');
    owner = new Client(baseUrl);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
    await gitlab?.stop();
  });

  describe('authentication', () => {
    it('denies every dashboard route without a session (deny by default)', async () => {
      const anonymous = new Client(baseUrl);
      for (const path of [
        '/auth/session',
        `/organizations/${randomUUID()}`,
        `/organizations/${randomUUID()}/findings`,
      ]) {
        const result = await anonymous.request('GET', path);
        expect(result.status).toBe(401);
        expect(ApiErrorSchema.parse(result.body).message).toBe('Sign in to continue');
      }
    });

    it('gives the same answer for an unknown e-mail and a wrong password', async () => {
      const unknown = await new Client(baseUrl).login(`nobody-${run}@example.com`);
      const wrong = await new Client(baseUrl).login(ownerEmail, 'not the password at all');
      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(ApiErrorSchema.parse(unknown.body).message).toBe(ApiErrorSchema.parse(wrong.body).message);
    });

    it('signs in with an HttpOnly SameSite=Strict cookie and returns a CSRF token', async () => {
      const result = await owner.login(ownerEmail.toUpperCase());
      expect(result.status).toBe(200);
      const cookie = result.headers.get('set-cookie') ?? '';
      expect(cookie).toMatch(/^acra_session=[A-Za-z0-9_-]{43};/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(result.headers.get('cache-control')).toBe('no-store');
      const session = SessionResponseSchema.parse(result.body);
      expect(session.user.email).toBe(ownerEmail);
      expect(session.memberships).toEqual([]);
      // The session token itself never appears in the body.
      expect(JSON.stringify(result.body)).not.toContain(owner.cookie?.split('=')[1]);
    });

    it('rejects writes without the CSRF token', async () => {
      const result = await owner.request('POST', '/organizations', { name: 'X', slug: `x-${run}` }, { csrf: false });
      expect(result.status).toBe(403);
      expect(ApiErrorSchema.parse(result.body).message).toMatch(/CSRF/);
    });

    it('throttles repeated attempts on one account from one client, and audits failures', async () => {
      const email = `throttled-${run}@example.com`;
      await createUser(email, 'Throttled');
      for (let i = 0; i < 5; i++) expect((await new Client(baseUrl).login(email, 'wrong password!!')).status).toBe(401);
      const sixth = await new Client(baseUrl).login(email);
      expect(sixth.status).toBe(429);
      const audit = await prisma.auditLog.findMany({ where: { action: 'auth.login_failed', actorUser: { email } } });
      expect(audit).toHaveLength(5);
      // No account-wide lock is stored (it would let anyone lock a victim out).
      expect((await prisma.user.findFirstOrThrow({ where: { email } })).lockedUntil).toBeNull();
    });

    it('accepts JSON only, so a cross-site form cannot sign anyone in (login CSRF)', async () => {
      const form = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: ownerEmail, password: PASSWORD }).toString(),
      });
      expect(form.status).toBe(400);
      expect(form.headers.get('set-cookie')).toBeNull();
    });

    it('logout revokes the session server-side', async () => {
      const client = new Client(baseUrl);
      await client.login(outsiderEmail);
      const stolenCookie = client.cookie;
      expect((await client.request('POST', '/auth/logout')).status).toBe(204);
      client.cookie = stolenCookie; // replaying the old cookie must not work
      expect((await client.request('GET', '/auth/session')).status).toBe(401);
    });
  });

  describe('organizations and members', () => {
    let memberClient: Client;
    let memberId: string;

    it('creates an organization with the creator as OWNER', async () => {
      const result = await owner.request('POST', '/organizations', { name: 'Acme Dashboard', slug: `acme-${run}` });
      expect(result.status).toBe(201);
      const org = OrganizationSchema.parse(result.body);
      expect(org.role).toBe('OWNER');
      orgId = org.id;
      const duplicate = await owner.request('POST', '/organizations', { name: 'Again', slug: `acme-${run}` });
      expect(duplicate.status).toBe(409);
      const session = SessionResponseSchema.parse((await owner.request('GET', '/auth/session')).body);
      expect(session.memberships).toEqual([expect.objectContaining({ organizationId: orgId, role: 'OWNER' })]);
    });

    it('hides organizations from non-members (404, not 403)', async () => {
      const outsider = new Client(baseUrl);
      await outsider.login(outsiderEmail);
      expect((await outsider.request('GET', `/organizations/${orgId}`)).status).toBe(404);
      expect((await outsider.request('GET', `/organizations/${orgId}/members`)).status).toBe(404);
      expect((await outsider.request('PUT', `/organizations/${orgId}/settings`, {})).status).toBe(404);
    });

    it('invites a member with a single-use setup link', async () => {
      const email = `member-${run}@example.com`;
      const result = await owner.request('POST', `/organizations/${orgId}/members`, {
        email,
        displayName: 'New Member',
        role: 'MEMBER',
      });
      expect(result.status).toBe(201);
      const { member, setupLink } = AddMemberResponseSchema.parse(result.body);
      memberId = member.id;
      expect(member.hasPassword).toBe(false);
      expect(setupLink?.setupUrl).toMatch(/^https:\/\/dashboard\.example\/setup-password#token=[A-Za-z0-9_-]{43}$/);
      const token = setupLink?.setupUrl.split('#token=')[1] ?? '';

      const anonymous = new Client(baseUrl);
      expect((await anonymous.request('POST', '/auth/setup-password', { token, password: 'short' })).status).toBe(400);
      expect((await anonymous.request('POST', '/auth/setup-password', { token, password: PASSWORD })).status).toBe(204);
      expect((await anonymous.request('POST', '/auth/setup-password', { token, password: PASSWORD })).status).toBe(401);

      memberClient = new Client(baseUrl);
      expect((await memberClient.login(email)).status).toBe(200);
      const duplicate = await owner.request('POST', `/organizations/${orgId}/members`, {
        email,
        displayName: 'Again',
        role: 'VIEWER',
      });
      expect(duplicate.status).toBe(409);
    });

    it('never lets an organization admin take over an existing account (setup/reset links)', async () => {
      // An attacker with their own organization adds the owner's e-mail and asks for a link.
      const attacker = new Client(baseUrl);
      await attacker.login(outsiderEmail);
      const attackerOrg = OrganizationSchema.parse(
        (await attacker.request('POST', '/organizations', { name: 'Attacker', slug: `atk-${run}` })).body,
      );
      const added = AddMemberResponseSchema.parse(
        (
          await attacker.request('POST', `/organizations/${attackerOrg.id}/members`, {
            email: ownerEmail,
            displayName: 'Victim',
            role: 'VIEWER',
          })
        ).body,
      );
      expect(added.setupLink).toBeNull();
      const reset = await attacker.request(
        'POST',
        `/organizations/${attackerOrg.id}/members/${added.member.id}/setup-link`,
      );
      expect(reset.status).toBe(403);
      expect(await prisma.userSetupToken.count({ where: { user: { email: ownerEmail } } })).toBe(0);

      // A person with a pending invitation from another organization cannot be hijacked either.
      const pendingEmail = `pending-${run}@example.com`;
      await owner.request('POST', `/organizations/${orgId}/members`, {
        email: pendingEmail,
        displayName: 'Pending',
        role: 'VIEWER',
      });
      const hijack = AddMemberResponseSchema.parse(
        (
          await attacker.request('POST', `/organizations/${attackerOrg.id}/members`, {
            email: pendingEmail,
            displayName: 'Pending',
            role: 'VIEWER',
          })
        ).body,
      );
      expect(hijack.setupLink).toBeNull();
      expect(
        (await attacker.request('POST', `/organizations/${attackerOrg.id}/members/${hijack.member.id}/setup-link`))
          .status,
      ).toBe(403);
    });

    it('enforces roles: members cannot manage members or settings', async () => {
      expect((await memberClient.request('GET', `/organizations/${orgId}/members`)).status).toBe(200);
      const add = await memberClient.request('POST', `/organizations/${orgId}/members`, {
        email: `x-${run}@example.com`,
        displayName: 'X',
        role: 'VIEWER',
      });
      expect(add.status).toBe(403);
      expect((await memberClient.request('PUT', `/organizations/${orgId}/settings`, {})).status).toBe(403);
      expect((await memberClient.request('GET', `/organizations/${orgId}/audit-logs`)).status).toBe(403);
    });

    it('only owners manage owners and nobody edits their own membership', async () => {
      const members = z.array(MemberSchema).parse((await owner.request('GET', `/organizations/${orgId}/members`)).body);
      const ownerMember = members.find((m) => m.email === ownerEmail);
      if (!ownerMember) throw new Error('owner missing');
      expect(ownerMember.role).toBe('OWNER');
      const viewer = AddMemberResponseSchema.parse(
        (
          await owner.request('POST', `/organizations/${orgId}/members`, {
            email: `viewer-${run}@example.com`,
            displayName: 'Viewer',
            role: 'VIEWER',
          })
        ).body,
      ).member;
      const promote = await owner.request('PATCH', `/organizations/${orgId}/members/${memberId}`, { role: 'ADMIN' });
      expect(MemberSchema.parse(promote.body).role).toBe('ADMIN');

      const messageOf = (r: { body: unknown }) => ApiErrorSchema.parse(r.body).message;
      // An ADMIN manages members but never owners.
      const toOwner = await memberClient.request('PATCH', `/organizations/${orgId}/members/${viewer.id}`, {
        role: 'OWNER',
      });
      expect(toOwner.status).toBe(403);
      expect(messageOf(toOwner)).toBe('Only an owner can manage owners');
      const removeOwner = await memberClient.request('DELETE', `/organizations/${orgId}/members/${ownerMember.id}`);
      expect(removeOwner.status).toBe(403);
      expect(
        (await memberClient.request('PATCH', `/organizations/${orgId}/members/${viewer.id}`, { role: 'MEMBER' }))
          .status,
      ).toBe(200);
      // Nobody edits their own membership.
      const selfEdit = await owner.request('PATCH', `/organizations/${orgId}/members/${ownerMember.id}`, {
        role: 'ADMIN',
      });
      expect(selfEdit.status).toBe(403);
      expect(messageOf(selfEdit)).toBe('You cannot change your own membership');
      // Clean up the extra member.
      expect((await owner.request('DELETE', `/organizations/${orgId}/members/${viewer.id}`)).status).toBe(204);
      expect(
        (await owner.request('PATCH', `/organizations/${orgId}/members/${memberId}`, { role: 'MEMBER' })).status,
      ).toBe(200);
    });

    it('saves the review policy and audits it', async () => {
      const policy = {
        reviewsEnabled: true,
        allowClaude: true,
        allowOpenai: false,
        allowOllama: true,
        allowFixProposals: false,
        minimumSeverityFloor: 'high',
        minimumConfidenceFloor: 0.85,
      };
      const saved = OrganizationSettingsSchema.parse(
        (await owner.request('PUT', `/organizations/${orgId}/settings`, policy)).body,
      );
      expect(saved).toMatchObject(policy);
      expect(saved.updatedAt).not.toBeNull();
      const invalid = await owner.request('PUT', `/organizations/${orgId}/settings`, {
        ...policy,
        minimumConfidenceFloor: 2,
      });
      expect(invalid.status).toBe(400);
      expect(ApiErrorSchema.parse(invalid.body).message).toBe('Invalid minimumConfidenceFloor');

      const audit = pageOf(AuditLogEntrySchema).parse(
        (await owner.request('GET', `/organizations/${orgId}/audit-logs?action=settings`)).body,
      );
      expect(audit.items[0]).toMatchObject({ action: 'settings.updated', actor: { email: ownerEmail } });
    });
  });

  describe('repositories, reviews, findings, fixes and approvals', () => {
    let repositoryId: string;
    let sessionId: string;
    let findingId: string;
    let fixId: string;

    beforeAll(async () => {
      const connection = await prisma.providerConnection.create({
        data: {
          id: randomUUID(),
          organizationId: orgId,
          provider: 'GITLAB',
          name: 'seed',
          baseUrl: 'https://gitlab.example',
          encryptedToken: { v: 1 },
          tokenKeyId: 'k',
        },
      });
      repositoryId = (
        await prisma.repository.create({
          data: {
            organizationId: orgId,
            provider: 'GITLAB',
            externalId: `ext-${run}`,
            fullName: 'acme/shop',
            connectionId: connection.id,
            webhookId: '1',
          },
        })
      ).id;
      sessionId = (
        await prisma.reviewSession.create({
          data: {
            organizationId: orgId,
            repositoryId,
            requestId: 7,
            headSha: HEAD,
            status: 'COMPLETED',
            idempotencyKey: `dash:${randomUUID()}`,
            finishedAt: new Date(),
            executions: {
              create: [
                {
                  organizationId: orgId,
                  provider: 'claude',
                  model: 'claude-opus-5-5',
                  status: 'succeeded',
                  inputTokens: 1000,
                  outputTokens: 200,
                  costMicros: 25_000n,
                  latencyMs: 900,
                },
                {
                  organizationId: orgId,
                  provider: 'gpt',
                  model: 'gpt-x',
                  status: 'failed',
                  errorKind: 'quota_exceeded',
                  latencyMs: 50,
                },
              ],
            },
          },
        })
      ).id;
      findingId = randomUUID();
      await prisma.reviewFinding.create({
        data: {
          id: findingId,
          organizationId: orgId,
          repositoryId,
          requestId: 7,
          fingerprint: 'fp-dash',
          lastSessionId: sessionId,
          filePath: 'src/a.ts',
          lineNumber: 1,
          severity: 'high',
          category: 'bug',
          title: '<img src=x onerror=alert(1)>',
          description: 'd',
          evidence: 'e',
          confidence: 0.9,
          sources: ['claude'],
          placement: 'inline',
          status: 'PUBLISHED',
          firstSeenSha: HEAD,
          lastSeenSha: HEAD,
        },
      });
      fixId = randomUUID();
      await new ApprovalStore(prisma).saveProposedFix(
        { organizationId: orgId },
        {
          id: fixId,
          repositoryId,
          reviewSessionId: sessionId,
          findingId,
          requestId: 7,
          fingerprint: 'fp-dash',
          filePath: 'src/a.ts',
          baseSha: HEAD,
          targetBranch: 'feature',
          explanation: 'Use b instead of a.',
          changes: [],
          patch: PATCH,
          patchSha256: sha256(PATCH),
          originalSha256: sha256('a\n'),
          resultSha256: sha256('b\n'),
          additions: 1,
          deletions: 1,
          provider: 'claude',
          model: 'm',
          costUsd: 0.004,
          branch: `ai-review/fix-${fixId.replace(/-/g, '').slice(0, 12)}`,
        },
      );
    });

    it('lists repositories and pauses one', async () => {
      const repos = z
        .array(RepositorySchema)
        .parse((await owner.request('GET', `/organizations/${orgId}/repositories`)).body);
      expect(repos).toEqual([expect.objectContaining({ id: repositoryId, isActive: true, webhookConfigured: true })]);
      const paused = RepositorySchema.parse(
        (await owner.request('PATCH', `/organizations/${orgId}/repositories/${repositoryId}`, { isActive: false }))
          .body,
      );
      expect(paused.isActive).toBe(false);
      await owner.request('PATCH', `/organizations/${orgId}/repositories/${repositoryId}`, { isActive: true });
    });

    it('shows review history and details with executions and costs', async () => {
      const page = pageOf(ReviewSummarySchema).parse(
        (await owner.request('GET', `/organizations/${orgId}/reviews?limit=1`)).body,
      );
      expect(page.items).toEqual([
        expect.objectContaining({ id: sessionId, findingCount: 1, costUsd: 0.025, status: 'completed' }),
      ]);
      const detail = ReviewDetailSchema.parse(
        (await owner.request('GET', `/organizations/${orgId}/reviews/${sessionId}`)).body,
      );
      expect(detail.executions.map((e) => e.status)).toEqual(['succeeded', 'failed']);
      expect(detail.findings[0]?.title).toBe('<img src=x onerror=alert(1)>');
      expect((await owner.request('GET', `/organizations/${orgId}/reviews/${randomUUID()}`)).status).toBe(404);
      expect((await owner.request('GET', `/organizations/${orgId}/reviews?status=nope`)).status).toBe(400);
    });

    it('filters findings and lets members triage them', async () => {
      const high = pageOf(FindingSummarySchema).parse(
        (await owner.request('GET', `/organizations/${orgId}/findings?severity=high&status=published`)).body,
      );
      expect(high.items.map((f) => f.id)).toEqual([findingId]);
      const low = pageOf(FindingSummarySchema).parse(
        (await owner.request('GET', `/organizations/${orgId}/findings?severity=low`)).body,
      );
      expect(low.items).toEqual([]);

      const detail = FindingDetailSchema.parse(
        (await owner.request('GET', `/organizations/${orgId}/findings/${findingId}`)).body,
      );
      expect(detail.allowedTransitions).toEqual(['dismissed', 'false_positive']);
      expect(detail.fixes).toEqual([expect.objectContaining({ id: fixId, status: 'proposed' })]);

      const marked = FindingDetailSchema.parse(
        (
          await owner.request('PATCH', `/organizations/${orgId}/findings/${findingId}`, {
            status: 'false_positive',
            reason: 'test data',
          })
        ).body,
      );
      expect(marked.status).toBe('false_positive');
      expect(marked.allowedTransitions).toEqual([]);
      const again = await owner.request('PATCH', `/organizations/${orgId}/findings/${findingId}`, {
        status: 'dismissed',
      });
      expect(again.status).toBe(400);
    });

    it('requests and approves a fix only with the exact approval code', async () => {
      const fix = FixDetailSchema.parse((await owner.request('GET', `/organizations/${orgId}/fixes/${fixId}`)).body);
      expect(fix).toMatchObject({ patch: PATCH, nextStep: 'push', costUsd: 0.004, repositoryName: 'acme/shop' });

      const requested = await owner.request('POST', `/organizations/${orgId}/approvals`, { fixId, step: 'push' });
      expect(requested.status).toBe(201);
      const approval = ApprovalDetailSchema.parse(requested.body);
      expect(approval).toMatchObject({
        status: 'pending',
        operationKind: 'commit_and_push_fix',
        patchSha256: sha256(PATCH),
      });
      expect(approval.description.join('\n')).toContain(fix.branch);

      const wrong = await owner.request('POST', `/organizations/${orgId}/approvals/${approval.id}/approve`, {
        code: '000000000000',
      });
      expect(wrong.status).toBe(400);
      const ok = await owner.request('POST', `/organizations/${orgId}/approvals/${approval.id}/approve`, {
        code: approval.approvalCode.toUpperCase(),
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ approval: { status: 'approved' }, jobId: expect.any(String) });
      const twice = await owner.request('POST', `/organizations/${orgId}/approvals/${approval.id}/approve`, {
        code: approval.approvalCode,
      });
      expect(twice.status).toBe(409);
    });

    it('reports analytics and usage from recorded data', async () => {
      const analytics = AnalyticsResponseSchema.parse(
        (await owner.request('GET', `/organizations/${orgId}/analytics?days=7`)).body,
      );
      expect(analytics.reviews.total).toBe(1);
      expect(analytics.findings.bySeverity).toEqual({ high: 1 });
      expect(analytics.falsePositiveRate).toBe(1);
      expect(analytics.daily).toHaveLength(8);

      const usage = UsageResponseSchema.parse(
        (await owner.request('GET', `/organizations/${orgId}/usage?days=7`)).body,
      );
      expect(usage.totals).toMatchObject({
        executions: 2,
        failures: 1,
        inputTokens: 1000,
        costUsd: 0.025,
        unpricedExecutions: 1,
      });
      expect(usage.totals.fixProposalCostUsd).toBeCloseTo(0.004);
      const gpt = usage.providers.find((p) => p.provider === 'gpt');
      expect(gpt).toMatchObject({ allowedByPolicy: false, lastErrorKind: 'quota_exceeded', failures30d: 1 });
    });

    it('connects a GitLab project with a write-only token', async () => {
      const result = await owner.request('POST', `/organizations/${orgId}/connections/gitlab`, {
        connectionName: 'fake',
        baseUrl: gitlab.baseUrl,
        project: gitlab.state.pathWithNamespace,
        token: gitlab.state.token,
        webhook: 'none',
      });
      expect(result.status).toBe(201);
      const connected = ConnectGitLabResponseSchema.parse(result.body);
      expect(connected.projectPath).toBe(gitlab.state.pathWithNamespace);

      const connections = await owner.request('GET', `/organizations/${orgId}/connections`);
      expect(JSON.stringify(connections.body)).not.toContain(gitlab.state.token);
      const stored = await prisma.providerConnection.findFirstOrThrow({
        where: { organizationId: orgId, name: 'fake' },
      });
      expect(JSON.stringify(stored.encryptedToken)).not.toContain(gitlab.state.token);

      const badToken = await owner.request('POST', `/organizations/${orgId}/connections/gitlab`, {
        connectionName: 'bad',
        baseUrl: gitlab.baseUrl,
        project: gitlab.state.pathWithNamespace,
        token: 'glpat-wrong-token-value',
        webhook: 'none',
      });
      expect(badToken.status).toBe(400);
      expect(JSON.stringify(badToken.body)).not.toContain('glpat-wrong-token-value');

      const ssrf = await owner.request('POST', `/organizations/${orgId}/connections/gitlab`, {
        connectionName: 'ssrf',
        baseUrl: 'https://169.254.169.254',
        project: 'a/b',
        token: 'glpat-whatever-value',
        webhook: 'none',
      });
      expect(ssrf.status).toBe(400);
    });

    it('keeps tenants isolated on nested resources', async () => {
      const other = new Client(baseUrl);
      await other.login(outsiderEmail);
      const created = OrganizationSchema.parse(
        (await other.request('POST', '/organizations', { name: 'Other', slug: `other-${run}` })).body,
      );
      // A valid id from org A requested through org B's path is not found.
      expect((await other.request('GET', `/organizations/${created.id}/findings/${findingId}`)).status).toBe(404);
      expect((await other.request('GET', `/organizations/${created.id}/reviews/${sessionId}`)).status).toBe(404);
      expect((await other.request('GET', `/organizations/${created.id}/fixes/${fixId}`)).status).toBe(404);
      const findings = pageOf(FindingSummarySchema).parse(
        (await other.request('GET', `/organizations/${created.id}/findings`)).body,
      );
      expect(findings.items).toEqual([]);
    });
  });
});
