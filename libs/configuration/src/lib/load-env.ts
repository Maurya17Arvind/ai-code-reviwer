import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type * as z from 'zod';

/**
 * Thrown when environment validation fails. The message lists variable names and
 * rule violations only — input values are never included because they may be secrets.
 */
export class ConfigValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

export function loadEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  source: Readonly<Record<string, string | undefined>> = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(source);
  if (result.success) {
    return result.data;
  }
  const problems = result.error.issues.map((issue) => {
    const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${key}: ${issue.code === 'invalid_type' && issue.input === undefined ? 'is required' : issue.message}`;
  });
  throw new ConfigValidationError(problems);
}

/**
 * Loads a local `.env` file into process.env when present (development convenience).
 * Variables already set in the environment take precedence. Production deployments
 * should inject configuration through the environment and not ship a `.env` file.
 */
export function loadDotEnvFile(path: string = resolve(process.cwd(), '.env')): boolean {
  if (!existsSync(path)) {
    return false;
  }
  process.loadEnvFile(path);
  return true;
}
