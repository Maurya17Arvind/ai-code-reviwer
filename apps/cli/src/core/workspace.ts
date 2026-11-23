import {
  defaultReviewConfig,
  parseReviewConfig,
  REVIEW_CONFIG_FILENAME,
  type ReviewConfig,
  ReviewConfigError,
} from '@acra/configuration';
import { GitProviderError } from '@acra/git-providers-core';
import { LocalGitProvider } from '@acra/git-providers-local';
import { resolve } from 'node:path';
import { CliError, type CliIO } from './cli-context';

export interface GlobalOptions {
  readonly repo?: string;
}

export type LoadedConfig =
  | { readonly source: 'file'; readonly config: ReviewConfig }
  | { readonly source: 'default'; readonly config: ReviewConfig };

/** Opens the repository selected by `--repo` (default: current directory). */
export async function openRepository(io: CliIO, options: GlobalOptions): Promise<LocalGitProvider> {
  try {
    return await LocalGitProvider.open(resolve(io.cwd, options.repo ?? '.'));
  } catch (error) {
    throw toCliError(error);
  }
}

/**
 * Loads `ai-review.yaml` from the working tree of the repository root. The file is untrusted
 * repository content and is read through the provider (path-safe, size-limited) and validated.
 */
export async function loadRepositoryConfig(provider: LocalGitProvider): Promise<LoadedConfig> {
  const file = await provider.readFile(REVIEW_CONFIG_FILENAME, { kind: 'worktree' });
  if (file === null) return { source: 'default', config: defaultReviewConfig() };
  if (file.isBinary || file.tooLarge) throw new CliError(`${REVIEW_CONFIG_FILENAME} is not a readable text file`);
  try {
    return { source: 'file', config: parseReviewConfig(file.content) };
  } catch (error) {
    throw toCliError(error);
  }
}

export function toCliError(error: unknown): Error {
  if (error instanceof CliError) return error;
  if (error instanceof GitProviderError || error instanceof ReviewConfigError) return new CliError(error.message);
  return error instanceof Error ? error : new Error(String(error));
}
