/** Base class for expected, user-actionable Git provider failures (safe to show to users). */
export class GitProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      'NOT_A_REPOSITORY' | 'NO_COMMITS' | 'UNKNOWN_REF' | 'NO_MERGE_BASE' | 'UNSAFE_REF' | 'UNSAFE_PATH' | 'GIT_FAILED',
  ) {
    super(message);
    this.name = 'GitProviderError';
  }
}

/** HTTP-level failure from a hosted provider API (GitLab, GitHub). Never contains tokens. */
export class ProviderApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderApiError';
  }

  /** Network errors (status 0), rate limits and server errors are worth retrying. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** The provider rejected an inline comment position; publishers fall back to the summary. */
export class InlinePositionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InlinePositionRejectedError';
  }
}
