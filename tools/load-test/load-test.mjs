#!/usr/bin/env node
/**
 * Dashboard API load test (Phase 8).
 *
 *   node tools/load-test/load-test.mjs --base http://127.0.0.1:3100 --findings 20000 --requests 2000 --concurrency 20
 *
 * Seeds one organization (reviews, findings, model executions, audit entries) directly in the
 * database given by DATABASE_URL (use a disposable database, never production), signs in through
 * the API, then sends concurrent requests to the main dashboard endpoints and prints latency
 * percentiles and throughput per endpoint. Run the API with RATE_LIMIT_ENABLED=false or high limits,
 * otherwise the limiter (correctly) answers 429.
 */
import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { parseArgs, promisify } from 'node:util';
import pg from 'pg';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:3100' },
    findings: { type: 'string', default: '20000' },
    requests: { type: 'string', default: '2000' },
    concurrency: { type: 'string', default: '20' },
  },
});
const BASE = args.base.replace(/\/+$/, '');
const FINDINGS = Number(args.findings);
const REQUESTS = Number(args.requests);
const CONCURRENCY = Number(args.concurrency);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (/prod/i.test(databaseUrl)) throw new Error('Refusing to seed a database whose URL mentions "prod"');

const PASSWORD = `load-test-${randomBytes(6).toString('hex')}`;
const email = `load-${randomUUID().slice(0, 8)}@example.com`;

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await promisify(scrypt)(password.normalize('NFKC'), salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 2 ** 17 * 8 });
  return ['scrypt', 2 ** 17, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
}

async function seed() {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const started = performance.now();
  try {
    const userId = randomUUID();
    const orgId = randomUUID();
    const repoId = randomUUID();
    await db.query('BEGIN');
    await db.query(
      `INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at) VALUES ($1, $2, 'Load Test', $3, now(), now())`,
      [userId, email, await hashPassword(PASSWORD)],
    );
    await db.query(`INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ($1, 'Load Test', $2, now(), now())`, [
      orgId,
      `load-${orgId.slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO organization_members (id, organization_id, user_id, role, created_at, updated_at) VALUES ($1, $2, $3, 'OWNER', now(), now())`,
      [randomUUID(), orgId, userId],
    );
    await db.query(
      `INSERT INTO repositories (id, organization_id, provider, external_id, full_name, created_at, updated_at)
       VALUES ($1, $2, 'GITLAB', $3, 'load/test', now(), now())`,
      [repoId, orgId, randomUUID()],
    );
    const sessions = Math.max(1, Math.round(FINDINGS / 10));
    await db.query(
      `INSERT INTO review_sessions (id, organization_id, repository_id, request_id, head_sha, status, idempotency_key, created_at, started_at, finished_at)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, (g % 500) + 1, md5(g::text) || md5((g + 1)::text), 'COMPLETED', 'load:' || $4::text || ':' || g,
              now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval
       FROM generate_series(1, $3) g`,
      [orgId, repoId, sessions, orgId],
    );
    await db.query(
      `INSERT INTO model_executions (id, organization_id, review_session_id, provider, model, status, input_tokens, output_tokens, cost_micros, latency_ms, created_at)
       SELECT gen_random_uuid(), s.organization_id, s.id, 'claude', 'claude-opus-5-5', 'succeeded', 3000, 600, 25000, 9000, s.created_at
       FROM review_sessions s WHERE s.organization_id = $1`,
      [orgId],
    );
    await db.query(
      `INSERT INTO review_findings (id, organization_id, repository_id, request_id, fingerprint, last_session_id, file_path, line_number,
                                    severity, category, title, description, evidence, confidence, sources, placement, status,
                                    first_seen_sha, last_seen_sha, created_at, updated_at)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, (g % 500) + 1, md5('fp' || g), s.id, 'src/file' || (g % 200) || '.ts', (g % 300) + 1,
              (ARRAY['critical','high','medium','low'])[(g % 4) + 1], (ARRAY['bug','security','performance','maintainability'])[(g % 4) + 1],
              'Finding ' || g, 'Description', 'Evidence', 0.9, ARRAY['claude'], 'inline',
              (ARRAY['PUBLISHED','RESOLVED','DISMISSED','FALSE_POSITIVE','VALIDATED'])[(g % 5) + 1]::finding_status,
              s.head_sha, s.head_sha, now() - (g || ' seconds')::interval, now()
       FROM generate_series(1, $3) g
       JOIN LATERAL (SELECT id, head_sha FROM review_sessions WHERE organization_id = $1::uuid ORDER BY created_at DESC OFFSET (g % $4) LIMIT 1) s ON true`,
      [orgId, repoId, FINDINGS, sessions],
    );
    await db.query(
      `INSERT INTO audit_logs (id, organization_id, actor_type, action, target_type, metadata, created_at)
       SELECT gen_random_uuid(), $1::uuid, 'SYSTEM', 'review.published', 'review_session', '{}', now() - (g || ' seconds')::interval
       FROM generate_series(1, $2) g`,
      [orgId, FINDINGS],
    );
    await db.query('COMMIT');
    await db.query('ANALYZE');
    console.log(`Seeded ${sessions} reviews, ${FINDINGS} findings, ${FINDINGS} audit entries in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    return orgId;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

async function login() {
  const response = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (response.status !== 200) throw new Error(`Sign-in failed: ${response.status}`);
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

async function run(name, url, cookie) {
  const latencies = [];
  const statuses = new Map();
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < REQUESTS) {
        next++;
        const t = performance.now();
        const response = await fetch(url, { headers: { cookie } });
        await response.arrayBuffer();
        latencies.push(performance.now() - t);
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    endpoint: name,
    requests: latencies.length,
    'req/s': Math.round(latencies.length / seconds),
    'p50 ms': Math.round(percentile(latencies, 50)),
    'p95 ms': Math.round(percentile(latencies, 95)),
    'p99 ms': Math.round(percentile(latencies, 99)),
    statuses: [...statuses].map(([s, n]) => `${s}×${n}`).join(' '),
  };
}

const orgId = await seed();
const cookie = await login();
const org = `${BASE}/api/v1/organizations/${orgId}`;
const results = [];
for (const [name, url] of [
  ['GET /health/live (baseline)', `${BASE}/api/health/live`],
  ['GET /findings', `${org}/findings?limit=25`],
  ['GET /findings?severity=high', `${org}/findings?limit=25&severity=high`],
  ['GET /findings?status=published', `${org}/findings?limit=25&status=published`],
  ['GET /reviews', `${org}/reviews?limit=25`],
  ['GET /audit-logs', `${org}/audit-logs?limit=50`],
  ['GET /analytics?days=30', `${org}/analytics?days=30`],
  ['GET /usage?days=30', `${org}/usage?days=30`],
]) {
  results.push(await run(name, url, cookie));
}
console.table(results);
