import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type * as z from 'zod/mini';

/**
 * Validates a body, query or param against a shared contract schema. Error messages name the
 * failing fields only; submitted values are never echoed back (they may contain secrets).
 */
export class ZodValidationPipe<T extends z.ZodMiniType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data as z.infer<T>;
    const fields = [
      ...new Set(result.error.issues.map((issue) => (issue.path.length > 0 ? issue.path.join('.') : 'request'))),
    ];
    throw new BadRequestException(`Invalid ${fields.slice(0, 5).join(', ')}`);
  }
}

export const zod = <T extends z.ZodMiniType>(schema: T) => new ZodValidationPipe(schema);
