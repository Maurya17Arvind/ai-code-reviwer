// Browser-safe: `zod/mini` keeps dashboard bundles small.
import * as z from 'zod/mini';

/** Severity of a review finding, most severe first. */
export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof SeveritySchema>;

export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

/** Review categories from the product brief (Module D). */
export const ReviewCategorySchema = z.enum([
  'bug',
  'security',
  'performance',
  'architecture',
  'maintainability',
  'error_handling',
  'concurrency',
  'data_consistency',
  'testing',
  'scalability',
]);
export type ReviewCategory = z.infer<typeof ReviewCategorySchema>;
