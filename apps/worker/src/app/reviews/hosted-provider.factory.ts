import { type GitHubAppSettings, resolveGitHubAppSettings } from '@acra/configuration';
import { type HostedGitProvider } from '@acra/git-providers-core';
import { GitHubAppAuth, GitHubProvider } from '@acra/git-providers-github';
import { gitLabProviderFromConnection } from '@acra/git-providers-gitlab';
import { parseMasterKey } from '@acra/security';
import { Inject, Injectable } from '@nestjs/common';
import { WORKER_CONFIG, type WorkerConfig } from '../worker-config';

/** What the worker knows about a repository's connection (from ReviewStore.findRepositoryForReview). */
export interface ReviewRepository {
  readonly id: string;
  readonly provider: string;
  readonly externalId: string | null;
  readonly fullName: string;
  readonly connection: {
    readonly id: string;
    readonly provider: string;
    readonly baseUrl: string;
    readonly encryptedToken: unknown;
    readonly installationId: string | null;
  };
}

/** Thrown when a repository cannot be reviewed with the current configuration (never retried). */
export class ProviderConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}

/**
 * Builds the hosted-provider adapter for a repository. GitLab uses the connection's encrypted token;
 * GitHub uses the App: one JWT-authenticated client per process (installation tokens are cached in it),
 * with each job getting a token scoped to just its repository.
 */
@Injectable()
export class HostedProviderFactory {
  private gitHubApp: { auth: GitHubAppAuth; botLogin: Promise<string> } | undefined;
  private readonly gitHubSettings: GitHubAppSettings | null;

  constructor(@Inject(WORKER_CONFIG) private readonly config: WorkerConfig) {
    this.gitHubSettings = resolveGitHubAppSettings(config);
  }

  async forRepository(repository: ReviewRepository): Promise<HostedGitProvider> {
    if (repository.connection.provider !== repository.provider) {
      throw new ProviderConfigurationError('connection_mismatch', 'Repository and connection providers differ');
    }
    if (repository.provider === 'GITLAB') return this.gitLab(repository);
    if (repository.provider === 'GITHUB') return this.gitHub(repository);
    throw new ProviderConfigurationError('unsupported_provider', 'Repository provider is not a hosted provider');
  }

  private gitLab(repository: ReviewRepository): HostedGitProvider {
    const projectId = Number(repository.externalId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      throw new ProviderConfigurationError('invalid_project', 'Repository has no GitLab project id');
    }
    if (!repository.connection.encryptedToken) {
      throw new ProviderConfigurationError('missing_token', 'GitLab connection has no stored token');
    }
    return gitLabProviderFromConnection(repository.connection, projectId, {
      masterKey: parseMasterKey(this.config.CREDENTIALS_MASTER_KEY),
      policy: {
        allowedHosts: this.config.GITLAB_ALLOWED_HOSTS,
        allowPrivateNetwork: this.config.GITLAB_ALLOW_PRIVATE_NETWORK,
      },
    });
  }

  private async gitHub(repository: ReviewRepository): Promise<HostedGitProvider> {
    const installationId = Number(repository.connection.installationId);
    const repositoryId = Number(repository.externalId);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new ProviderConfigurationError('missing_installation', 'GitHub connection has no installation id');
    }
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      throw new ProviderConfigurationError('invalid_project', 'Repository has no GitHub repository id');
    }
    const app = this.app();
    return new GitHubProvider(app.auth.installationClient(installationId, [repositoryId]), repository.fullName, {
      botLogin: await app.botLogin,
    });
  }

  private app(): { auth: GitHubAppAuth; botLogin: Promise<string> } {
    if (!this.gitHubSettings) {
      throw new ProviderConfigurationError('github_not_configured', 'GitHub App is not configured on this worker');
    }
    if (!this.gitHubApp) {
      const auth = new GitHubAppAuth(this.gitHubSettings);
      const botLogin = auth.botLogin();
      // Do not cache a failed lookup: the next job retries it.
      botLogin.catch(() => (this.gitHubApp = undefined));
      this.gitHubApp = { auth, botLogin };
    }
    return this.gitHubApp;
  }
}
