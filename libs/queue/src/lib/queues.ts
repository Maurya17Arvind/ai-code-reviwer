import * as z from 'zod';

/**
 * Queue registry. Every queue and job name lives here so producers (api) and
 * consumers (worker) cannot drift apart. Review, publishing and fix queues are
 * added in the phases that introduce them.
 */
export const QueueName = {
  /** Infrastructure jobs: heartbeats, maintenance. */
  System: 'system',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const SystemJobName = {
  Heartbeat: 'heartbeat',
} as const;
export type SystemJobName = (typeof SystemJobName)[keyof typeof SystemJobName];

/** Payload of system:heartbeat — proves end-to-end api → Redis → worker wiring. */
export const HeartbeatJobSchema = z.object({
  correlationId: z.uuid(),
  requestedAt: z.iso.datetime(),
  source: z.enum(['api', 'worker', 'test']),
});
export type HeartbeatJob = z.infer<typeof HeartbeatJobSchema>;

export const HeartbeatResultSchema = z.object({
  correlationId: z.uuid(),
  processedAt: z.iso.datetime(),
});
export type HeartbeatResult = z.infer<typeof HeartbeatResultSchema>;
