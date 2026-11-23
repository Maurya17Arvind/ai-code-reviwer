import { ModelReviewOutputSchema } from '@acra/ai-providers-core';
import { OpenAiReviewer } from './openai-reviewer';

/**
 * LIVE test against the real OpenAI API. Opt-in only (`pnpm nx run ai-providers-openai:live`),
 * skipped unless OPENAI_API_KEY and OPENAI_REVIEW_MODEL are set.
 */
const model = process.env['OPENAI_REVIEW_MODEL'];

describe.skipIf(!process.env['OPENAI_API_KEY'] || !model)('OpenAiReviewer (live API)', () => {
  it('returns schema-valid findings for an obvious bug', async () => {
    const reviewer = new OpenAiReviewer({ model: model ?? '', maxOutputTokens: 8_000 });
    const result = await reviewer.review(
      {
        system:
          'You are a code reviewer. Report real bugs only. Respond only with JSON matching the required schema. filePath must be "src/sum.ts".',
        user: 'FILE src/sum.ts\n+ 1 | export function sum(values: number[]) {\n+ 2 |   let total = 0;\n+ 3 |   for (let i = 0; i <= values.length; i++) total += values[i];\n+ 4 |   return total;\n+ 5 | }',
        promptHash: 'live',
      },
      AbortSignal.timeout(300_000),
    );
    const output = ModelReviewOutputSchema.parse(result.output);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(output.findings.length).toBeGreaterThan(0);
  });
});
