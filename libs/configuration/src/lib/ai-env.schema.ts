import * as z from 'zod';

const modelId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,99}$/, 'must be a model identifier (letters, digits, . _ : -)');

const optionalPrice = z.coerce.number().min(0).max(10_000).optional();

const booleanFlag = z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1');

/**
 * AI provider settings (CLI and worker). API keys themselves are read by the vendor SDKs
 * (ANTHROPIC_API_KEY / `ant auth` profile, OPENAI_API_KEY) and are never parsed, logged or stored here.
 */
export const AiEnvSchema = z.object({
  ANTHROPIC_REVIEW_MODEL: modelId.default('claude-opus-5-5'),
  ANTHROPIC_REVIEW_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  /** Server-side refusal fallback (`fallbacks: "default"`). */
  ANTHROPIC_REFUSAL_FALLBACK: booleanFlag.default(true),
  /** No default: GPT model naming changes often — choose explicitly. */
  OPENAI_REVIEW_MODEL: modelId.optional(),
  OPENAI_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).optional(),
  OPENAI_PRICE_INPUT_PER_MTOK: optionalPrice,
  OPENAI_PRICE_OUTPUT_PER_MTOK: optionalPrice,
  OPENAI_PRICE_CACHED_INPUT_PER_MTOK: optionalPrice,
  /** Wall-clock limit per provider per review. */
  AI_REVIEW_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(600_000),
  /** Shown in the consent summary when set (where code will be sent). */
  ANTHROPIC_BASE_URL: z.url().optional(),
  OPENAI_BASE_URL: z.url().optional(),
});
export type AiEnv = z.infer<typeof AiEnvSchema>;
