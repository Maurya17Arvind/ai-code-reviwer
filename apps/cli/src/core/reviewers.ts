import { type AiProviderName, type AiReviewer } from '@acra/ai-providers-core';
import { ClaudeReviewer } from '@acra/ai-providers-claude';
import { OpenAiReviewer } from '@acra/ai-providers-openai';
import { type SkippedProvider } from '@acra/agent-core';
import { type AiEnv } from '@acra/configuration';

export interface ReviewerSetup {
  readonly reviewers: AiReviewer[];
  readonly skipped: SkippedProvider[];
  /** Where code will be sent — shown in the consent summary. */
  readonly destinations: Array<{ readonly provider: AiProviderName; readonly model: string; readonly host: string }>;
}

export type ReviewerFactory = (env: AiEnv, providers: ReadonlySet<AiProviderName>) => ReviewerSetup;

/** Default composition: real SDK-backed reviewers. Tests inject fakes instead. */
export const createReviewers: ReviewerFactory = (env, providers) => {
  const setup: ReviewerSetup = { reviewers: [], skipped: [], destinations: [] };

  if (providers.has('claude')) {
    setup.reviewers.push(
      new ClaudeReviewer({
        model: env.ANTHROPIC_REVIEW_MODEL,
        effort: env.ANTHROPIC_REVIEW_EFFORT,
        refusalFallback: env.ANTHROPIC_REFUSAL_FALLBACK,
        timeoutMs: env.AI_REVIEW_TIMEOUT_MS,
      }),
    );
    setup.destinations.push({
      provider: 'claude',
      model: env.ANTHROPIC_REVIEW_MODEL,
      host: hostOf(env.ANTHROPIC_BASE_URL, 'api.anthropic.com'),
    });
  }

  if (providers.has('gpt')) {
    if (!env.OPENAI_REVIEW_MODEL) {
      setup.skipped.push({ provider: 'gpt', model: '(not configured)', reason: 'OPENAI_REVIEW_MODEL is not set' });
    } else {
      const price =
        env.OPENAI_PRICE_INPUT_PER_MTOK !== undefined && env.OPENAI_PRICE_OUTPUT_PER_MTOK !== undefined
          ? {
              inputPerMTok: env.OPENAI_PRICE_INPUT_PER_MTOK,
              outputPerMTok: env.OPENAI_PRICE_OUTPUT_PER_MTOK,
              ...(env.OPENAI_PRICE_CACHED_INPUT_PER_MTOK !== undefined
                ? { cacheReadPerMTok: env.OPENAI_PRICE_CACHED_INPUT_PER_MTOK }
                : {}),
            }
          : undefined;
      setup.reviewers.push(
        new OpenAiReviewer({
          model: env.OPENAI_REVIEW_MODEL,
          timeoutMs: env.AI_REVIEW_TIMEOUT_MS,
          ...(env.OPENAI_REASONING_EFFORT ? { reasoningEffort: env.OPENAI_REASONING_EFFORT } : {}),
          ...(price ? { price } : {}),
        }),
      );
      setup.destinations.push({
        provider: 'gpt',
        model: env.OPENAI_REVIEW_MODEL,
        host: hostOf(env.OPENAI_BASE_URL, 'api.openai.com'),
      });
    }
  }
  return setup;
};

function hostOf(url: string | undefined, fallback: string): string {
  if (!url) return fallback;
  try {
    return new URL(url).host;
  } catch {
    return fallback;
  }
}
