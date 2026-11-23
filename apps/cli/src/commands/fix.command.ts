import { type AiProviderName } from '@acra/ai-providers-core';
import { type ReviewerFactory } from '@acra/ai-providers-factory';
import { disableThirdPartyTracing } from '@acra/agent-core';
import { type ApprovalOperation, fixBranchName } from '@acra/approvals';
import { AiEnvSchema, loadEnv } from '@acra/configuration';
import { generateFix } from '@acra/fix-engine';
import { type RepositoryWriter } from '@acra/git-providers-core';
import { type LocalGitProvider, LocalFixWorkspace } from '@acra/git-providers-local';
import { fixCommitMessage, fixReviewRequestText } from '@acra/publishing';
import { sha256Hex } from '@acra/repository-context';
import { type CommandArgv, CommandPolicyError, parseCommand, runValidationCommand } from '@acra/sandbox';
import { type Command, Option } from 'commander';
import { CliError, type CliIO, paint } from '../core/cli-context';
import { finishApproval, localActor, obtainApproval } from '../core/approval-flow';
import { type FixRecord, LocalFixStore } from '../core/fix-store';
import { detectHostProvider, parseRemote } from '../core/remote';
import { LocalReviewStore } from '../core/review-store';
import { type GlobalOptions, loadRepositoryConfig, openRepository, toCliError } from '../core/workspace';

/** Builds a hosted-provider writer for `fix open` (tests inject fakes). */
export type HostWriterFactory = (input: {
  readonly provider: 'gitlab' | 'github';
  readonly host: string;
  readonly projectPath: string;
  readonly token: string;
}) => Promise<RepositoryWriter>;

interface ApproveOption {
  readonly approve?: string;
}

async function loadFixContext(io: CliIO, command: Command) {
  const provider = await openRepository(io, command.optsWithGlobals<GlobalOptions>());
  const gitDirectory = await provider.getGitDirectory();
  const reviews = new LocalReviewStore(gitDirectory);
  const store = new LocalFixStore(gitDirectory);
  const report = await reviews.latest();
  if (!report) throw new CliError('No review found for this repository. Run `ai-review review` first.');
  return { provider, gitDirectory, store, report };
}

type FixContext = Awaited<ReturnType<typeof loadFixContext>>;

async function approvalContext(io: CliIO, ctx: FixContext, fix: FixRecord, approveCode: string | undefined) {
  const headSha = ctx.report.repository.headSha;
  if (!headSha || headSha !== fix.proposal.baseSha) {
    await ctx.store.refreshApprovals(headSha);
    throw new CliError(
      'A newer commit has been reviewed since this fix was proposed. Its approvals are invalid; propose the fix again.',
    );
  }
  return {
    io,
    store: ctx.store,
    repositoryId: `local:${(await ctx.provider.getRepositoryInfo()).rootPath}`,
    reviewSessionId: fix.reviewId,
    currentHeadSha: headSha,
    actor: localActor(await ctx.provider.userEmail()),
    ...(approveCode !== undefined ? { approveCode } : {}),
  };
}

function requireStatus(fix: FixRecord, expected: FixRecord['status'], next: string): void {
  if (fix.status !== expected) {
    throw new CliError(`Fix ${fix.proposal.id.slice(0, 8)} is ${fix.status}; \`${next}\` needs a ${expected} fix.`);
  }
}

async function openWorkspace(ctx: FixContext, fix: FixRecord): Promise<LocalFixWorkspace> {
  const root = (await ctx.provider.getRepositoryInfo()).rootPath;
  return LocalFixWorkspace.open({
    repoRoot: root,
    gitDirectory: ctx.gitDirectory,
    fixId: fix.proposal.id,
    branch: fix.branch,
  });
}

function renderPatch(io: CliIO, patch: string): void {
  for (const line of patch.replace(/\n$/, '').split('\n')) {
    const style =
      line.startsWith('+') && !line.startsWith('+++')
        ? 'green'
        : line.startsWith('-') && !line.startsWith('---')
          ? 'red'
          : line.startsWith('@@')
            ? 'cyan'
            : 'dim';
    io.out(paint(io, style, line.replace(/\r$/, '')));
  }
}

