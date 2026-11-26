import { loadEnv } from '@acra/configuration';
import { AuthStore, createPrismaClient, type PrismaClient } from '@acra/database';
import { createRedisConnectionOptions, MailJobName, MailQueueProducer, QueueName, type SendMailJob } from '@acra/queue';
import { hashToken } from '@acra/security';
import { FakeSmtpServer } from '@acra/testing';
import { type INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type Job, Queue, QueueEvents } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { WorkerConfigSchema } from '../worker-config';
import { WorkerModule } from '../worker.module';
import { RESET_LINK_TTL_MS } from './mail-delivery.service';

const DASHBOARD = 'https://app.test.example';
const TOKEN_IN_LINK = /\/setup-password#token=([A-Za-z0-9_-]{43})/;

/**
 * Mail delivery end to end (ADR-040): MailQueueProducer (what the API uses) → Redis → worker →
 * PostgreSQL (token hash) → SMTP (a real SMTP conversation with the fake server).
 */
describe('Mail delivery (integration: PostgreSQL + Redis + SMTP)', () => {
  const smtp = new FakeSmtpServer();
  let app: INestApplicationContext;
  let prisma: PrismaClient;
  let queue: Queue;
  let events: QueueEvents;

  beforeAll(async () => {
    await smtp.start();
    const config = loadEnv(WorkerConfigSchema, {
      ...process.env,
      MAIL_SMTP_URL: smtp.url(),
      MAIL_FROM: 'AI Code Review <noreply@test.example>',
      MAIL_REQUIRE_TLS: 'false',
      DASHBOARD_PUBLIC_URL: `${DASHBOARD}/`,
    });
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.forRoot(config)] }).compile();
    app = await moduleRef.init();
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL, poolMax: 2 });
    const connection = createRedisConnectionOptions(config.REDIS_URL, 'worker');
    queue = new Queue(QueueName.Mail, { connection });
    events = new QueueEvents(QueueName.Mail, { connection });
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
  });

  afterAll(async () => {
    await events?.close();
    await queue?.close();
    await prisma?.$disconnect();
    await app?.close();
    await smtp.stop();
  });

  async function newUser(displayName = 'Ana <b>Müller</b>') {
    return prisma.user.create({
      data: { email: `mail-${randomUUID().slice(0, 8)}@example.com`, displayName, passwordHash: 'scrypt$old' },
    });
  }

  function job(purpose: SendMailJob['purpose'], userId: string): SendMailJob {
    return { purpose, userId, correlationId: randomUUID(), requestId: 'req-mail-test' };
  }

  async function finished(jobId: string): Promise<Job> {
    const queued = await queue.getJob(jobId);
    if (!queued) throw new Error(`job ${jobId} not found`);
    await queued.waitUntilFinished(events, 15_000).catch(() => undefined);
    const done = await queue.getJob(jobId);
    if (!done) throw new Error(`job ${jobId} disappeared`);
    return done;
  }

  async function audits(userId: string | null, action: string) {
    return prisma.auditLog.findMany({ where: { action, targetId: userId }, orderBy: { createdAt: 'asc' } });
  }

  it('sends a reset link whose token exists only in the message', async () => {
    const user = await newUser();
    const payload = job('password_reset', user.id);
    const { jobId } = await app.get(MailQueueProducer).enqueue(payload);
    const done = await finished(jobId);
    expect(done.returnvalue).toMatchObject({ status: 'sent' });

    const [mail] = smtp.to(user.email);
    expect(mail?.subject).toBe('Reset your AI Code Review password');
    expect(mail?.from).toBe('noreply@test.example');
    expect(mail?.text).toContain('Hi Ana <b>Müller</b>,');
    expect(mail?.html).toContain('Ana &lt;b&gt;Müller&lt;/b&gt;');
    const token = TOKEN_IN_LINK.exec(mail?.text ?? '')?.[1] ?? '';
    expect(token).toHaveLength(43);
    expect(mail?.text).toContain(`${DASHBOARD}/setup-password#token=${token}`); // trailing slash normalised

    // Redis holds ids only; the database holds only the hash.
    expect(JSON.stringify(done.data)).not.toContain(token);
    expect(JSON.stringify(done.data)).not.toContain(user.email);
    const [row] = await prisma.userSetupToken.findMany({ where: { userId: user.id } });
    expect(row).toMatchObject({ tokenHash: hashToken(token), purpose: 'RESET', usedAt: null, createdById: null });
    const ttl = (row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0);
    expect(Math.abs(ttl - RESET_LINK_TTL_MS)).toBeLessThan(5_000);

    const [sent] = await audits(user.id, 'mail.sent');
    expect(sent).toMatchObject({ actorType: 'SYSTEM', actorUserId: null, requestId: 'req-mail-test' });
    expect(sent?.metadata).toMatchObject({ purpose: 'password_reset', correlationId: payload.correlationId });
    expect(JSON.stringify(sent?.metadata)).not.toContain(token);
    expect(JSON.stringify(sent?.metadata)).not.toContain(user.email);

    // The link works exactly once.
    const store = app.get(AuthStore);
    expect(await store.consumeSetupToken(hashToken(token), 'scrypt$new', new Date())).toBe(user.id);
    expect(await store.consumeSetupToken(hashToken(token), 'scrypt$again', new Date())).toBeNull();
  });

  it('a newer reset mail voids the older link', async () => {
    const user = await newUser('Bo');
    const producer = app.get(MailQueueProducer);
    await finished((await producer.enqueue(job('password_reset', user.id))).jobId);
    await finished((await producer.enqueue(job('password_reset', user.id))).jobId);

    const [first, second] = smtp.to(user.email).map((m) => TOKEN_IN_LINK.exec(m.text)?.[1] ?? '');
    expect(first).not.toBe(second);
    const store = app.get(AuthStore);
    expect(await store.consumeSetupToken(hashToken(first ?? ''), 'scrypt$x', new Date())).toBeNull();
    expect(await store.consumeSetupToken(hashToken(second ?? ''), 'scrypt$x', new Date())).toBe(user.id);
  });

  it('sends the account-exists notice without minting any link', async () => {
    const user = await newUser('Cy');
    const done = await finished((await app.get(MailQueueProducer).enqueue(job('account_exists', user.id))).jobId);
    expect(done.returnvalue).toMatchObject({ status: 'sent' });
    const [mail] = smtp.to(user.email);
    expect(mail?.subject).toBe('You already have an AI Code Review account');
    expect(mail?.text).toContain(`${DASHBOARD}/forgot-password`);
    expect(mail?.text).not.toContain('token=');
    expect(await prisma.userSetupToken.count({ where: { userId: user.id } })).toBe(0);
  });

  it('retries a transient SMTP failure and then delivers', async () => {
    const user = await newUser('Di');
    smtp.rejectNext(user.email, '451 4.3.0 Try again later');
    const payload = job('password_reset', user.id);
    // Same payload as the producer, with a short backoff so the test does not wait 15 s.
    await queue.add(MailJobName.Send, payload, { jobId: `mail_${payload.correlationId}`, attempts: 3, backoff: 50 });
    const done = await finished(`mail_${payload.correlationId}`);
    expect(done.returnvalue).toMatchObject({ status: 'sent' });
    expect(done.attemptsMade).toBe(2);
    expect(smtp.to(user.email)).toHaveLength(1);
    expect(await audits(user.id, 'mail.failed')).toHaveLength(0);
    // The token minted on the failed attempt was voided by the second one: one live link at most.
    expect(await prisma.userSetupToken.count({ where: { userId: user.id, usedAt: null } })).toBe(1);
  });

  it('stops at once on a permanent rejection and audits the failure', async () => {
    const user = await newUser('Ed');
    smtp.rejectRecipients.set(user.email, '550 5.1.1 Mailbox does not exist');
    const done = await finished((await app.get(MailQueueProducer).enqueue(job('password_reset', user.id))).jobId);
    smtp.rejectRecipients.delete(user.email);

    expect(done.failedReason).toBe('Mail delivery failed: SMTP 550 during RCPT');
    expect(done.attemptsMade).toBe(1);
    const [failed] = await audits(user.id, 'mail.failed');
    expect(failed?.metadata).toMatchObject({ purpose: 'password_reset', permanent: true });
  });

  it('skips users that no longer exist', async () => {
    const missing = randomUUID();
    const done = await finished((await app.get(MailQueueProducer).enqueue(job('password_reset', missing))).jobId);
    expect(done.returnvalue).toEqual({ status: 'skipped', reason: 'user_not_found' });
    const skipped = await prisma.auditLog.findFirst({
      where: { action: 'mail.skipped', metadata: { path: ['userId'], equals: missing } },
    });
    expect(skipped).toMatchObject({ actorType: 'SYSTEM', targetId: null });
  });

  it('refuses payloads that carry anything besides ids', async () => {
    const user = await newUser('Fi');
    await expect(
      app.get(MailQueueProducer).enqueue({ ...job('password_reset', user.id), token: 'x' } as SendMailJob),
    ).rejects.toThrow();
    // Written straight to Redis, bypassing the producer: the worker refuses it without retrying.
    const id = `mail_${randomUUID()}`;
    await queue.add(MailJobName.Send, { ...job('password_reset', user.id), email: 'eve@example.com' }, { jobId: id });
    const done = await finished(id);
    expect(done.failedReason).toBe('Invalid mail job payload');
    expect(smtp.to('eve@example.com')).toHaveLength(0);
  });
});
