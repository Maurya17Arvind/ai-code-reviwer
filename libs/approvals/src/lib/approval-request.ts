import { createHash, randomUUID } from 'node:crypto';
import { type ApprovalOperation, validateOperation } from './operations';

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'invalidated',
  'executing',
  'executed',
  'failed',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Who acted. `kind: 'user'` for humans; only humans can approve or reject. */
export interface Actor {
  readonly kind: 'user' | 'system';
  /** Stable id: database user id, or "local:<os user>" for the CLI. */
  readonly id: string;
  readonly display: string;
}

/** Everything an approval is bound to (Module H). Changing any field changes the binding hash. */
export interface ApprovalBinding {
  readonly organizationId: string | null;
  readonly repositoryId: string;
  readonly reviewSessionId: string;
  /** The reviewed commit. A newer reviewed commit invalidates the request. */
  readonly headSha: string;
  readonly operation: ApprovalOperation;
  /** SHA-256 of the exact patch, when the operation writes a fix. */
  readonly patchSha256: string | null;
  readonly requestedBy: Actor;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ApprovalRequest extends ApprovalBinding {
  readonly id: string;
  readonly bindingHash: string;
  readonly status: ApprovalStatus;
  readonly decidedBy?: Actor;
  readonly decidedAt?: string;
  readonly reason?: string;
  readonly executedAt?: string;
  /** Short, safe result summary (commit sha, MR URL, validation outcome) or error message. */
  readonly result?: Readonly<Record<string, unknown>>;
}

export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class ApprovalError extends Error {
  constructor(
    readonly code:
      | 'invalid_transition'
      | 'expired'
      | 'binding_mismatch'
      | 'head_changed'
      | 'patch_mismatch'
      | 'not_authorized'
      | 'invalid_request',
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

/** Canonical JSON: sorted keys, no whitespace — the same binding always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function computeBindingHash(binding: ApprovalBinding): string {
  const fields: ApprovalBinding = {
    organizationId: binding.organizationId,
    repositoryId: binding.repositoryId,
    reviewSessionId: binding.reviewSessionId,
    headSha: binding.headSha,
    operation: binding.operation,
    patchSha256: binding.patchSha256,
    requestedBy: binding.requestedBy,
    createdAt: binding.createdAt,
    expiresAt: binding.expiresAt,
  };
  return createHash('sha256').update(canonicalJson(fields), 'utf8').digest('hex');
}

/** Short code a human types to approve non-interactively; proves they saw this exact request. */
export function approvalCode(request: Pick<ApprovalRequest, 'bindingHash'>): string {
  return request.bindingHash.slice(0, 12);
}

export function createApprovalRequest(
  input: Omit<ApprovalBinding, 'createdAt' | 'expiresAt'> & { ttlMs?: number; now?: Date; id?: string },
): ApprovalRequest {
  validateOperation(input.operation);
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(input.headSha)) {
    throw new ApprovalError('invalid_request', 'Approval must be bound to a full commit SHA');
  }
  const writesPatch = input.operation.kind === 'apply_fix' || input.operation.kind === 'commit_and_push_fix';
  if (writesPatch && !/^[0-9a-f]{64}$/.test(input.patchSha256 ?? '')) {
    throw new ApprovalError('invalid_request', 'A fix operation must be bound to the patch SHA-256');
  }
  const ttl = Math.min(Math.max(input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS, 60_000), MAX_APPROVAL_TTL_MS);
  const now = input.now ?? new Date();
  const binding: ApprovalBinding = {
    organizationId: input.organizationId,
    repositoryId: input.repositoryId,
    reviewSessionId: input.reviewSessionId,
    headSha: input.headSha,
    operation: input.operation,
    patchSha256: input.patchSha256,
    requestedBy: input.requestedBy,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  };
  return { ...binding, id: input.id ?? randomUUID(), bindingHash: computeBindingHash(binding), status: 'pending' };
}
