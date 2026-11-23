#!/usr/bin/env node
/**
 * Operator commands (run on the server, not exposed over HTTP until authenticated management
 * APIs exist in Phase 7).
 *
 *   GITLAB_TOKEN=... node dist/apps/api/admin.js connect-gitlab --org acme --project group/app
 *
 *   node dist/apps/api/admin.js connect-github --org acme --installation 12345678
 *
 * The GitLab token is read from GITLAB_TOKEN (never from argv, which is visible in process lists);
 * the GitHub App key from GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH.
 *
 * Fix approvals (Phase 6): fixes-list | fixes-show | approvals-request | approvals-approve |
 * approvals-reject | approvals-list | members-add. Approving needs the approval code of exactly
 * that request; execution runs in the worker, which re-verifies everything. Merging is never offered.
 */
import 'reflect-metadata';
import {
  ConfigValidationError,
  GitHubAppEnvSchema,
  GitProviderEnvSchema,
  loadDotEnvFile,
  loadEnv,
  resolveGitHubAppSettings,
} from '@acra/configuration';
import { approvalCode } from '@acra/approvals';
import { ApprovalStore, ConnectionStore, createPrismaClient, ReviewStore } from '@acra/database';
import { createRedisConnectionOptions, enqueueApprovalExecution, QueueName } from '@acra/queue';
import { Queue } from 'bullmq';
import { parseMasterKey } from '@acra/security';
import { Command, Option } from 'commander';
import * as z from 'zod';
import {
  addMember,
  type ApprovalAdminDeps,
  decideApproval,
  listApprovals,
  listFixes,
  requestApproval,
  showFix,
} from './admin/approvals-admin';
import { connectGitHubInstallation } from './admin/connect-github';
import { connectGitLabProject } from './admin/connect-gitlab';

const AdminEnvSchema = GitProviderEnvSchema.extend({
  DATABASE_URL: z.string().min(1),
  WEBHOOK_PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  GITLAB_TOKEN: z.string().min(10, 'GITLAB_TOKEN must be set (personal/project access token with api scope)'),
});

const program = new Command().name('acra-admin').description('AI Code Review Agent — operator commands');

program
  .command('connect-gitlab')
  .description('connect a GitLab project: store the encrypted token, register the repository and its webhook')
  .requiredOption('--org <slug>', 'organization slug (created if missing)')
  .option('--org-name <name>', 'organization display name (when created)')
  .requiredOption('--project <idOrPath>', 'project id or "group/project"')
  .option('--base-url <url>', 'GitLab instance URL', 'https://gitlab.com')
  .option('--connection <name>', 'connection name', 'default')
  .option('--manual-webhook', 'do not register the hook via API; print URL and token for manual setup')
  .option('--no-webhook', 'skip webhook setup entirely')
  .action(
    async (options: {
      org: string;
      orgName?: string;
      project: string;
      baseUrl: string;
      connection: string;
      manualWebhook?: boolean;
      webhook: boolean;
    }) => {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(options.org)) throw new Error('--org must be a lower-case slug');
      loadDotEnvFile();
      const env = loadEnv(AdminEnvSchema);
      if (options.webhook && !env.WEBHOOK_PUBLIC_BASE_URL) {
        throw new Error('WEBHOOK_PUBLIC_BASE_URL is required for webhook setup (or pass --no-webhook)');
      }
      const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL, poolMax: 2 });
      try {
        const result = await connectGitLabProject(
          {
            connections: new ConnectionStore(prisma),
            reviews: new ReviewStore(prisma),
            masterKey: parseMasterKey(env.CREDENTIALS_MASTER_KEY),
            policy: { allowedHosts: env.GITLAB_ALLOWED_HOSTS, allowPrivateNetwork: env.GITLAB_ALLOW_PRIVATE_NETWORK },
          },
          {
            organizationSlug: options.org,
            organizationName: options.orgName ?? options.org,
            connectionName: options.connection,
            baseUrl: options.baseUrl,
            project: options.project,
            token: env.GITLAB_TOKEN,
            ...(options.webhook && env.WEBHOOK_PUBLIC_BASE_URL ? { webhookBaseUrl: env.WEBHOOK_PUBLIC_BASE_URL } : {}),
            registerWebhook: !options.manualWebhook,
          },
        );
        process.stdout.write(
          `Connected ${result.projectPath} (project ${result.projectId}) → repository ${result.repositoryId}\n`,
        );
        if (result.webhookUrl) process.stdout.write(`Webhook URL: ${result.webhookUrl}\n`);
        if (result.webhookToken) {
          process.stdout.write(
            'Manual webhook setup (Settings → Webhooks): trigger "Merge request events", SSL verification on.\n' +
              `Secret token (shown once, not stored): ${result.webhookToken}\n`,
          );
        } else if (result.webhookId) {
          process.stdout.write(`Webhook registered (hook id ${result.webhookId}).\n`);
        }
      } finally {
        await prisma.$disconnect();
      }
    },
  );

