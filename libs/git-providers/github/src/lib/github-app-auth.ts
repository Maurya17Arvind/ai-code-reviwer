import { type OutboundPolicy } from '@acra/security';
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { GitHubApiError, GitHubClient } from './github-client';

export interface GitHubAppCredentials {
  readonly appId: string;
  /** PEM (PKCS#1 or PKCS#8). Escaped "\n" sequences from env files are accepted. */
  readonly privateKey: string;
  readonly apiBaseUrl: string;
  readonly policy: OutboundPolicy;
  readonly fetchImpl?: typeof fetch;
}

/** Least privilege for review: read code and metadata, write PR review comments (PR + issue comments). */
export const REVIEW_TOKEN_PERMISSIONS = { contents: 'read', metadata: 'read', pull_requests: 'write' } as const;

/**
 * Permissions for executing an approved fix (Phase 6): create the fix branch/commit and open the PR.
 * Requested only by the approval executor, never by review jobs.
 */
export const WRITE_TOKEN_PERMISSIONS = { contents: 'write', metadata: 'read', pull_requests: 'write' } as const;

export type TokenPermissions = typeof REVIEW_TOKEN_PERMISSIONS | typeof WRITE_TOKEN_PERMISSIONS;

const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** RS256 JWT for GitHub App authentication (valid 9 minutes, backdated 60 s for clock skew). */
export function createAppJwt(appId: string, key: KeyObject, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key);
  return `${header}.${payload}.${base64url(signature)}`;
}

export interface InstallationInfo {
  readonly id: number;
  readonly account: { readonly login: string; readonly type: string };
}

/**
 * GitHub App authentication: app JWT for /app endpoints, and short-lived installation tokens
 * (scoped to one repository and the minimal permissions) cached until shortly before expiry.
 */
export class GitHubAppAuth {
  private readonly key: KeyObject;
  private readonly appClient: GitHubClient;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private slug: Promise<string> | undefined;

  constructor(private readonly credentials: GitHubAppCredentials) {
    if (!/^\d+$/.test(credentials.appId)) throw new GitHubApiError(0, 'GITHUB_APP_ID must be numeric');
    try {
      this.key = createPrivateKey(credentials.privateKey.replace(/\\n/g, '\n'));
    } catch {
      throw new GitHubApiError(0, 'GITHUB_APP_PRIVATE_KEY is not a valid PEM private key');
    }
    this.appClient = this.client(() => Promise.resolve(createAppJwt(credentials.appId, this.key)));
  }

  /** Bot login used for the app's comments, e.g. "acra-review[bot]". */
  async botLogin(): Promise<string> {
    this.slug ??= this.appClient.get<{ slug: string }>('/app').then((app) => app.slug);
    return `${await this.slug}[bot]`;
  }

  getInstallation(installationId: number): Promise<InstallationInfo> {
    return this.appClient.get<InstallationInfo>(`/app/installations/${installationId}`);
  }

  /** Installation token, optionally restricted to specific repositories. */
  async installationToken(
    installationId: number,
    repositoryIds?: readonly number[],
    permissions: TokenPermissions = REVIEW_TOKEN_PERMISSIONS,
  ): Promise<string> {
    const cacheKey = `${installationId}:${repositoryIds?.join(',') ?? '*'}:${permissions.contents}`;
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const response = await this.appClient.post<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      { ...(repositoryIds ? { repository_ids: repositoryIds } : {}), permissions },
    );
    this.tokens.set(cacheKey, { token: response.token, expiresAt: Date.parse(response.expires_at) });
    return response.token;
  }

  /** Client authenticated as the installation (optionally scoped to repositories). */
  installationClient(
    installationId: number,
    repositoryIds?: readonly number[],
    permissions: TokenPermissions = REVIEW_TOKEN_PERMISSIONS,
  ): GitHubClient {
    return this.client(() => this.installationToken(installationId, repositoryIds, permissions));
  }

  private client(token: () => Promise<string>): GitHubClient {
    return new GitHubClient({
      apiBaseUrl: this.credentials.apiBaseUrl,
      token,
      policy: this.credentials.policy,
      ...(this.credentials.fetchImpl ? { fetchImpl: this.credentials.fetchImpl } : {}),
    });
  }
}
