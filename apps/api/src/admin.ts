#!/usr/bin/env node
/**
 * Operator commands (run on the server, not exposed over HTTP until authenticated management
 * APIs exist in Phase 7).
 *
 *   GITLAB_TOKEN=... node dist/apps/api/admin.js connect-gitlab --org acme --project group/app
 *
 * The GitLab token is read from GITLAB_TOKEN (never from argv, which is visible in process lists).
 */
import 'reflect-metadata';
import { ConfigValidationError, GitProviderEnvSchema, loadDotEnvFile, loadEnv } from '@acra/configuration';
import { ConnectionStore, createPrismaClient, ReviewStore } from '@acra/database';
import { parseMasterKey } from '@acra/security';
import { Command } from 'commander';
import * as z from 'zod';
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

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(
    `error: ${error instanceof ConfigValidationError || error instanceof Error ? error.message : 'unexpected failure'}\n`,
  );
  process.exitCode = 1;
});
