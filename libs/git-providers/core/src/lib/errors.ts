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
