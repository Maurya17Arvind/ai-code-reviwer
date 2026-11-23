import { DatabaseHealth } from '@acra/database';
import { QueueHealth } from '@acra/queue';
import { type DependencyCheck, type DependencyName, type ReadinessResponse } from '@acra/shared-contracts';
import { Inject, Injectable, Logger } from '@nestjs/common';

export const HEALTH_PROBE_TIMEOUT_MS = Symbol('HEALTH_PROBE_TIMEOUT_MS');

class ProbeTimeoutError extends Error {}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal probe contract so the service can be unit-tested without real infrastructure. */
export interface DependencyProbe {
  ping(): Promise<void>;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(DatabaseHealth) private readonly database: DependencyProbe,
    @Inject(QueueHealth) private readonly redis: DependencyProbe,
    @Inject(HEALTH_PROBE_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {}

  async readiness(): Promise<ReadinessResponse> {
    const checks = await Promise.all([this.probe('database', this.database), this.probe('redis', this.redis)]);
    return {
      status: checks.every((check) => check.status === 'up') ? 'ok' : 'unavailable',
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  private async probe(name: DependencyName, dependency: DependencyProbe): Promise<DependencyCheck> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    try {
      await withTimeout(dependency.ping(), this.timeoutMs);
      return { name, status: 'up', latencyMs: elapsed() };
    } catch (error) {
      const reason = error instanceof ProbeTimeoutError ? 'timeout' : 'error';
      // Details stay in server logs (redacted); clients only see the coarse reason.
      this.logger.warn({ err: error, dependency: name, reason }, 'Readiness probe failed');
      return { name, status: 'down', latencyMs: elapsed(), reason };
    }
  }
}