function renderFix(io: CliIO, fix: FixRecord): void {
  const p = fix.proposal;
  io.out(
    `${paint(io, 'bold', `Fix ${p.id.slice(0, 8)}`)} · ${fix.status} · ${p.filePath} · +${p.additions} −${p.deletions} · ${p.provider}/${p.model}`,
  );
  io.out(`Finding: ${fix.finding.title} (${fix.finding.severity}, ${fix.finding.category})`);
  io.out(`Why (model explanation, unverified): ${p.explanation}`);
  io.out(
    paint(
      io,
      'dim',
      `Base ${p.baseSha.slice(0, 12)} · patch sha256 ${p.patchSha256.slice(0, 12)} · branch ${fix.branch}`,
    ),
  );
  renderPatch(io, p.patch);
}

function approveOption() {
  return new Option('--approve <code>', 'approve non-interactively with the code shown for this exact operation');
}

/**
 * `ai-review fix …` — fix proposals (Module G) and the approval-gated Git workflow (Module H).
 * Proposing is automatic; every step that changes code or Git state asks a human first.
 */
export function registerFixCommands(
  program: Command,
  io: CliIO,
  deps: { createReviewers: ReviewerFactory; hostWriter: HostWriterFactory },
): void {
  const fix = program
    .command('fix')
    .description('propose, review and (with your approval) apply AI fixes for findings');

  fix
    .command('propose')
    .description('ask an AI model for a minimal fix of one finding and show the patch (changes nothing)')
    .argument('<finding-id>', 'finding id or unique prefix (see `ai-review findings`)')
    .addOption(new Option('--provider <provider>', 'model to use').choices(['claude', 'gpt', 'ollama']))
    .option('-y, --yes', 'consent to sending the file to the AI provider')
    .action(async (findingId: string, options: { provider?: AiProviderName; yes?: boolean }, command: Command) => {
      const ctx = await loadFixContext(io, command);
      const { report, provider } = ctx;
      const matches = report.findings.filter((f) => f.id.startsWith(findingId));
      if (findingId.length < 4 || matches.length !== 1) {
        throw new CliError(
          matches.length > 1
            ? `Finding id "${findingId}" is ambiguous.`
            : `No finding "${findingId}" in the latest review.`,
        );
      }
      const finding = matches[0];
      if (!finding) throw new CliError('Finding not found.');
      const baseSha = report.repository.headSha;
      if (!baseSha) throw new CliError('The latest review has no commit; commit your changes and review again.');
      if (report.scope['kind'] === 'branch') {
        throw new CliError(
          'Fixes are proposed against the checked-out commit; review the branch after checking it out.',
        );
      }

      const committed = await readText(provider, finding.filePath, { kind: 'commit', sha: baseSha });
      if (committed === null) {
        throw new CliError(`${finding.filePath} is not in commit ${baseSha.slice(0, 12)}; commit it and review again.`);
      }
      if (report.scope['kind'] !== 'committed') {
        const current = await readText(provider, finding.filePath, { kind: 'worktree' });
        if (current !== committed) {
          throw new CliError(
            `${finding.filePath} has uncommitted changes. Commit them and run \`ai-review review\` again, so the fix is based on a commit.`,
          );
        }
      }

      const { config } = await loadRepositoryConfig(provider);
      const allowed: Record<AiProviderName, boolean> = {
        claude: config.review.providers.claude,
        gpt: config.review.providers.openai,
        ollama: config.review.providers.ollama,
      };
      const order: AiProviderName[] = options.provider ? [options.provider] : ['claude', 'gpt', 'ollama'];
      const setup = deps.createReviewers(loadEnv(AiEnvSchema, io.env), new Set(order.filter((p) => allowed[p])));
      const reviewer = order
        .map((name) => setup.reviewers.find((r) => r.provider === name))
        .find((r) => r !== undefined);
      if (!reviewer) {
        for (const skipped of setup.skipped)
          io.err(paint(io, 'yellow', `Skipping ${skipped.provider}: ${skipped.reason}.`));
        throw new CliError('No AI provider is available for fix generation.', 2);
      }
      const destination = setup.destinations.find((d) => d.provider === reviewer.provider);
      const tracingWarning = disableThirdPartyTracing();
      if (tracingWarning) io.err(paint(io, 'yellow', tracingWarning));
      if (destination && !destination.local && !options.yes) {
        const summary = `About to send ${finding.filePath} (up to 300 lines around the finding, secrets redacted) and the finding to ${reviewer.provider} (${reviewer.model} via ${destination.host}).`;
        if (!io.confirm)
          throw new CliError(`${summary}\nRe-run with --yes to consent (no interactive terminal available).`, 2);
        io.out(summary);
        if (!(await io.confirm('Send it?'))) {
          io.out('Cancelled. Nothing was sent.');
          return;
        }
      }

      const aiEnv = loadEnv(AiEnvSchema, io.env);
      const result = await generateFix({
        reviewer,
        target: {
          id: finding.id,
          fingerprint: finding.fingerprint,
          filePath: finding.filePath,
          ...(finding.lineNumber !== undefined ? { lineNumber: finding.lineNumber } : {}),
          ...(finding.endLineNumber !== undefined ? { endLineNumber: finding.endLineNumber } : {}),
          severity: finding.severity,
          category: finding.category,
          title: finding.title,
          description: finding.description,
          evidence: finding.evidence,
          ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
        },
        content: committed,
        baseSha,
        signal: AbortSignal.timeout(aiEnv.AI_REVIEW_TIMEOUT_MS),
      });
      if (result.status === 'rejected') throw new CliError(`No fix proposed: ${result.reason}`);

      const record: FixRecord = {
        version: 1,
        reviewId: report.reviewId,
        finding: {
          title: finding.title,
          severity: finding.severity,
          category: finding.category,
          ...(finding.lineNumber !== undefined ? { lineNumber: finding.lineNumber } : {}),
        },
        branch: fixBranchName(result.proposal.id),
        status: 'proposed',
        proposal: result.proposal,
        updatedAt: new Date().toISOString(),
      };
      await ctx.store.saveFix(record);
      await ctx.store.audit({
        action: 'fix.proposed',
        fixId: result.proposal.id,
        findingId: finding.id,
        provider: reviewer.provider,
      });
      renderFix(io, record);
      io.out('');
      io.out(
        `Nothing was changed. Next: ${paint(io, 'cyan', `ai-review fix apply ${result.proposal.id.slice(0, 8)}`)} (asks for approval)`,
      );
    });

  fix
    .command('list')
    .description('list fix proposals and their state')
    .action(async (_options: unknown, command: Command) => {
      const ctx = await loadFixContext(io, command);
      const fixes = await ctx.store.fixes();
      if (fixes.length === 0) io.out('No fix proposals. Use `ai-review fix propose <finding-id>`.');
      for (const f of fixes) {
        io.out(
          `${f.proposal.id.slice(0, 8)}  ${f.status.padEnd(9)}  ${f.proposal.filePath}  ${f.finding.title}${f.reviewRequest ? `  → ${f.reviewRequest.url}` : ''}`,
        );
      }
    });

  fix
    .command('show')
    .description('show a fix proposal: explanation and exact patch')
    .argument('<fix-id>', 'fix id or unique prefix')
    .action(async (id: string, _options: unknown, command: Command) => {
      const ctx = await loadFixContext(io, command);
      const record = await ctx.store.findFix(id);
      renderFix(io, record);
      for (const v of record.validation ?? []) {
        io.out(
          `${v.passed ? paint(io, 'green', '✔') : paint(io, 'red', '✖')} ${v.argv.join(' ')} (${v.timedOut ? 'timed out' : `exit ${v.exitCode}`}, ${Math.round(v.durationMs / 1000)}s)`,
        );
      }
    });

  fix
    .command('apply')
    .description('apply the approved patch in an isolated worktree on a new branch, then run validation commands')
    .argument('<fix-id>', 'fix id or unique prefix')
    .addOption(approveOption())
    .option('--skip-validation', 'do not run the validation commands from ai-review.yaml')
    .action(async (id: string, options: ApproveOption & { skipValidation?: boolean }, command: Command) => {
      const ctx = await loadFixContext(io, command);
      const record = await ctx.store.findFix(id);
      requireStatus(record, 'proposed', 'fix apply');
      const p = record.proposal;
      if (sha256Hex(p.patch) !== p.patchSha256)
        throw new CliError('Stored patch does not match its hash; propose the fix again.');

      let commands: CommandArgv[] = [];
      if (!options.skipValidation) {
        const { config } = await loadRepositoryConfig(ctx.provider);
        try {
          commands = config.fixes.validation.commands.map(parseCommand);
        } catch (error) {
          throw new CliError(
            `ai-review.yaml fixes.validation: ${error instanceof CommandPolicyError ? error.message : 'invalid command'}`,
          );
        }
      }
      const operation: ApprovalOperation = {
        kind: 'apply_fix',
        fixId: p.id,
        filePath: p.filePath,
        branch: record.branch,
        validationCommands: commands,
      };
      renderPatch(io, p.patch);
      const approval = await obtainApproval(
        await approvalContext(io, ctx, record, options.approve),
        operation,
        p.patchSha256,
      );

      const root = (await ctx.provider.getRepositoryInfo()).rootPath;
      let workspace: LocalFixWorkspace | undefined;
      try {
        workspace = await LocalFixWorkspace.create({
          repoRoot: root,
          gitDirectory: ctx.gitDirectory,
          fixId: p.id,
          branch: record.branch,
          baseSha: p.baseSha,
        });
        await workspace.applyPatch(p.patch);
        if ((await workspace.fileSha256(p.filePath)) !== p.resultSha256) {
          throw new CliError('The applied file does not match the approved result.');
        }
      } catch (error) {
        await workspace?.discard({ deleteBranch: true }).catch(() => undefined);
        await finishApproval(ctx.store, approval, {
          ok: false,
          result: { error: error instanceof Error ? error.message.slice(0, 300) : 'failed' },
        });
        throw toCliError(error);
      }
      io.out(
        `${paint(io, 'green', '✔')} Applied in ${workspace.directory} on branch ${record.branch}. Your checkout was not touched.`,
      );

      const validation = [];
      for (const argv of commands) {
        io.out(paint(io, 'dim', `$ ${argv.join(' ')}`));
        const result = await runValidationCommand(argv, { cwd: workspace.directory, env: io.env });
        validation.push({
          argv: [...argv],
          passed: result.passed,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        });
        io.out(
          `${result.passed ? paint(io, 'green', '✔ passed') : paint(io, 'red', result.timedOut ? '✖ timed out' : `✖ failed (exit ${result.exitCode})`)} ${argv.join(' ')}`,
        );
        if (!result.passed)
          for (const line of result.output.split('\n').slice(-30)) io.out(paint(io, 'dim', `  ${line}`));
      }
      await ctx.store.saveFix({ ...record, status: 'applied', validation });
      const allPassed = validation.every((v) => v.passed);
      await finishApproval(ctx.store, approval, {
        ok: true,
        result: { branch: record.branch, validationPassed: allPassed, commands: validation.length },
      });
      if (!allPassed)
        io.out(paint(io, 'yellow', 'Validation failed — inspect the worktree before staging, or discard the fix.'));
      io.out(`Next: ${paint(io, 'cyan', `ai-review fix stage ${p.id.slice(0, 8)}`)}`);
    });

  fix
    .command('stage')
    .description('stage the applied fix in its worktree (approval required)')
    .argument('<fix-id>', 'fix id or unique prefix')
    .addOption(approveOption())
    .action(async (id: string, options: ApproveOption, command: Command) => {
      const ctx = await loadFixContext(io, command);
      const record = await ctx.store.findFix(id);
      requireStatus(record, 'applied', 'fix stage');
      const workspace = await openWorkspace(ctx, record);
      await assertWorktreeState(workspace, record, 'unstaged');
      const approval = await obtainApproval(
        await approvalContext(io, ctx, record, options.approve),
        { kind: 'stage_changes', fixId: record.proposal.id, branch: record.branch, paths: [record.proposal.filePath] },
        record.proposal.patchSha256,
      );
      await runStep(ctx, approval, async () => {
        await assertWorktreeState(workspace, record, 'unstaged');
        await workspace.stage([record.proposal.filePath]);
        await ctx.store.saveFix({ ...record, status: 'staged' });
        return { staged: [record.proposal.filePath] };
      });
      io.out(
        `${paint(io, 'green', '✔')} Staged ${record.proposal.filePath}. Next: ${paint(io, 'cyan', `ai-review fix commit ${record.proposal.id.slice(0, 8)}`)}`,
      );
    });

  fix
    .command('commit')
    .description('commit the staged fix on its branch (approval required)')
    .argument('<fix-id>', 'fix id or unique prefix')
    .option('--message <message>', 'commit message (default: generated from the finding)')
    .addOption(approveOption())
    .action(async (id: string, options: ApproveOption & { message?: string }, command: Command) => {
      const ctx = await loadFixContext(io, command);
      const record = await ctx.store.findFix(id);
      requireStatus(record, 'staged', 'fix commit');
      const workspace = await openWorkspace(ctx, record);
      await assertWorktreeState(workspace, record, 'staged');
      const message =
        options.message?.trim() || fixCommitMessage({ finding: record.finding, proposal: record.proposal });
      const parentSha = await workspace.head();
      const approval = await obtainApproval(
        await approvalContext(io, ctx, record, options.approve),
        { kind: 'commit_changes', fixId: record.proposal.id, branch: record.branch, message, parentSha },
        record.proposal.patchSha256,
      );
      const commitSha = await runStep(ctx, approval, async () => {
        await assertWorktreeState(workspace, record, 'staged');
        if ((await workspace.head()) !== parentSha) throw new CliError('The fix branch moved since approval.');
        const sha = await workspace.commit(message);
        await ctx.store.saveFix({ ...record, status: 'committed', commitSha: sha });
        return { commitSha: sha };
      });
      io.out(
        `${paint(io, 'green', '✔')} Committed ${String(commitSha['commitSha']).slice(0, 12)} on ${record.branch}. Next: ${paint(io, 'cyan', `ai-review fix push ${record.proposal.id.slice(0, 8)}`)}`,
      );
    });

  fix
    .command('push')
    .description('push the fix branch (exact commit, never forced) to a remote (approval required)')
    .argument('<fix-id>', 'fix id or unique prefix')
    .option('--remote <name>', 'remote to push to', 'origin')
    .addOption(approveOption())
    .action(async (id: string, options: ApproveOption & { remote: string }, command: Command) => {
      const ctx = await loadFixContext(io, command);
      const record = await ctx.store.findFix(id);
      requireStatus(record, 'committed', 'fix push');
      const workspace = await openWorkspace(ctx, record);
      if (!(await workspace.remoteUrl(options.remote)))
        throw new CliError(`Remote "${options.remote}" does not exist.`);
      const commitSha = record.commitSha ?? '';
      const approval = await obtainApproval(
        await approvalContext(io, ctx, record, options.approve),
        { kind: 'push_branch', fixId: record.proposal.id, branch: record.branch, remote: options.remote, commitSha },
        record.proposal.patchSha256,
      );
      await runStep(ctx, approval, async () => {
        await workspace.push(options.remote, commitSha);
        await ctx.store.saveFix({ ...record, status: 'pushed', pushedTo: options.remote });
        return { remote: options.remote, branch: record.branch, commitSha };
      });
      io.out(
        `${paint(io, 'green', '✔')} Pushed ${record.branch} to ${options.remote}. Next: ${paint(io, 'cyan', `ai-review fix open ${record.proposal.id.slice(0, 8)}`)}`,
      );
    });

  fix
    .command('open')
    .description(
      'open a GitLab merge request / GitHub pull request for the pushed fix (approval required; never merged)',
    )
    .argument('<fix-id>', 'fix id or unique prefix')
    .option('--target <branch>', 'target branch (default: the reviewed branch)')
    .addOption(
      new Option('--host <provider>', 'hosting provider when it cannot be detected from the remote').choices([
        'gitlab',
        'github',
      ]),
    )
    .addOption(approveOption())
    .action(
      async (
        id: string,
        options: ApproveOption & { target?: string; host?: 'gitlab' | 'github' },
        command: Command,
      ) => {
        const ctx = await loadFixContext(io, command);
        const record = await ctx.store.findFix(id);
        requireStatus(record, 'pushed', 'fix open');
        const workspace = await openWorkspace(ctx, record);
        const url = await workspace.remoteUrl(record.pushedTo ?? 'origin');
        if (!url) throw new CliError('The remote the fix was pushed to no longer exists.');
        const remote = parseRemote(url);
        const hostProvider = options.host ?? detectHostProvider(remote.host);
        if (!hostProvider)
          throw new CliError(`Cannot tell whether ${remote.host} is GitLab or GitHub; pass --host gitlab|github.`);
        const tokenName = hostProvider === 'gitlab' ? 'GITLAB_TOKEN' : 'GITHUB_TOKEN';
        const token = io.env[tokenName];
        if (!token) throw new CliError(`Set ${tokenName} in the environment (never pass tokens as arguments).`, 2);
        const target = options.target ?? ctx.report.repository.branch;
        if (!target) throw new CliError('Pass --target <branch>: the reviewed commit was not on a branch.');

        const text = fixReviewRequestText({ finding: record.finding, proposal: record.proposal });
        const commitSha = record.commitSha ?? '';
        const kind = hostProvider === 'gitlab' ? 'create_merge_request' : 'create_pull_request';
        const approval = await obtainApproval(
          await approvalContext(io, ctx, record, options.approve),
          {
            kind,
            fixId: record.proposal.id,
            sourceBranch: record.branch,
            targetBranch: target,
            title: text.title,
            commitSha,
          },
          record.proposal.patchSha256,
        );
        const result = await runStep(ctx, approval, async () => {
          const writer = await deps.hostWriter({
            provider: hostProvider,
            host: remote.host,
            projectPath: remote.path,
            token,
          });
          if ((await writer.branchHead(record.branch)) !== commitSha) {
            throw new CliError(`The remote branch ${record.branch} is not at the approved commit.`);
          }
          const created = await writer.createReviewRequest({
            sourceBranch: record.branch,
            targetBranch: target,
            title: text.title,
            description: text.description,
          });
          await ctx.store.saveFix({
            ...record,
            status: 'opened',
            reviewRequest: { provider: hostProvider, id: created.id, url: created.webUrl },
          });
          return { url: created.webUrl, id: created.id };
        });
        io.out(`${paint(io, 'green', '✔')} Opened ${String(result['url'])} — it will not be merged automatically.`);
      },
    );

  fix
    .command('discard')
    .description('remove the fix worktree and local fix branch (your checkout and remotes are untouched)')
    .argument('<fix-id>', 'fix id or unique prefix')
    .action(async (id: string, _options: unknown, command: Command) => {
      const ctx = await loadFixContext(io, command);
      const record = await ctx.store.findFix(id);
      if (record.status !== 'proposed' && record.status !== 'discarded') {
        const workspace = await openWorkspace(ctx, record).catch(() => null);
        await workspace?.discard({ deleteBranch: record.status !== 'pushed' && record.status !== 'opened' });
      }
      for (const approval of await ctx.store.approvals()) {
        if (
          approval.operation.fixId === record.proposal.id &&
          (approval.status === 'pending' || approval.status === 'approved')
        ) {
          await ctx.store.saveApproval({ ...approval, status: 'invalidated', reason: 'fix discarded' });
        }
      }
      await ctx.store.saveFix({ ...record, status: 'discarded' });
      await ctx.store.audit({ action: 'fix.discarded', fixId: record.proposal.id });
      io.out(`Discarded fix ${record.proposal.id.slice(0, 8)}.`);
    });

  program
    .command('approvals')
    .description('list approval requests for fixes in this repository')
    .option('--all', 'include finished requests')
    .action(async (options: { all?: boolean }, command: Command) => {
      const ctx = await loadFixContext(io, command);
      const requests = await ctx.store.refreshApprovals(ctx.report.repository.headSha);
      const shown = options.all ? requests : requests.filter((r) => r.status === 'pending' || r.status === 'approved');
      if (shown.length === 0)
        io.out(options.all ? 'No approval requests.' : 'No open approval requests (use --all for history).');
      for (const r of shown) {
        io.out(
          `${r.id.slice(0, 8)}  ${r.status.padEnd(11)}  ${r.operation.kind.padEnd(20)}  fix ${r.operation.fixId.slice(0, 8)}  ${r.decidedBy ? `by ${r.decidedBy.display}` : `expires ${r.expiresAt}`}`,
        );
      }
    });
}

