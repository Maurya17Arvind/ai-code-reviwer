import { Inject, Injectable } from '@nestjs/common';
import { type PrismaClient } from '../../generated/prisma/client';
import { PRISMA_CLIENT } from '../tokens';

export interface MaintenanceResult {
  readonly stuckReviewsFailed: number;
  readonly approvalsExpired: number;
  readonly sessionsPurged: number;
  readonly setupTokensPurged: number;
}

/**
 * Periodic recovery and housekeeping across all tenants (Phase 8). Every statement is a bounded,
 * idempotent compare-and-set, so concurrent workers can run it safely. Audit logs are never touched.
 */
@Injectable()
export class MaintenanceStore {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async run(input: { now: Date; stuckAfterMs: number; retentionMs: number }): Promise<MaintenanceResult> {
    const stuckBefore = new Date(input.now.getTime() - input.stuckAfterMs);
    const purgeBefore = new Date(input.now.getTime() - input.retentionMs);

    // A worker that crashed or was killed mid-review leaves the session RUNNING forever. BullMQ
    // retries stalled jobs on its own; a later retry of the same commit can still start again,
    // because FAILED is not a terminal status for beginSession.
    const stuck = await this.prisma.reviewSession.updateMany({
      where: {
        status: 'RUNNING',
        OR: [{ startedAt: { lt: stuckBefore } }, { startedAt: null, createdAt: { lt: stuckBefore } }],
      },
      data: {
        status: 'FAILED',
        finishedAt: input.now,
        errorCode: 'worker_interrupted',
        errorMessage: 'The review did not finish (worker restarted or crashed). Push a new commit to review again.',
      },
    });

    // Approvals past their expiry can never be decided or executed; make that visible.
    const expired = await this.prisma.approvalRequest.updateMany({
      where: { status: { in: ['PENDING', 'APPROVED'] }, expiresAt: { lt: input.now } },
      data: { status: 'EXPIRED', reason: 'Expired before it was decided or executed' },
    });

    const sessions = await this.prisma.userSession.deleteMany({
      where: { OR: [{ expiresAt: { lt: purgeBefore } }, { revokedAt: { lt: purgeBefore } }] },
    });
    const tokens = await this.prisma.userSetupToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: purgeBefore } }, { usedAt: { lt: purgeBefore } }] },
    });

    if (stuck.count + expired.count > 0) {
      await this.prisma.auditLog.create({
        data: {
          organizationId: null,
          actorType: 'SYSTEM',
          action: 'maintenance.recovered',
          targetType: 'system',
          metadata: { stuckReviewsFailed: stuck.count, approvalsExpired: expired.count },
        },
      });
    }
    return {
      stuckReviewsFailed: stuck.count,
      approvalsExpired: expired.count,
      sessionsPurged: sessions.count,
      setupTokensPurged: tokens.count,
    };
  }
}
