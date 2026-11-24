import { DatabaseHealth } from '@acra/database';
import { bearerMatches } from '@acra/observability';
import { QueueHealth } from '@acra/queue';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { WORKER_CONFIG, type WorkerConfig } from '../worker-config';
import { WorkerMetrics } from './worker-metrics';

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Small HTTP server of the worker (ADR-009, Phase 8): GET /health/live, GET /health/ready
 * (PostgreSQL + Redis) and GET /metrics (bearer METRICS_TOKEN). Binds to 127.0.0.1 by default; it
 * serves no tenant data.
 */
@Injectable()
export class WorkerHttpServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerHttpServer.name);
  private server: Server | undefined;

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(DatabaseHealth) private readonly database: DatabaseHealth,
    @Inject(QueueHealth) private readonly redis: QueueHealth,
    @Inject(WorkerMetrics) private readonly metrics: WorkerMetrics,
  ) {}

  /** Bound port (useful with WORKER_HTTP_PORT=0). */
  get port(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? (address as AddressInfo).port : null;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req.method ?? 'GET', req.url ?? '/', req.headers.authorization)
        .then(({ status, body, type }) => {
          res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"status":"error"}');
        });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.config.WORKER_HTTP_PORT, this.config.WORKER_HTTP_HOST, () => resolve());
    });
    this.logger.log(`Worker health and metrics on http://${this.config.WORKER_HTTP_HOST}:${this.port ?? '?'}`);
  }

  async onApplicationShutdown(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(method: string, url: string, authorization: string | undefined) {
    const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body), type: 'application/json' });
    if (method !== 'GET') return json(405, { status: 'method not allowed' });
    const path = url.split('?')[0];
    if (path === '/health/live') return json(200, { status: 'ok', timestamp: new Date().toISOString() });
    if (path === '/health/ready') {
      const checks = await Promise.all([
        this.probe('database', () => this.database.ping()),
        this.probe('redis', () => this.redis.ping()),
      ]);
      const ok = checks.every((c) => c.status === 'up');
      return json(ok ? 200 : 503, { status: ok ? 'ok' : 'unavailable', timestamp: new Date().toISOString(), checks });
    }
    if (path === '/metrics') {
      if (!this.config.METRICS_TOKEN) return json(404, { status: 'not found' });
      if (!bearerMatches(authorization, this.config.METRICS_TOKEN)) return json(401, { status: 'unauthorized' });
      return {
        status: 200,
        body: await this.metrics.registry.render(),
        type: 'text/plain; version=0.0.4; charset=utf-8',
      };
    }
    return json(404, { status: 'not found' });
  }

  private async probe(name: 'database' | 'redis', run: () => Promise<void>) {
    const started = performance.now();
    try {
      await Promise.race([
        run(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS).unref()),
      ]);
      return { name, status: 'up' as const, latencyMs: Math.round(performance.now() - started) };
    } catch {
      return { name, status: 'down' as const, latencyMs: Math.round(performance.now() - started) };
    }
  }
}