const GitHubAdminEnvSchema = GitHubAppEnvSchema.extend({ DATABASE_URL: z.string().min(1) });

program
  .command('connect-github')
  .description('connect a GitHub App installation: verify it and register the repositories it can access')
  .requiredOption('--org <slug>', 'organization slug (created if missing)')
  .option('--org-name <name>', 'organization display name (when created)')
  .requiredOption('--installation <id>', 'GitHub App installation id (from the installation settings URL)')
  .action(async (options: { org: string; orgName?: string; installation: string }) => {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(options.org)) throw new Error('--org must be a lower-case slug');
    if (!/^\d{1,15}$/.test(options.installation)) throw new Error('--installation must be numeric');
    loadDotEnvFile();
    const env = loadEnv(GitHubAdminEnvSchema);
    const app = resolveGitHubAppSettings(env);
    if (!app) throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY(_PATH) must be set');
    const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL, poolMax: 2 });
    try {
      const result = await connectGitHubInstallation(
        { connections: new ConnectionStore(prisma), app },
        {
          organizationSlug: options.org,
          organizationName: options.orgName ?? options.org,
          installationId: Number(options.installation),
        },
      );
      process.stdout.write(
        `Connected installation ${options.installation} (${result.accountLogin}) → connection ${result.connectionId}\n` +
          `Repositories (${result.repositories.length}): ${result.repositories.join(', ') || 'none'}\n`,
      );
    } finally {
      await prisma.$disconnect();
    }
  });

const DataEnvSchema = z.object({ DATABASE_URL: z.string().min(1), REDIS_URL: z.string().min(1) });

/** Opens the stores (and the approvals queue) for one admin command, closing them afterwards. */
async function withApprovalDeps<T>(action: (deps: ApprovalAdminDeps) => Promise<T>): Promise<T> {
  loadDotEnvFile();
  const env = loadEnv(DataEnvSchema);
  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL, poolMax: 2 });
  const queue = new Queue(QueueName.Approvals, { connection: createRedisConnectionOptions(env.REDIS_URL, 'producer') });
  try {
    return await action({
      approvals: new ApprovalStore(prisma),
      reviews: new ReviewStore(prisma),
      connections: new ConnectionStore(prisma),
      enqueue: (job) => enqueueApprovalExecution(queue, job),
    });
  } finally {
    await queue.close();
    await prisma.$disconnect();
  }
}

const out = (line: string) => process.stdout.write(`${line}\n`);

