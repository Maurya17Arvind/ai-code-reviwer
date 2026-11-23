import {
  type Actor,
  ApprovalError,
  type ApprovalRequest,
  type ApprovalStatus,
  computeBindingHash,
} from './approval-request';

/**
 * Approval state machine (Module H):
 *
 *   pending ──approve──▶ approved ──begin──▶ executing ──▶ executed | failed
 *      │ │                 │ │
 *      │ └─reject─▶ rejected │
 *      └──── expire / invalidate ────▶ expired | invalidated
 *
 * Every function is pure and returns a new request. Persistence layers must apply transitions with
 * a compare-and-set on the previous status, so an approval is consumed exactly once.
 */
export const TERMINAL_STATUSES: ReadonlySet<ApprovalStatus> = new Set([
  'rejected',
  'expired',
  'invalidated',
  'executed',
  'failed',
]);

/** Organization roles allowed to approve or reject. VIEWERs and the system never can. */
export const DECIDING_ROLES: ReadonlySet<string> = new Set(['OWNER', 'ADMIN', 'MEMBER']);

export function isExpired(request: Pick<ApprovalRequest, 'expiresAt'>, now: Date): boolean {
  return now.getTime() >= Date.parse(request.expiresAt);
}

function assertStatus(request: ApprovalRequest, allowed: readonly ApprovalStatus[], action: string): void {
  if (!allowed.includes(request.status)) {
    throw new ApprovalError('invalid_transition', `Cannot ${action} a request that is ${request.status}`);
  }
}

function assertHuman(actor: Actor, role: string | null): void {
  if (actor.kind !== 'user') throw new ApprovalError('not_authorized', 'Only a human user can decide approvals');
  if (role !== null && !DECIDING_ROLES.has(role)) {
    throw new ApprovalError('not_authorized', `Role ${role} may not approve or reject operations`);
  }
}

function assertBinding(request: ApprovalRequest): void {
  if (computeBindingHash(request) !== request.bindingHash) {
    throw new ApprovalError('binding_mismatch', 'Approval request was modified after it was created');
  }
}

export interface DecisionContext {
  readonly actor: Actor;
  /** Organization role of the actor; null for the local CLI (the repository owner at the terminal). */
  readonly role: string | null;
  readonly now: Date;
  /** Latest reviewed commit for this repository / request. */
  readonly currentHeadSha: string;
}

export function approve(request: ApprovalRequest, context: DecisionContext): ApprovalRequest {
  assertStatus(request, ['pending'], 'approve');
  assertHuman(context.actor, context.role);
  assertBinding(request);
  if (isExpired(request, context.now)) throw new ApprovalError('expired', 'Approval request has expired');
  if (request.headSha !== context.currentHeadSha) {
    throw new ApprovalError('head_changed', 'The reviewed commit changed; this request is no longer valid');
  }
  return { ...request, status: 'approved', decidedBy: context.actor, decidedAt: context.now.toISOString() };
}

export function reject(request: ApprovalRequest, context: Omit<DecisionContext, 'currentHeadSha'>, reason?: string) {
  assertStatus(request, ['pending'], 'reject');
  assertHuman(context.actor, context.role);
  return {
    ...request,
    status: 'rejected' as const,
    decidedBy: context.actor,
    decidedAt: context.now.toISOString(),
    ...(reason ? { reason: reason.slice(0, 500) } : {}),
  };
}

export function expire(request: ApprovalRequest, now: Date): ApprovalRequest {
  assertStatus(request, ['pending', 'approved'], 'expire');
  if (!isExpired(request, now)) throw new ApprovalError('invalid_transition', 'Request has not expired yet');
  return { ...request, status: 'expired' };
}

export function invalidate(request: ApprovalRequest, reason: string): ApprovalRequest {
  assertStatus(request, ['pending', 'approved'], 'invalidate');
  return { ...request, status: 'invalidated', reason: reason.slice(0, 500) };
}

export interface ExecutionContext {
  readonly now: Date;
  readonly currentHeadSha: string;
  /** SHA-256 of the patch that is about to be written (recomputed from storage, not trusted). */
  readonly patchSha256: string | null;
}

/**
 * The last gate before anything is written: approved, unmodified, unexpired, same reviewed commit,
 * same patch. Returns the request in `executing` state (single use).
 */
export function beginExecution(request: ApprovalRequest, context: ExecutionContext): ApprovalRequest {
  assertStatus(request, ['approved'], 'execute');
  assertBinding(request);
  if (!request.decidedBy || request.decidedBy.kind !== 'user') {
    throw new ApprovalError('not_authorized', 'Request was not approved by a human user');
  }
  if (isExpired(request, context.now)) throw new ApprovalError('expired', 'Approval has expired');
  if (request.headSha !== context.currentHeadSha) {
    throw new ApprovalError('head_changed', 'The reviewed commit changed after approval');
  }
  if (request.patchSha256 !== null && request.patchSha256 !== context.patchSha256) {
    throw new ApprovalError('patch_mismatch', 'The patch differs from the approved patch');
  }
  return { ...request, status: 'executing' };
}

export function completeExecution(
  request: ApprovalRequest,
  outcome: { ok: boolean; result: Record<string, unknown> },
  now: Date,
): ApprovalRequest {
  assertStatus(request, ['executing'], 'complete');
  return {
    ...request,
    status: outcome.ok ? 'executed' : 'failed',
    executedAt: now.toISOString(),
    result: outcome.result,
  };
}

/** Requests that a newly reviewed commit makes obsolete. */
export function obsoleteForHead<T extends Pick<ApprovalRequest, 'status' | 'headSha'>>(
  requests: readonly T[],
  newHeadSha: string,
): T[] {
  return requests.filter((r) => (r.status === 'pending' || r.status === 'approved') && r.headSha !== newHeadSha);
}
