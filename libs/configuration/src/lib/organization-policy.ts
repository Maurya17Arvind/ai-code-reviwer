import { type Severity, SEVERITY_ORDER } from '@acra/shared-types';
import { type ReviewConfig } from './review-config.schema';

/**
 * Organization-wide review policy managed in the dashboard (ADR-036). Repository configuration is
 * untrusted (ADR-021); the policy is set by organization admins and can only make it stricter.
 */
export interface OrganizationReviewPolicy {
  readonly reviewsEnabled: boolean;
  readonly allowClaude: boolean;
  readonly allowOpenai: boolean;
  readonly allowOllama: boolean;
  readonly allowFixProposals: boolean;
  readonly minimumSeverityFloor: string | null;
  readonly minimumConfidenceFloor: number | null;
}

const isSeverity = (value: string | null): value is Severity =>
  value !== null && (SEVERITY_ORDER as readonly string[]).includes(value);

/** The more severe (stricter) of two thresholds. SEVERITY_ORDER lists the most severe first. */
function stricterSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b) ? a : b;
}

/**
 * Applies the organization policy to a parsed repository configuration. Every rule is a logical
 * AND or a max(): nothing in the policy can enable what the repository disabled, and nothing in the
 * repository can enable what the policy disabled. Approval rules are untouched (always required).
 */
export function applyOrganizationPolicy(config: ReviewConfig, policy: OrganizationReviewPolicy): ReviewConfig {
  const severityFloor = isSeverity(policy.minimumSeverityFloor) ? policy.minimumSeverityFloor : null;
  const confidenceFloor =
    policy.minimumConfidenceFloor !== null && Number.isFinite(policy.minimumConfidenceFloor)
      ? Math.min(Math.max(policy.minimumConfidenceFloor, 0), 1)
      : null;
  return {
    ...config,
    review: {
      ...config.review,
      enabled: config.review.enabled && policy.reviewsEnabled,
      providers: {
        claude: config.review.providers.claude && policy.allowClaude,
        openai: config.review.providers.openai && policy.allowOpenai,
        ollama: config.review.providers.ollama && policy.allowOllama,
      },
      minimumSeverity: severityFloor
        ? stricterSeverity(config.review.minimumSeverity, severityFloor)
        : config.review.minimumSeverity,
      minimumConfidence:
        confidenceFloor === null
          ? config.review.minimumConfidence
          : Math.max(config.review.minimumConfidence, confidenceFloor),
    },
    fixes: { ...config.fixes, enabled: config.fixes.enabled && policy.allowFixProposals },
  };
}
