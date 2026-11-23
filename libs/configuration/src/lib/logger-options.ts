import { LOG_REDACT_PATHS, REDACTED } from '@acra/security';
import type * as z from 'zod';
import { type LogLevelSchema, type NodeEnvSchema } from './env.schema';

export interface LoggerOptionsInput {
  readonly service: 'api' | 'worker' | 'cli';
  readonly level: z.infer<typeof LogLevelSchema>;
  readonly nodeEnv: z.infer<typeof NodeEnvSchema>;
}

/** Plain pino options shared by every Node process (structured JSON, secret redaction). */
export function createLoggerOptions(input: LoggerOptionsInput) {
  const pretty = input.nodeEnv === 'development';
  return {
    level: input.level,
    base: { service: input.service },
    redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
  };
}