program
  .command('members-add')
  .description('add (or update) an organization member who can request and decide approvals')
  .requiredOption('--org <slug>', 'organization slug')
  .requiredOption('--email <email>', 'member e-mail')
  .requiredOption('--name <name>', 'display name')
  .addOption(new Option('--role <role>', 'role').choices(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']).default('MEMBER'))
  .action(async (o: { org: string; email: string; name: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' }) => {
    await withApprovalDeps((deps) =>
      addMember(deps, { organizationSlug: o.org, email: o.email, displayName: o.name, role: o.role }),
    );
    out(`Member ${o.email.toLowerCase()} (${o.role}) saved.`);
  });

program
  .command('fixes-list')
  .description('list AI fix proposals of an organization')
  .requiredOption('--org <slug>', 'organization slug')
  .action(async (o: { org: string }) => {
    const fixes = await withApprovalDeps((deps) => listFixes(deps, { organizationSlug: o.org }));
    if (fixes.length === 0) out('No fix proposals.');
    for (const f of fixes) out(`${f.id}  ${f.status.padEnd(10)}  !${f.requestId}  ${f.filePath}  ${f.finding.title}`);
  });

program
  .command('fixes-show')
  .description('show a fix proposal with its exact patch')
  .requiredOption('--org <slug>', 'organization slug')
  .argument('<fix-id>', 'fix id')
  .action(async (fixId: string, o: { org: string }) => {
    const f = await withApprovalDeps((deps) => showFix(deps, { organizationSlug: o.org, fixId }));
    out(`Fix ${f.id} · ${f.status} · ${f.filePath} · +${f.additions} −${f.deletions} · ${f.provider}/${f.model}`);
    out(`Finding: ${f.finding.title} (${f.finding.severity}, ${f.finding.category})`);
    out(`Why (model explanation, unverified): ${f.explanation}`);
    out(`Reviewed commit ${f.baseSha} · patch sha256 ${f.patchSha256} · branch ${f.branch} → ${f.targetBranch}`);
    out(f.patch.trimEnd());
  });

program
  .command('approvals-list')
  .description('list approval requests (open ones by default)')
  .requiredOption('--org <slug>', 'organization slug')
  .option('--all', 'include finished requests')
  .action(async (o: { org: string; all?: boolean }) => {
    const list = await withApprovalDeps((deps) =>
      listApprovals(deps, { organizationSlug: o.org, all: Boolean(o.all) }),
    );
    if (list.length === 0) out('No approval requests.');
    for (const { request: r } of list) {
      out(
        `${r.id}  ${r.status.padEnd(11)}  ${r.operation.kind.padEnd(20)}  fix ${r.operation.fixId}  code ${approvalCode(r)}  expires ${r.expiresAt}`,
      );
    }
  });

program
  .command('approvals-request')
  .description('request approval for the next step of a fix: push (branch + commit) or open (MR/PR)')
  .requiredOption('--org <slug>', 'organization slug')
  .requiredOption('--fix <id>', 'fix id (see fixes-list)')
  .addOption(new Option('--step <step>', 'operation to request').choices(['push', 'open']).makeOptionMandatory())
  .requiredOption('--user <email>', 'requesting organization member')
  .option('--ttl-hours <hours>', 'expiry in hours (max 168)', '24')
  .action(async (o: { org: string; fix: string; step: 'push' | 'open'; user: string; ttlHours: string }) => {
    const ttlHours = Number(o.ttlHours);
    if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 168) throw new Error('--ttl-hours must be 1–168');
    const { request, description } = await withApprovalDeps((deps) =>
      requestApproval(deps, { organizationSlug: o.org, fixId: o.fix, step: o.step, requestedBy: o.user, ttlHours }),
    );
    out(`Approval request ${request.id} (pending, expires ${request.expiresAt})`);
    for (const line of description) out(`  ${line}`);
    out(`  Bound to reviewed commit ${request.headSha}, patch sha256 ${request.patchSha256 ?? '-'}`);
    out(
      `Approval code: ${approvalCode(request)}  (approvals-approve ${request.id} --org ${o.org} --user <email> --code <code>)`,
    );
  });

program
  .command('approvals-approve')
  .description('approve a pending request as an organization member and queue its execution')
  .requiredOption('--org <slug>', 'organization slug')
  .requiredOption('--user <email>', 'deciding organization member (role OWNER, ADMIN or MEMBER)')
  .requiredOption('--code <code>', 'approval code shown for exactly this request')
  .argument('<approval-id>', 'approval request id')
  .action(async (approvalId: string, o: { org: string; user: string; code: string }) => {
    const result = await withApprovalDeps(async (deps) => {
      const stored = (await listApprovals(deps, { organizationSlug: o.org, all: true })).find(
        (a) => a.request.id === approvalId,
      );
      if (!stored) throw new Error('Approval request not found');
      if (approvalCode(stored.request) !== o.code.trim().toLowerCase()) {
        throw new Error('The approval code does not match this request. Nothing was approved.');
      }
      return decideApproval(deps, { organizationSlug: o.org, approvalId, decidedBy: o.user, decision: 'approve' });
    });
    out(`Approved ${result.request.id}; execution queued (job ${result.jobId ?? '-'}). Merging stays a human action.`);
  });

program
  .command('approvals-reject')
  .description('reject a pending request')
  .requiredOption('--org <slug>', 'organization slug')
  .requiredOption('--user <email>', 'deciding organization member')
  .option('--reason <text>', 'reason (max 500 characters)')
  .argument('<approval-id>', 'approval request id')
  .action(async (approvalId: string, o: { org: string; user: string; reason?: string }) => {
    await withApprovalDeps((deps) =>
      decideApproval(deps, {
        organizationSlug: o.org,
        approvalId,
        decidedBy: o.user,
        decision: 'reject',
        ...(o.reason ? { reason: o.reason } : {}),
      }),
    );
    out(`Rejected ${approvalId}.`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(
    `error: ${error instanceof ConfigValidationError || error instanceof Error ? error.message : 'unexpected failure'}\n`,
  );
  process.exitCode = 1;
});
