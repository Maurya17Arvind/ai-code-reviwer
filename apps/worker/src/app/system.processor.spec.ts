import { HeartbeatResultSchema, SystemJobName } from '@acra/queue';
import { type Job, UnrecoverableError } from 'bullmq';
import { SystemProcessor } from './system.processor';

const fakeJob = (name: string, data: unknown) => ({ id: '1', name, data }) as unknown as Job;

describe('SystemProcessor', () => {
  const processor = new SystemProcessor();

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
