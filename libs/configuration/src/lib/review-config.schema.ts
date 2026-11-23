import { ReviewCategorySchema, SeveritySchema } from '@acra/shared-types';
import * as z from 'zod';

/**
 * Schema of the repository-level `ai-review.yaml`.
 *
 * Security notes:
 * - The file lives in the repository and is therefore untrusted input. Values that later reach AI
 *   prompts are constrained to enums/booleans/numbers — no free text.
 * - The `approval` section can only restate the platform policy: every mutating operation is
 *   `required` and `merge` is `disabled`. A repository cannot relax human approval.
 * - Objects are strict: unknown keys are rejected so typos do not silently disable settings.
 */

// Shared enums are zod/mini (browser-safe); rebuild them as full Zod enums for chaining.
const Severity = z.enum(SeveritySchema.options);
const ReviewCategory = z.enum(ReviewCategorySchema.options);

const required = z.literal('required', { error: 'must be "required" — this operation always needs human approval' });

const ApprovalSchema = z.strictObject({
  applyFixes: required.default('required'),
  stageChanges: required.default('required'),
  commitChanges: required.default('required'),
  pushBranch: required.default('required'),
  createMergeRequest: required.default('required'),
  createPullRequest: required.default('required'),
  merge: z.literal('disabled', { error: 'must be "disabled" — merging is never automated' }).default('disabled'),
});

const GlobSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((glob) => !glob.includes('\0'), 'must not contain NUL bytes');

export const ContextLimitsSchema = z.strictObject({
  /** Maximum number of changed files included in one review. */
  maxFiles: z.int().min(1).max(1_000).default(100),
  /** Files larger than this (bytes) are listed but their content is not sent. */
  maxFileBytes: z.int().min(1_024).max(5_000_000).default(512_000),
  /** Unchanged lines included above and below every hunk. */
  surroundingLines: z.int().min(0).max(200).default(20),
  /** Upper bound for the total size of the review context (bytes). */
  maxTotalBytes: z.int().min(10_000).max(20_000_000).default(1_500_000),
});
export type ContextLimits = z.infer<typeof ContextLimitsSchema>;

/**
 * A validation command as written in the file. Only a syntax pre-check here; the full allowlist
 * (`@acra/sandbox` command policy) is applied before a command is shown for approval.
 */
const ValidationCommandSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9@%+:,./_= -]+$/, 'may contain only letters, digits, spaces and @%+:,./_=- (no shell syntax)');

export const FixesSchema = z.strictObject({
  /** Hosted reviews: generate proposals automatically after a review (uses AI credits). */
  enabled: z.boolean().default(false),
  /** Upper bound of proposals generated per review. */
  maxPerReview: z.int().min(1).max(10).default(3),
  /** Only findings at or above this severity get a proposal automatically. */
  minimumSeverity: Severity.default('high'),
  /** Local CLI only: commands run in the fix worktree after an approved apply. */
  validation: z
    .strictObject({ commands: z.array(ValidationCommandSchema).max(5).default([]) })
    .default({ commands: [] }),
});
export type FixesConfig = z.infer<typeof FixesSchema>;

export const ReviewConfigSchema = z.strictObject({
  version: z.literal(1, { error: 'unsupported version — expected 1' }),
  project: z
    .strictObject({
      framework: z
        .enum(['angular', 'react', 'vue', 'svelte', 'nextjs', 'nestjs', 'express', 'node', 'other'])
        .optional(),
      language: z.enum(['typescript', 'javascript', 'python', 'java', 'go', 'csharp', 'other']).optional(),
    })
    .default({}),
  review: z
    .strictObject({
      enabled: z.boolean().default(true),
      providers: z
        .strictObject({
          claude: z.boolean().default(true),
          openai: z.boolean().default(true),
          /** Local model via Ollama — allowed by default; runs only when selected and OLLAMA_REVIEW_MODEL is set. */
          ollama: z.boolean().default(true),
        })
        .default({ claude: true, openai: true, ollama: true }),
      categories: z
        .array(ReviewCategory)
        .min(1)
        .refine((list) => new Set(list).size === list.length, 'categories must be unique')
        .default([...ReviewCategory.options]),
      minimumSeverity: Severity.default('medium'),
      minimumConfidence: z.number().min(0).max(1).default(0.8),
      exclude: z.array(GlobSchema).max(200).default([]),
      context: ContextLimitsSchema.default(ContextLimitsSchema.parse({})),
      publishing: z
        .strictObject({ inlineComments: z.boolean().default(true), summary: z.boolean().default(true) })
        .default({ inlineComments: true, summary: true }),
      approval: ApprovalSchema.default(ApprovalSchema.parse({})),
    })
    .default(() => ReviewSectionDefaults()),
  /**
   * Fix proposals (Module G). Generating a proposal is automatic; applying, committing, pushing and
   * opening an MR/PR always need a human approval (the `approval` section cannot change that).
   */
  fixes: FixesSchema.default(FixesSchema.parse({})),
});
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;

// Lazily computed so the nested defaults above stay the single source of truth.
function ReviewSectionDefaults(): z.output<typeof ReviewConfigSchema>['review'] {
  return ReviewConfigSchema.shape.review.parse({});
}

/** Built-in exclusions applied in addition to the repository's `exclude` list. */
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.git/**',
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.snap',
];
