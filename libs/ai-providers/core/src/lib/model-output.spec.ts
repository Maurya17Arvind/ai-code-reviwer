import { modelReviewOutputJsonSchema, ModelReviewOutputSchema } from './model-output.schema';
import { CLAUDE_PRICES, estimateCostUsd } from './pricing';

type JsonObject = Record<string, unknown>;

function visitObjects(node: unknown, visit: (object: JsonObject) => void): void {
  if (Array.isArray(node)) node.forEach((child) => visitObjects(child, visit));
  else if (node && typeof node === 'object') {
    const object = node as JsonObject;
    if (object['type'] === 'object') visit(object);
    Object.values(object).forEach((child) => visitObjects(child, visit));
  }
}

describe('model output JSON schema (provider portability)', () => {
  const schema = modelReviewOutputJsonSchema();

  it('has no $schema key and a top-level object', () => {
    expect(schema['$schema']).toBeUndefined();
    expect(schema['type']).toBe('object');
  });

  it('makes every object strict with all properties required (OpenAI strict + Claude structured outputs)', () => {
    let objects = 0;
    visitObjects(schema, (object) => {
      objects++;
      expect(object['additionalProperties']).toBe(false);
      const properties = Object.keys((object['properties'] as JsonObject | undefined) ?? {});
      expect([...((object['required'] as string[] | undefined) ?? [])].sort()).toEqual(properties.sort());
    });
    expect(objects).toBe(2);
  });

  it('contains no unsupported numeric or length constraints', () => {
    const text = JSON.stringify(schema);
    for (const keyword of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf', 'exclusiveMinimum']) {
      expect(text).not.toContain(`"${keyword}"`);
    }
  });

  it('validates a well-formed output and rejects extra keys', () => {
    const finding = {
      filePath: 'src/a.ts',
      lineStart: 3,
      lineEnd: null,
      severity: 'high',
      category: 'security',
      title: 't',
      description: 'd',
      evidence: 'e',
      suggestion: null,
      confidence: 0.9,
    };
    expect(ModelReviewOutputSchema.safeParse({ findings: [finding], summary: 's' }).success).toBe(true);
    expect(ModelReviewOutputSchema.safeParse({ findings: [{ ...finding, extra: 1 }], summary: 's' }).success).toBe(
      false,
    );
  });
});

describe('estimateCostUsd', () => {
  it('prices Claude Opus 5.5 input, output and cache reads', () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 1_000_000 },
      CLAUDE_PRICES['claude-opus-5-5'],
    );
    expect(cost).toBeCloseTo(4 + 2 + 0.2, 6);
  });

  it('returns null for unknown models', () => {
    expect(estimateCostUsd({ inputTokens: 1, outputTokens: 1 }, undefined)).toBeNull();
  });
});
