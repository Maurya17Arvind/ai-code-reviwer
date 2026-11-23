import { type Actor, approvalCode, computeBindingHash, createApprovalRequest } from './approval-request';
import { assertKnownOperation, fixBranchName, type ApprovalOperation, describeOperation } from './operations';
import {
  approve,
  beginExecution,
  completeExecution,
  expire,
  invalidate,
  obsoleteForHead,
  reject,
} from './state-machine';

const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const PATCH = 'c'.repeat(64);
const human: Actor = { kind: 'user', id: 'u-1', display: 'Dev <dev@example.com>' };
const system: Actor = { kind: 'system', id: 'worker', display: 'worker' };
const t0 = new Date('2026-11-23T10:00:00Z');
const later = (ms: number) => new Date(t0.getTime() + ms);

const applyOp: ApprovalOperation = {
  kind: 'apply_fix',
  fixId: '0195f3c2-aaaa-bbbb-cccc-ddddeeeeffff',
  filePath: 'src/cart.ts',
  branch: fixBranchName('0195f3c2-aaaa-bbbb-cccc-ddddeeeeffff'),
  validationCommands: [['pnpm', 'test']],
};

const request = (overrides: Partial<Parameters<typeof createApprovalRequest>[0]> = {}) =>
  createApprovalRequest({
    organizationId: 'org-1',
    repositoryId: 'repo-1',
    reviewSessionId: 'session-1',
    headSha: HEAD,
    operation: applyOp,
    patchSha256: PATCH,
    requestedBy: system,
    now: t0,
    ...overrides,
  });

describe('approval requests', () => {
  it('binds user, org, repository, session, commit, operation, patch and expiry into one hash', () => {
    const r = request();
    expect(r).toMatchObject({ status: 'pending', expiresAt: '2026-11-24T10:00:00.000Z' });
    expect(r.bindingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(approvalCode(r)).toHaveLength(12);
    for (const changed of [
      { ...r, headSha: NEW_HEAD },
      { ...r, patchSha256: 'd'.repeat(64) },
      {
        ...r,
        operation: {
          ...applyOp,
          validationCommands: [
            ['pnpm', 'test'],
            ['pnpm', 'lint'],
          ],
        },
      },
      { ...r, expiresAt: '2026-12-31T00:00:00.000Z' },
      { ...r, organizationId: 'org-2' },
    ]) {
      expect(computeBindingHash(changed)).not.toBe(r.bindingHash);
    }
  });

  it('requires a full commit SHA and a patch hash for fix operations; clamps the TTL', () => {
    expect(() => request({ headSha: 'main' })).toThrow(/full commit SHA/);
    expect(() => request({ patchSha256: null })).toThrow(/patch SHA-256/);
    expect(request({ ttlMs: 365 * 24 * 3600 * 1000 }).expiresAt).toBe('2026-11-30T10:00:00.000Z');
  });

  it('never knows a merge operation and only accepts generated fix branches', () => {
    expect(() => assertKnownOperation('merge')).toThrow(/Merging is disabled/);
    expect(() => assertKnownOperation('merge_pull_request_merge')).toThrow(/Merging is disabled/);
    expect(() => assertKnownOperation('create_pull_request')).not.toThrow();
    expect(() => request({ operation: { ...applyOp, branch: 'main' } })).toThrow(/not a fix branch/);
    expect(
      describeOperation({
        kind: 'create_pull_request',
        fixId: 'x',
        sourceBranch: applyOp.branch,
        targetBranch: 'main',
        title: 'Fix',
        commitSha: HEAD,
      }).join(' '),
    ).toMatch(/NOT be merged/);
  });
});

describe('approval state machine', () => {
  const decide = { actor: human, role: 'MEMBER', now: later(1000), currentHeadSha: HEAD };

  it('pending → approved → executing → executed, single use', () => {
    const approved = approve(request(), decide);
    expect(approved).toMatchObject({ status: 'approved', decidedBy: human });
    const executing = beginExecution(approved, { now: later(2000), currentHeadSha: HEAD, patchSha256: PATCH });
    expect(executing.status).toBe('executing');
    expect(() => beginExecution(executing, { now: later(2000), currentHeadSha: HEAD, patchSha256: PATCH })).toThrow(
      /executing/,
    );
    expect(completeExecution(executing, { ok: true, result: { branch: applyOp.branch } }, later(3000)).status).toBe(
      'executed',
    );
  });

  it('only humans with a deciding role can approve or reject', () => {
    expect(() => approve(request(), { ...decide, actor: system })).toThrow(/human/);
    expect(() => approve(request(), { ...decide, role: 'VIEWER' })).toThrow(/VIEWER/);
    expect(reject(request(), { actor: human, role: 'ADMIN', now: later(1) }, 'not needed')).toMatchObject({
      status: 'rejected',
      reason: 'not needed',
    });
    expect(() => approve(reject(request(), { actor: human, role: null, now: later(1) }), decide)).toThrow(/rejected/);
  });

  it('refuses expired requests, a changed reviewed commit, a different patch, and tampering', () => {
    const r = request();
    expect(() => approve(r, { ...decide, now: later(25 * 3600 * 1000) })).toThrow(/expired/);
    expect(() => approve(r, { ...decide, currentHeadSha: NEW_HEAD })).toThrow(/changed/);
    expect(() => approve({ ...r, patchSha256: 'e'.repeat(64) }, decide)).toThrow(/modified/);

    const approved = approve(r, decide);
    const ctx = { now: later(2000), currentHeadSha: HEAD, patchSha256: PATCH };
    expect(() => beginExecution(approved, { ...ctx, currentHeadSha: NEW_HEAD })).toThrow(/changed/);
    expect(() => beginExecution(approved, { ...ctx, patchSha256: 'f'.repeat(64) })).toThrow(/differs/);
    expect(() => beginExecution(approved, { ...ctx, now: later(48 * 3600 * 1000) })).toThrow(/expired/);
    expect(() => beginExecution(r, ctx)).toThrow(/pending/);
    expect(() =>
      beginExecution({ ...approved, operation: { ...applyOp, validationCommands: [['rm', '-rf', '/']] } }, ctx),
    ).toThrow(/modified/);
  });

  it('expires and invalidates open requests when the reviewed commit moves', () => {
    const open = [request(), approve(request(), decide), request({ headSha: NEW_HEAD })];
    const obsolete = obsoleteForHead(open, NEW_HEAD);
    expect(obsolete).toHaveLength(2);
    expect(obsolete.map((r) => invalidate(r, 'new commit').status)).toEqual(['invalidated', 'invalidated']);
    expect(() => expire(request(), later(1000))).toThrow(/not expired/);
    expect(expire(request(), later(25 * 3600 * 1000)).status).toBe('expired');
  });
});
