import * as z from 'zod';

export const NodeEnvSchema = z.enum(['development', 'test', 'production']);
export const LogLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const urlWithProtocols = (protocols: readonly string[], label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine(
      (value) => {
        try {
          return protocols.includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      `must be a valid URL using one of: ${protocols.join(', ')}`,
    );

const port = z.coerce.number().int().min(1).max(65_535);

const commaSeparatedOrigins = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(z.array(z.url({ protocol: /^https?$/ })).min(1, 'at least one origin is required'));

const BaseEnvSchema = z.object({
  NODE_ENV: NodeEnvSchema.default('development'),
  LOG_LEVEL: LogLevelSchema.default('info'),
});

const DatabaseEnvSchema = z.object({
  DATABASE_URL: urlWithProtocols(['postgres:', 'postgresql:'], 'DATABASE_URL'),
});

const RedisEnvSchema = z.object({
  REDIS_URL: urlWithProtocols(['redis:', 'rediss:'], 'REDIS_URL'),
});

export const ApiEnvSchema = BaseEnvSchema.extend(DatabaseEnvSchema.shape)
  .extend(RedisEnvSchema.shape)
  .extend({
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: port.default(3000),
    API_CORS_ORIGINS: commaSeparatedOrigins.default(['http://localhost:4300']),
  });
export type ApiEnv = z.infer<typeof ApiEnvSchema>;

export const WorkerEnvSchema = BaseEnvSchema.extend(DatabaseEnvSchema.shape).extend(RedisEnvSchema.shape);
export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;
