import { ReadinessResponseSchema } from '@acra/shared-contracts';
import { type DependencyProbe, HealthService } from './health.service';

const up: DependencyProbe = { ping: () => Promise.resolve() };
const failing: DependencyProbe = { ping: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')) };
const hanging: DependencyProbe = { ping: () => new Promise<void>(() => undefined) };

describe('HealthService', () => {
  it('reports ok when every dependency responds', async () => {
    const result = await new HealthService(up, up, 100).readiness();
    expect(ReadinessResponseSchema.parse(result)).toEqual(result);
    expect(result.status).toBe('ok');
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ['database', 'up'],
      ['redis', 'up'],
    ]);
  });

  it('reports unavailable with a coarse reason when a dependency fails', async () => {
    const result = await new HealthService(failing, up, 100).readiness();
    expect(result.status).toBe('unavailable');
    expect(result.checks[0]).toMatchObject({ name: 'database', status: 'down', reason: 'error' });
    // Driver error details (hosts, ports) must not leak into the response.
    expect(JSON.stringify(result)).not.toContain('10.0.0.5');
  });

  it('times out hanging dependencies', async () => {
    const result = await new HealthService(up, hanging, 20).readiness();
    expect(result.status).toBe('unavailable');
    expect(result.checks[1]).toMatchObject({ name: 'redis', status: 'down', reason: 'timeout' });
    expect(result.checks[1]?.latencyMs).toBeGreaterThanOrEqual(15);
  });
});
