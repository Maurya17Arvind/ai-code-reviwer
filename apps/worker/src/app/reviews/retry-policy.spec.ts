import { GitProviderError } from '@acra/git-providers-core';
import { GitHubApiError } from '@acra/git-providers-github';
import { GitLabApiError } from '@acra/git-providers-gitlab';
import { isRetryable, PermanentReviewError } from './merge-request-review.service';

describe('review retry policy', () => {
  it.each([
    [new GitLabApiError(0, 'network'), true],
    [new GitLabApiError(429, 'rate limited'), true],
    [new GitLabApiError(503, 'unavailable'), true],
    [new GitProviderError('Merge request !5 diff is not ready yet', 'GIT_FAILED'), true],
    [new GitLabApiError(401, 'unauthorized'), false],
    [new GitLabApiError(404, 'gone'), false],
    [new GitHubApiError(502, 'bad gateway'), true],
    [new GitHubApiError(429, 'secondary rate limit'), true],
    [new GitHubApiError(422, 'validation failed'), false],
    [new PermanentReviewError('config_invalid', 'bad yaml'), false],
    [new Error('bug'), false],
  ])('%s → retryable=%s', (error, expected) => {
    expect(isRetryable(error)).toBe(expected);
  });
});
