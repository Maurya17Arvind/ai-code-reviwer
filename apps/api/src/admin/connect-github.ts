import { type GitHubAppSettings } from '@acra/configuration';
import { type ConnectionStore } from '@acra/database';
import { GitHubAppAuth } from '@acra/git-providers-github';

export interface ConnectGitHubOptions {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly installationId: number;
}

export interface ConnectGitHubDeps {
  readonly connections: ConnectionStore;
  readonly app: GitHubAppSettings;
  readonly fetchImpl?: typeof fetch;
}

export interface ConnectGitHubResult {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly accountLogin: string;
  readonly repositories: readonly string[];
}

interface InstallationRepository {
  id: number;
  full_name: string;
  default_branch: string;
  html_url: string;
}

/**
 * Connects a GitHub App installation to an organization: verifies the installation with the App JWT,
 * stores the connection (no secret is stored — tokens are minted per job) and registers every
 * repository the installation can access. Repositories no longer granted are deactivated.
 * Safe to re-run. The webhook is configured once on the App itself (see docs/GITHUB.md).
 */
export async function connectGitHubInstallation(
  deps: ConnectGitHubDeps,
  options: ConnectGitHubOptions,
): Promise<ConnectGitHubResult> {
  if (!Number.isSafeInteger(options.installationId) || options.installationId <= 0) {
    throw new Error('--installation must be a positive integer');
  }
  const auth = new GitHubAppAuth({ ...deps.app, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  const installation = await auth.getInstallation(options.installationId);
  const repositories = await auth
    .installationClient(options.installationId)
    .paginate<InstallationRepository>('/installation/repositories', {}, (page) =>
      Array.isArray((page as { repositories?: unknown }).repositories)
        ? (page as { repositories: InstallationRepository[] }).repositories
        : [],
    );

  const tenant = await deps.connections.ensureOrganization(options.organizationSlug, options.organizationName);
  const connection = await deps.connections.saveGitHubConnection(tenant, {
    installationId: options.installationId,
    accountLogin: installation.account.login,
    apiBaseUrl: deps.app.apiBaseUrl,
  });
  await deps.connections.syncGitHubRepositories(
    tenant,
    connection.id,
    repositories.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      ...(r.html_url.startsWith('https://') || r.html_url.startsWith('http://') ? { webUrl: r.html_url } : {}),
    })),
    { exclusive: true },
  );
  return {
    organizationId: tenant.organizationId,
    connectionId: connection.id,
    accountLogin: installation.account.login,
    repositories: repositories.map((r) => r.full_name),
  };
}
