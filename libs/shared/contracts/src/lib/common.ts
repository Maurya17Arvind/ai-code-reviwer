// Browser-safe: `zod/mini` keeps dashboard bundles small.
import * as z from 'zod/mini';

/** Resource ids are UUIDs (v7 for most tables, v4 for some provider-generated rows). */
export const IdSchema = z.uuid();

/** Keyset pagination: `?limit=25&cursor=<opaque>` → `{ items, nextCursor }`. */
export const PageQuerySchema = z.object({
  limit: z._default(z.coerce.number().check(z.int(), z.gte(1), z.lte(100)), 25),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(300))),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export function pageOf<T extends z.ZodMiniType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.nullable(z.string()) });
}
export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/** ISO-8601 timestamp as sent by the API. */
export const TimestampSchema = z.iso.datetime({ offset: true });
export const NullableTimestampSchema = z.nullable(TimestampSchema);

/** A short git commit id: 7–64 hex characters. */
export const ShaSchema = z.string().check(z.regex(/^[0-9a-f]{7,64}$/i));
