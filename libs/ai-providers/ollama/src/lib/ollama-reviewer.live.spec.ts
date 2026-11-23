import { ModelReviewOutputSchema } from '@acra/ai-providers-core';
import { OllamaReviewer } from './ollama-reviewer';

/**
 * LIVE test against the local Ollama server (free, nothing leaves the machine). Opt-in:
 * `pnpm nx run ai-providers-ollama:live`, skipped unless OLLAMA_REVIEW_MODEL is set.
 */
const model = process.env['OLLAMA_REVIEW_MODEL'];

describe.skipIf(!model)('OllamaReviewer (live local server)', () => {
  it('returns schema-valid output for an obvious bug', async () => {
    const reviewer = new OllamaReviewer({ model: model ?? '', numCtx: 4_096 });
    const started = Date.now();
    const result = await reviewer.review(
      {
        system:
          'You are a code reviewer. Report real bugs only. Respond only with JSON matching the required schema. filePath must be "src/sum.ts".',
        user: 'FILE src/sum.ts\n+ 1 | export function sum(values: number[]) {\n+ 2 |   let total = 0;\n+ 3 |   for (let i = 0; i <= values.length; i++) total += values[i];\n+ 4 |   return total;\n+ 5 | }',
        promptHash: 'live',
      },
      AbortSignal.timeout(600_000),
    );
    const output = ModelReviewOutputSchema.parse(result.output);
    console.warn(
      `ollama ${result.servedByModel}: ${((Date.now() - started) / 1000).toFixed(1)}s, ` +
        `${result.usage.inputTokens} in / ${result.usage.outputTokens} out, ${output.findings.length} finding(s): ` +
        output.findings.map((f) => `[${f.severity}] ${f.title} (line ${f.lineStart})`).join('; '),
    );
    expect(result.costUsd).toBe(0);
  });
});
