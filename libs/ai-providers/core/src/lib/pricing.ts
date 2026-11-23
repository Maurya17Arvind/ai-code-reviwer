import { type TokenUsage } from './ai-reviewer';

/** USD per million tokens. */
export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  /** Defaults to 10% of input. */
  readonly cacheReadPerMTok?: number;
  /** Defaults to 125% of input. */
  readonly cacheWritePerMTok?: number;
}

/**
 * Anthropic first-party list prices (source: Claude API reference, cached 2026-10-06).
 * Used for cost estimates only; invoices are authoritative. Unknown models → cost `null`.
 */
export const CLAUDE_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

export function estimateCostUsd(usage: TokenUsage, price: ModelPrice | undefined): number | null {
  if (!price) return null;
  const perToken = (perMTok: number) => perMTok / 1_000_000;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const cost =
    usage.inputTokens * perToken(price.inputPerMTok) +
    usage.outputTokens * perToken(price.outputPerMTok) +
    cacheRead * perToken(price.cacheReadPerMTok ?? price.inputPerMTok * 0.1) +
    cacheWrite * perToken(price.cacheWritePerMTok ?? price.inputPerMTok * 1.25);
  return Math.round(cost * 1_000_000) / 1_000_000;
}
