import { parse as parseYaml, YAMLParseError } from 'yaml';
import { type ReviewConfig, ReviewConfigSchema } from './review-config.schema';

export const REVIEW_CONFIG_FILENAME = 'ai-review.yaml';
const MAX_CONFIG_BYTES = 64 * 1024;

export class ReviewConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid ${REVIEW_CONFIG_FILENAME}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ReviewConfigError';
  }
}

/**
 * Parses and validates `ai-review.yaml` content. The file is untrusted repository content:
 * size is capped, YAML aliases are limited (billion-laughs protection), duplicate keys are
 * rejected, and the result must satisfy the strict schema.
 */
export function parseReviewConfig(yamlText: string): ReviewConfig {
  if (Buffer.byteLength(yamlText, 'utf8') > MAX_CONFIG_BYTES) {
    throw new ReviewConfigError([`file is larger than ${MAX_CONFIG_BYTES / 1024} KiB`]);
  }

  let raw: unknown;
  try {
    raw = parseYaml(yamlText, { maxAliasCount: 50, uniqueKeys: true, prettyErrors: true });
  } catch (error) {
    const detail =
      error instanceof YAMLParseError ? `${error.code} at line ${error.linePos?.[0]?.line ?? '?'}` : 'unreadable YAML';
    throw new ReviewConfigError([`YAML syntax error (${detail})`]);
  }

  const result = ReviewConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ReviewConfigError(
      result.error.issues.map(
        (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}

/** Configuration used when a repository has no `ai-review.yaml`. */
export function defaultReviewConfig(): ReviewConfig {
  return ReviewConfigSchema.parse({ version: 1 });
}

export interface ReviewConfigTemplateInput {
  readonly framework?: NonNullable<ReviewConfig['project']['framework']>;
  readonly language?: NonNullable<ReviewConfig['project']['language']>;
}

/** Commented starter file written by `ai-review init`. Always valid against the schema. */
export function renderReviewConfigTemplate(input: ReviewConfigTemplateInput = {}): string {
  const lines = [
    input.framework ? `  framework: ${input.framework}` : '  # framework: angular',
    input.language ? `  language: ${input.language}` : '  # language: typescript',
  ];
  // A mapping whose children are all commented out parses as null, so emit an explicit `{}`.
  const project = input.framework || input.language ? `\n${lines.join('\n')}` : ` {}\n${lines.join('\n')}`;

  return `# AI Code Review configuration — https://github.com/Maurya17Arvind/ai-code-reviwer
# Validated by the CLI and the server before every review.
version: 1

project:${project}

review:
  enabled: true

  providers:
    claude: true
    openai: true
    # Local model via Ollama (nothing leaves the machine); runs with --provider ollama|all and OLLAMA_REVIEW_MODEL.
    ollama: true

  categories:
    - bug
    - security
    - performance
    - architecture
    - maintainability
    - error_handling
    - concurrency
    - data_consistency
    - testing
    - scalability

  # Findings below these thresholds are not published.
  minimumSeverity: medium
  minimumConfidence: 0.80

  # Added to the built-in exclusions (node_modules, dist, coverage, lock files, minified files, ...).
  exclude: []

  context:
    maxFiles: 100
    maxFileBytes: 512000
    surroundingLines: 20
    maxTotalBytes: 1500000

  publishing:
    inlineComments: true
    summary: true

  # Restates the platform policy. These values cannot be relaxed.
  approval:
    applyFixes: required
    stageChanges: required
    commitChanges: required
    pushBranch: required
    createMergeRequest: required
    createPullRequest: required
    merge: disabled
`;
}
