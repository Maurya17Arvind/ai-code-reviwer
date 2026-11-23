import { type FindingSource, type ReviewCategory, type Severity } from '@acra/shared-types';

/** A finding proposed by one source (a model or the static analyzers), before validation. */
export interface CandidateFinding {
  readonly source: FindingSource;
  readonly filePath: string;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  readonly severity: Severity;
  readonly category: ReviewCategory;
  readonly title: string;
  readonly description: string;
  readonly evidence: string;
  readonly suggestion: string | null;
  readonly confidence: number;
}

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { critical: 4, high: 3, medium: 2, low: 1 };

export const SOURCE_ORDER: Readonly<Record<FindingSource, number>> = { static: 0, claude: 1, gpt: 2 };
