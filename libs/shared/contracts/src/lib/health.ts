// Browser-safe contracts use `zod/mini` (tree-shakable functional API) to keep dashboard bundles small.
import * as z from 'zod/mini';

/** Contract for GET /api/health/live — process is up and serving requests. */
export const LivenessResponseSchema = z.object({
  status: z.literal('ok'),
  timestamp: z.iso.datetime(),
});
export type LivenessResponse = z.infer<typeof LivenessResponseSchema>;

export const DependencyNameSchema = z.enum(['database', 'redis']);
export type DependencyName = z.infer<typeof DependencyNameSchema>;

/**
 * Result of one dependency probe. `reason` is a coarse category on purpose:
 * raw driver errors can contain hostnames or credentials and are only logged server-side.
 */
export const DependencyCheckSchema = z.object({
  name: DependencyNameSchema,
  status: z.enum(['up', 'down']),
  latencyMs: z.number().check(z.gte(0)),
  reason: z.optional(z.enum(['timeout', 'error'])),
});
export type DependencyCheck = z.infer<typeof DependencyCheckSchema>;

/** Contract for GET /api/health/ready — 200 when all dependencies are up, otherwise 503. */
export const ReadinessResponseSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  timestamp: z.iso.datetime(),
  checks: z.array(DependencyCheckSchema),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
