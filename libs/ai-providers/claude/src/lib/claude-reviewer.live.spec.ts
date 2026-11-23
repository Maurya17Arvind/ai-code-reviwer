import { ModelReviewOutputSchema } from '@acra/ai-providers-core';
import { ClaudeReviewer } from './claude-reviewer';

/**
 * LIVE test against the real Anthropic API. Opt-in only (`pnpm nx run ai-providers-claude:live`),
 * skipped without ANTHROPIC_API_KEY. Uses low effort and a tiny input to keep cost minimal.
 */
describe.skipIf(!process.env['ANTHROPIC_API_KEY'])('ClaudeReviewer (live API)', () => {
  it('returns schema-valid findings for an obvious bug', async () => {
    const reviewer = new ClaudeReviewer({ effort: 'low', maxTokens: 8_000 });
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
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.costUsd).not.toBeNull();
    expect(output.findings.length).toBeGreaterThan(0);
  });
});
