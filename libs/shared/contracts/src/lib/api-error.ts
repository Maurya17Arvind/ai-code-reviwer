import * as z from 'zod/mini';

/** Uniform error envelope returned by every API endpoint. Never contains stack traces. */
export const ApiErrorSchema = z.object({
  statusCode: z.int().check(z.gte(400), z.lte(599)),
  error: z.string(),
  message: z.string(),
  requestId: z.optional(z.string()),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
