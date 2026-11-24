import { applyOrganizationPolicy, type OrganizationReviewPolicy } from './organization-policy';
import { parseReviewConfig } from './review-config.loader';

const OPEN: OrganizationReviewPolicy = {
  reviewsEnabled: true,
  allowClaude: true,
  allowOpenai: true,
  allowOllama: true,
  allowFixProposals: true,
  minimumSeverityFloor: null,
  minimumConfidenceFloor: null,
};

const repoConfig = (yaml: string) => parseReviewConfig(`version: 1\n${yaml}`);

describe('applyOrganizationPolicy', () => {
  it('leaves the repository configuration unchanged under an open policy', () => {
    const config = repoConfig('');
    expect(applyOrganizationPolicy(config, OPEN)).toEqual(config);
  });

  it('disables reviews, providers and fixes the policy turns off', () => {
    const config = repoConfig('fixes:\n  enabled: true\n');
    const result = applyOrganizationPolicy(config, {
      ...OPEN,
      reviewsEnabled: false,
      allowOpenai: false,
      allowFixProposals: false,
    });
    expect(result.review.enabled).toBe(false);
    expect(result.review.providers).toEqual({ claude: true, openai: false, ollama: true });
    expect(result.fixes.enabled).toBe(false);
  });

  it('never enables what the repository disabled', () => {
    const config = repoConfig('review:\n  enabled: false\n  providers:\n    claude: false\n');
    const result = applyOrganizationPolicy(config, OPEN);
    expect(result.review.enabled).toBe(false);
    expect(result.review.providers.claude).toBe(false);
    expect(result.fixes.enabled).toBe(false);
  });

  it('raises thresholds to the floors but never lowers them', () => {
    const lenient = repoConfig('review:\n  minimumSeverity: low\n  minimumConfidence: 0.5\n');
    const raised = applyOrganizationPolicy(lenient, {
      ...OPEN,
      minimumSeverityFloor: 'high',
      minimumConfidenceFloor: 0.9,
    });
    expect(raised.review.minimumSeverity).toBe('high');
    expect(raised.review.minimumConfidence).toBe(0.9);

    const strict = repoConfig('review:\n  minimumSeverity: critical\n  minimumConfidence: 0.95\n');
    const kept = applyOrganizationPolicy(strict, {
      ...OPEN,
      minimumSeverityFloor: 'medium',
      minimumConfidenceFloor: 0.6,
    });
    expect(kept.review.minimumSeverity).toBe('critical');
    expect(kept.review.minimumConfidence).toBe(0.95);
  });

  it('ignores malformed floors instead of loosening anything', () => {
    const config = repoConfig('');
    const result = applyOrganizationPolicy(config, {
      ...OPEN,
      minimumSeverityFloor: 'urgent',
      minimumConfidenceFloor: Number.NaN,
    });
    expect(result.review.minimumSeverity).toBe(config.review.minimumSeverity);
    expect(result.review.minimumConfidence).toBe(config.review.minimumConfidence);
  });

  it('keeps every approval rule required', () => {
    const result = applyOrganizationPolicy(repoConfig(''), OPEN);
    expect(Object.values(result.review.approval).filter((v) => v !== 'required')).toEqual(['disabled']);
  });
});
