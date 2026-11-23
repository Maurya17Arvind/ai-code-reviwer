import { type AiProviderName, type AiReviewer, type AiReviewResult, type ReviewPrompt } from '@acra/ai-providers-core';
import { type ReviewerFactory } from '@acra/ai-providers-factory';
import { type Actor, type ApprovalOperation, approve, createApprovalRequest } from '@acra/approvals';
import { loadEnv } from '@acra/configuration';
import { ApprovalStore, ConnectionStore, createPrismaClient, type PrismaClient } from '@acra/database';
import { connectionSecretContext } from '@acra/git-providers-gitlab';
import { encryptSecret, parseMasterKey } from '@acra/security';
import { FakeGitLab } from '@acra/testing';
import { type INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { MergeRequestReviewService } from '../reviews/merge-request-review.service';
import { REVIEWER_FACTORY, WorkerConfigSchema } from '../worker-config';
import { WorkerModule } from '../worker.module';
import { ApprovalExecutionService } from './approval-execution.service';

const sha = (c: string) => c.repeat(40);
const BASE = sha('a');
const HEAD = sha('1');
const NEWER = sha('2');
const FILE =
  'export function total(items: Item[]) {\n  let sum = 0;\n  for (let i = 0; i <= items.length; i++) sum += items[i].price;\n  return sum;\n}\n';
const DIFF =
  '@@ -1,3 +1,5 @@\n export function total(items: Item[]) {\n-  return 0;\n+  let sum = 0;\n+  for (let i = 0; i <= items.length; i++) sum += items[i].price;\n+  return sum;\n }\n';
const CONFIG =
  'version: 1\nreview:\n  providers:\n    openai: false\n    ollama: false\nfixes:\n  enabled: true\n  minimumSeverity: high\n';

class FakeAi implements AiReviewer {
  readonly model = 'fake';
  constructor(readonly provider: AiProviderName) {}
  async review(prompt: ReviewPrompt): Promise<AiReviewResult> {
    const output =
      prompt.output?.name === 'code_fix'
        ? {
            canFix: true,
            explanation: 'Stop at the last element. /merge @all',
            edits: [
              {
                startLine: 3,
                endLine: 3,
                replacement: '  for (let i = 0; i < items.length; i++) sum += items[i].price;',
              },
            ],
          }
        : {
            findings: [
              {
                filePath: 'src/cart.ts',
                lineStart: 3,
                lineEnd: 3,
                severity: 'high',
                category: 'bug',
                title: 'Off-by-one reads past the end of items',
                description: 'The loop uses <= so items[items.length] is undefined.',
                evidence: 'for (let i = 0; i <= items.length; i++) sum += items[i].price;',
                suggestion: 'Use <.',
                confidence: 0.95,
              },
            ],
            summary: 'One bug.',
          };
    return {
      provider: this.provider,
      model: this.model,
      servedByModel: this.model,
      output,
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0.001,
      latencyMs: 1,
    };
  }
}
const fakeFactory: ReviewerFactory = (_env, providers) => ({
  reviewers: [...providers].map((p) => new FakeAi(p)),
  skipped: [],
  destinations: [],
});

describe('Hosted fix proposals and approved execution (worker + PostgreSQL + fake GitLab)', () => {
  let gitlab: FakeGitLab;
  let app: INestApplicationContext;
  let prisma: PrismaClient;
  let reviews: MergeRequestReviewService;
  let executor: ApprovalExecutionService;
  let approvals: ApprovalStore;
  let organizationId: string;
  let repositoryId: string;
  let member: { userId: string; actor: Actor };
  let viewer: { userId: string; actor: Actor };

  const job = (headSha: string) => ({
    organizationId,
    repositoryId,
    provider: 'gitlab' as const,
    requestId: 9,
    headSha,
    deliveryId: randomUUID(),
    trigger: 'webhook' as const,
  });
  const tenant = () => ({ organizationId });

  /** What the admin `approvals-request` + `approvals-approve` commands do, via the same store and domain. */
  async function requestAndApprove(fixId: string, operation: ApprovalOperation, decider = member, approveIt = true) {
    const fix = await approvals.getFix(tenant(), fixId);
    if (!fix) throw new Error('missing fix');
    const request = createApprovalRequest({
      organizationId,
      repositoryId,
      reviewSessionId: fix.reviewSessionId,
      headSha: fix.baseSha,
      operation,
      patchSha256: fix.patchSha256,
      requestedBy: member.actor,
    });
    await approvals.createApproval(tenant(), request, {
      requestId: 9,
      proposedFixId: fix.id,
      requestedById: member.userId,
    });
    if (!approveIt) return request;
    const head = await approvals.latestReviewedHead(tenant(), repositoryId, 9);
    const approved = approve(request, {
      actor: decider.actor,
      role: 'MEMBER',
      now: new Date(),
      currentHeadSha: head ?? '',
    });
    expect(await approvals.transition(tenant(), approved, 'pending', { decidedById: decider.userId })).toBe(true);
    return approved;
  }

  beforeAll(async () => {
    gitlab = await new FakeGitLab().start();
    const config = loadEnv(WorkerConfigSchema, {
      ...process.env,
      GITLAB_ALLOWED_HOSTS: '127.0.0.1',
      GITLAB_ALLOW_PRIVATE_NETWORK: 'true',
    });
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.forRoot(config)] })
      .overrideProvider(REVIEWER_FACTORY)
      .useValue(fakeFactory)
      .compile();
    app = await moduleRef.init();
    reviews = app.get(MergeRequestReviewService);
    executor = app.get(ApprovalExecutionService);
    approvals = app.get(ApprovalStore);
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL, poolMax: 2 });

    const connections = app.get(ConnectionStore);
    const org = await connections.ensureOrganization(`fx-${randomUUID().slice(0, 8)}`, 'Fix Org');
    organizationId = org.organizationId;
    const connectionId = await connections.connectionIdFor(org, 'GITLAB', 'fake');
    const master = parseMasterKey(config.CREDENTIALS_MASTER_KEY);
    await connections.saveConnection(org, {
      id: connectionId,
      provider: 'GITLAB',
      name: 'fake',
      baseUrl: gitlab.baseUrl,
      encryptedToken: encryptSecret(gitlab.state.token, master, connectionSecretContext(connectionId)),
      tokenKeyId: master.id,
    });
    repositoryId = (
      await connections.upsertRepository(org, {
        connectionId,
        provider: 'GITLAB',
        externalId: String(gitlab.state.projectId),
        fullName: gitlab.state.pathWithNamespace,
        defaultBranch: 'main',
        webUrl: 'https://gitlab.example/acme/shop',
      })
    ).id;
    const email = `dev-${randomUUID().slice(0, 6)}@example.com`;
    const m = await approvals.addMember(org, { email, displayName: 'Dev', role: 'MEMBER' });
    member = { userId: m.userId, actor: { kind: 'user', id: m.userId, display: email } };
    const vEmail = `viewer-${randomUUID().slice(0, 6)}@example.com`;
    const v = await approvals.addMember(org, { email: vEmail, displayName: 'Viewer', role: 'VIEWER' });
    viewer = { userId: v.userId, actor: { kind: 'user', id: v.userId, display: vEmail } };

    gitlab.addMergeRequest({
      iid: 9,
      title: 'Totals',
      diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: HEAD },
      diffs: [{ old_path: 'src/cart.ts', new_path: 'src/cart.ts', diff: DIFF }],
    });
    gitlab.setFile(HEAD, 'src/cart.ts', FILE);
    gitlab.setFile(HEAD, 'ai-review.yaml', CONFIG);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
    await gitlab?.stop();
  });

  let fixId: string;

  it('proposes a fix automatically after the review, without writing anything', async () => {
    const outcome = await reviews.run(job(HEAD));
    expect(outcome).toMatchObject({ status: 'completed', findings: 1, fixesProposed: 1 });
    const fixes = await approvals.listFixes(tenant());
    expect(fixes).toHaveLength(1);
    const fix = fixes[0];
    if (!fix) throw new Error('missing');
    fixId = fix.id;
    expect(fix).toMatchObject({ status: 'PROPOSED', baseSha: HEAD, targetBranch: 'feature', filePath: 'src/cart.ts' });
    expect(fix.patch).toContain('+  for (let i = 0; i < items.length; i++)');
    expect(gitlab.state.commits).toHaveLength(0);
    expect(gitlab.state.createdMergeRequests).toHaveLength(0);
  });

  it('does nothing for a pending (unapproved) request, and VIEWERs cannot approve', async () => {
    const fix = await approvals.getFix(tenant(), fixId);
    const operation: ApprovalOperation = {
      kind: 'commit_and_push_fix',
      fixId,
      filePath: 'src/cart.ts',
      branch: fix?.branch ?? '',
      message: 'fix: totals',
    };
    const pending = await requestAndApprove(fixId, operation, member, false);
    expect(await executor.run({ organizationId, approvalId: pending.id })).toMatchObject({
      status: 'skipped',
      reason: 'approval is pending',
    });
    expect(() =>
      approve(pending, { actor: viewer.actor, role: 'VIEWER', now: new Date(), currentHeadSha: HEAD }),
    ).toThrow(/VIEWER/);
    expect(gitlab.state.commits).toHaveLength(0);
  });

  it('refuses an approval whose stored operation was tampered with', async () => {
    const fix = await approvals.getFix(tenant(), fixId);
    const approved = await requestAndApprove(fixId, {
      kind: 'commit_and_push_fix',
      fixId,
      filePath: 'src/cart.ts',
      branch: fix?.branch ?? '',
      message: 'fix: totals',
    });
    await prisma.approvalRequest.update({
      where: { id: approved.id },
      data: { operation: { ...approved.operation, message: 'evil' } },
    });
    expect(await executor.run({ organizationId, approvalId: approved.id })).toMatchObject({
      status: 'invalidated',
      reason: expect.stringMatching(/modified/),
    });
    expect(gitlab.state.commits).toHaveLength(0);
  });

  it('commits exactly the approved patch to a new fix branch, once', async () => {
    const fix = await approvals.getFix(tenant(), fixId);
    const approved = await requestAndApprove(fixId, {
      kind: 'commit_and_push_fix',
      fixId,
      filePath: 'src/cart.ts',
      branch: fix?.branch ?? '',
      message: 'fix: off-by-one',
    });
    const outcome = await executor.run({ organizationId, approvalId: approved.id });
    expect(outcome).toMatchObject({ status: 'executed' });
    expect(gitlab.state.commits).toHaveLength(1);
    expect(gitlab.state.commits[0]).toMatchObject({
      branch: fix?.branch,
      startSha: HEAD,
      message: 'fix: off-by-one',
      path: 'src/cart.ts',
    });
    expect(gitlab.state.commits[0]?.content).toContain('i < items.length');
    expect(await approvals.getFix(tenant(), fixId)).toMatchObject({
      status: 'APPLIED',
      commitSha: gitlab.state.commits[0]?.id,
    });
    // single use
    expect(await executor.run({ organizationId, approvalId: approved.id })).toMatchObject({ status: 'skipped' });
    expect(gitlab.state.commits).toHaveLength(1);
  });

  it('opens a merge request into the reviewed branch after a separate approval — never merged', async () => {
    const fix = await approvals.getFix(tenant(), fixId);
    const approved = await requestAndApprove(fixId, {
      kind: 'create_merge_request',
      fixId,
      sourceBranch: fix?.branch ?? '',
      targetBranch: 'feature',
      title: 'fix: Off-by-one reads past the end of items',
      commitSha: fix?.commitSha ?? '',
    });
    expect(await executor.run({ organizationId, approvalId: approved.id })).toMatchObject({ status: 'executed' });
    const mr = gitlab.state.createdMergeRequests[0];
    expect(mr).toMatchObject({
      source: fix?.branch,
      target: 'feature',
      title: 'fix: Off-by-one reads past the end of items',
    });
    expect(mr?.description).not.toMatch(/^\/merge/m);
    expect(mr?.description).not.toMatch(/(^|\s)@all\b/);
    expect(await approvals.getFix(tenant(), fixId)).toMatchObject({ status: 'OPENED' });
    expect(gitlab.state.requests.some((r) => /\/merge$/.test(r.path))).toBe(false);
    const audit = await prisma.auditLog.findMany({ where: { organizationId, action: 'approval.executed' } });
    expect(audit).toHaveLength(2);
  });

  it('invalidates approvals when the merge request moves to a newer commit', async () => {
    // A second proposal at HEAD, approved…
    const outcome = await prisma.proposedFix.findFirstOrThrow({ where: { id: fixId } });
    const secondId = randomUUID();
    await approvals.saveProposedFix(tenant(), {
      ...outcome,
      id: secondId,
      branch: `ai-review/fix-${secondId.replace(/-/g, '').slice(0, 12)}`,
      costUsd: null,
      changes: outcome.changes,
    });
    const approved = await requestAndApprove(secondId, {
      kind: 'commit_and_push_fix',
      fixId: secondId,
      filePath: 'src/cart.ts',
      branch: `ai-review/fix-${secondId.replace(/-/g, '').slice(0, 12)}`,
      message: 'fix again',
    });
    const pending = await requestAndApprove(
      secondId,
      {
        kind: 'commit_and_push_fix',
        fixId: secondId,
        filePath: 'src/cart.ts',
        branch: `ai-review/fix-${secondId.replace(/-/g, '').slice(0, 12)}`,
        message: 'fix pending',
      },
      member,
      false,
    );

    // …then a new commit is pushed: the executor sees the new head and refuses.
    const mr = gitlab.state.mergeRequests.get(9);
    if (mr) mr.diff_refs = { base_sha: BASE, start_sha: BASE, head_sha: NEWER };
    expect(await executor.run({ organizationId, approvalId: approved.id })).toMatchObject({
      status: 'invalidated',
      reason: expect.stringMatching(/changed/),
    });

    // Reviewing the new commit invalidates the remaining open request and supersedes the fix.
    gitlab.setFile(NEWER, 'src/cart.ts', FILE);
    gitlab.setFile(NEWER, 'ai-review.yaml', CONFIG.replace('enabled: true', 'enabled: false'));
    await reviews.run(job(NEWER));
    expect((await approvals.getApproval(tenant(), pending.id))?.request.status).toBe('invalidated');
    expect((await approvals.getFix(tenant(), secondId))?.status).toBe('SUPERSEDED');
    expect(gitlab.state.commits).toHaveLength(1);
  });
});