async function readText(
  provider: LocalGitProvider,
  path: string,
  revision: Parameters<LocalGitProvider['readFile']>[1],
): Promise<string | null> {
  const file = await provider.readFile(path, revision);
  if (!file) return null;
  if (file.isBinary || file.tooLarge) throw new CliError(`${path} is binary or too large for an automatic fix.`);
  return file.content;
}

/** The worktree must contain exactly the approved change — nothing more, nothing less. */
async function assertWorktreeState(
  workspace: LocalFixWorkspace,
  fix: FixRecord,
  expected: 'unstaged' | 'staged',
): Promise<void> {
  const { staged, unstaged } = await workspace.changedPaths();
  const path = fix.proposal.filePath;
  const ok =
    expected === 'unstaged'
      ? staged.length === 0 && unstaged.length === 1 && unstaged[0] === path
      : unstaged.length === 0 && staged.length === 1 && staged[0] === path;
  if (!ok || (await workspace.fileSha256(path)) !== fix.proposal.resultSha256) {
    throw new CliError(
      `The fix worktree no longer contains exactly the approved change to ${path}. Discard the fix and start again.`,
    );
  }
}

async function runStep(
  ctx: FixContext,
  approval: Parameters<typeof finishApproval>[1],
  step: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    const result = await step();
    await finishApproval(ctx.store, approval, { ok: true, result });
    return result;
  } catch (error) {
    await finishApproval(ctx.store, approval, {
      ok: false,
      result: { error: error instanceof Error ? error.message.slice(0, 300) : 'failed' },
    });
    throw toCliError(error);
  }
}
