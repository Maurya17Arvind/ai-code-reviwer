import { DEFAULT_EXCLUDE_GLOBS, type ReviewConfig } from '@acra/configuration';
import { type RepositoryInfo } from '@acra/git-providers-core';
import { type LocalGitProvider } from '@acra/git-providers-local';
import { buildReviewContext, type ReviewContext } from '@acra/repository-context';
import { resolveScope, type ScopeFlags } from './scope';
import { loadRepositoryConfig } from './workspace';

export interface ContextOptions extends ScopeFlags {
  readonly diffContext?: number;
  readonly surrounding?: number;
}

export interface LoadedReviewContext {
  readonly info: RepositoryInfo;
  readonly configSource: 'file' | 'default';
  readonly config: ReviewConfig;
  readonly context: ReviewContext;
}

/** Shared by `changes` (preview) and `review`, so both always describe the same input. */
export async function loadReviewContext(
  provider: LocalGitProvider,
  options: ContextOptions,
): Promise<LoadedReviewContext> {
  const info = await provider.getRepositoryInfo();
  const { source, config } = await loadRepositoryConfig(provider);
  const scope = resolveScope(options, info);
  const changeSet = await provider.getChangeSet(
    scope,
    options.diffContext === undefined ? {} : { diffContextLines: options.diffContext },
  );
  const context = await buildReviewContext(changeSet, provider, {
    exclude: [...DEFAULT_EXCLUDE_GLOBS, ...config.review.exclude],
    budget: {
      ...config.review.context,
      ...(options.surrounding === undefined ? {} : { surroundingLines: options.surrounding }),
    },
  });
  return { info, configSource: source, config, context };
}
