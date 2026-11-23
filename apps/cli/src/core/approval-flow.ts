import {
  type Actor,
  type ApprovalOperation,
  type ApprovalRequest,
  ApprovalError,
  approvalCode,
  approve,
  beginExecution,
  canonicalJson,
  completeExecution,
  createApprovalRequest,
  describeOperation,
  reject,
} from '@acra/approvals';
import { userInfo } from 'node:os';
import { CliError, type CliIO, paint } from './cli-context';
import { type LocalFixStore } from './fix-store';

/** Exit code when an approval is required but could not be asked for (non-interactive). */
export const EXIT_APPROVAL_REQUIRED = 4;

export interface ApprovalContext {
  readonly io: CliIO;
  readonly store: LocalFixStore;
  readonly repositoryId: string;
  readonly reviewSessionId: string;
  /** Head commit of the latest review — approvals bound to another commit are invalid. */
  readonly currentHeadSha: string;
  readonly actor: Actor;
  /** `--approve <code>` from the command line, for non-interactive use. */
  readonly approveCode?: string;
}

/** The human at the terminal. Identity is recorded, not authenticated (it is their own repository). */
export function localActor(gitEmail: string | null): Actor {
  let user = 'unknown';
  try {
    user = userInfo().username;
  } catch {
    // no OS user information
  }
  return { kind: 'user', id: `local:${user}`, display: gitEmail ? `${user} <${gitEmail}>` : user };
}

/**
 * Obtains a human approval for exactly `operation` and returns the request in `executing` state.
 * Never auto-approves: either an interactive "yes", or `--approve <code>` where the code is derived
 * from the binding hash of a request that was shown earlier. AI output cannot reach this decision.
 */
export async function obtainApproval(
  context: ApprovalContext,
  operation: ApprovalOperation,
  patchSha256: string | null,
): Promise<ApprovalRequest> {
  const { io, store } = context;
  const now = new Date();
  const open = (await store.refreshApprovals(context.currentHeadSha, now)).filter(
    (r) =>
      r.status === 'pending' &&
      r.headSha === context.currentHeadSha &&
      r.patchSha256 === patchSha256 &&
      canonicalJson(r.operation) === canonicalJson(operation),
  );
  let request = open.at(-1);
  if (!request) {
    request = createApprovalRequest({
      organizationId: null,
      repositoryId: context.repositoryId,
      reviewSessionId: context.reviewSessionId,
      headSha: context.currentHeadSha,
      operation,
      patchSha256,
      requestedBy: context.actor,
      now,
    });
    await store.saveApproval(request);
    await store.audit({
      action: 'approval.requested',
      approvalId: request.id,
      fixId: operation.fixId,
      operation: operation.kind,
      actor: context.actor.id,
    });
  }

  const code = approvalCode(request);
  io.out(paint(io, 'bold', 'Approval required'));
  for (const line of describeOperation(operation)) io.out(`  ${line}`);
  io.out(
    paint(
      io,
      'dim',
      `  Bound to review ${request.reviewSessionId.slice(0, 8)} at ${request.headSha.slice(0, 12)}${patchSha256 ? `, patch sha256 ${patchSha256.slice(0, 12)}` : ''}; expires ${request.expiresAt}`,
    ),
  );
  io.out(`  Approval code: ${paint(io, 'cyan', code)}`);

  let decided: ApprovalRequest;
  try {
    if (context.approveCode !== undefined) {
      if (context.approveCode.trim().toLowerCase() !== code) {
        throw new CliError('The approval code does not match this request (it may have changed). Nothing was done.');
      }
      decided = approve(request, {
        actor: context.actor,
        role: null,
        now: new Date(),
        currentHeadSha: context.currentHeadSha,
      });
    } else if (io.confirm) {
      if (!(await io.confirm('Approve this operation?'))) {
        const rejected = reject(
          request,
          { actor: context.actor, role: null, now: new Date() },
          'declined at the prompt',
        );
        await store.saveApproval(rejected);
        await store.audit({
          action: 'approval.rejected',
          approvalId: request.id,
          fixId: operation.fixId,
          actor: context.actor.id,
        });
        throw new CliError('Not approved. Nothing was changed.', 1);
      }
      decided = approve(request, {
        actor: context.actor,
        role: null,
        now: new Date(),
        currentHeadSha: context.currentHeadSha,
      });
    } else {
      throw new CliError(
        `No interactive terminal. To approve exactly this operation, re-run with --approve ${code}`,
        EXIT_APPROVAL_REQUIRED,
      );
    }
  } catch (error) {
    if (error instanceof ApprovalError) throw new CliError(error.message);
    throw error;
  }
  await store.saveApproval(decided);
  await store.audit({
    action: 'approval.approved',
    approvalId: decided.id,
    fixId: operation.fixId,
    actor: context.actor.id,
  });

  try {
    const executing = beginExecution(decided, {
      now: new Date(),
      currentHeadSha: context.currentHeadSha,
      patchSha256,
    });
    await store.saveApproval(executing);
    return executing;
  } catch (error) {
    if (error instanceof ApprovalError) throw new CliError(error.message);
    throw error;
  }
}

/** Records the outcome of an executed approval (single use: it can never run again). */
export async function finishApproval(
  store: LocalFixStore,
  request: ApprovalRequest,
  outcome: { ok: boolean; result: Record<string, unknown> },
): Promise<void> {
  const done = completeExecution(request, outcome, new Date());
  await store.saveApproval(done);
  await store.audit({
    action: outcome.ok ? 'approval.executed' : 'approval.failed',
    approvalId: request.id,
    fixId: request.operation.fixId,
    operation: request.operation.kind,
    result: outcome.result,
  });
}
