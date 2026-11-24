import { type MaintenanceStore } from '@acra/database';
import { HeartbeatResultSchema, SystemJobName } from '@acra/queue';
import { type Job, UnrecoverableError } from 'bullmq';
import { WorkerMetrics } from './ops/worker-metrics';
import { SystemProcessor } from './system.processor';
import { type WorkerConfig } from './worker-config';

const fakeJob = (name: string, data: unknown) => ({ id: '1', name, data }) as unknown as Job;

describe('SystemProcessor', () => {
  const runs: Array<{ stuckAfterMs: number; retentionMs: number }> = [];
  const store = {
    run: (input: { now: Date; stuckAfterMs: number; retentionMs: number }) => {
      runs.push(input);
      return Promise.resolve({ stuckReviewsFailed: 2, approvalsExpired: 1, sessionsPurged: 0, setupTokensPurged: 0 });
    },
  } as unknown as MaintenanceStore;
  const metrics = new WorkerMetrics();
  const processor = new SystemProcessor(store, metrics, { AI_REVIEW_TIMEOUT_MS: 1_200_000 } as WorkerConfig);

  it('runs maintenance with a stuck threshold of twice the AI timeout and counts recoveries', async () => {
    const result = await processor.process(fakeJob(SystemJobName.Maintenance, {}));
    expect(result).toMatchObject({ stuckReviewsFailed: 2, approvalsExpired: 1 });
    expect(runs[0]?.stuckAfterMs).toBe(2_400_000);
    expect(await metrics.registry.render()).toContain('acra_maintenance_actions_total{action="stuckReviewsFailed"} 2');
  });

  it('processes a valid heartbeat', async () => {
    const correlationId = '0193a0d2-6b1e-7c3a-9f00-123456789abc';
    const result = await processor.process(
      fakeJob(SystemJobName.Heartbeat, { correlationId, requestedAt: new Date().toISOString(), source: 'test' }),
    );
    expect(HeartbeatResultSchema.parse(result).correlationId).toBe(correlationId);
  });

  it('fails permanently on malformed payloads', async () => {
    await expect(processor.process(fakeJob(SystemJobName.Heartbeat, { correlationId: 'nope' }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('fails permanently on unknown job names', async () => {
    await expect(processor.process(fakeJob('rm -rf', {}))).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
