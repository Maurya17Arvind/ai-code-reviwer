import { decryptSecret, type EncryptedSecret, type MasterKey, type OutboundPolicy } from '@acra/security';
import { GitLabClient } from './gitlab-client';
import { GitLabProvider } from './gitlab-provider';

export interface StoredGitLabConnection {
  readonly id: string;
  readonly baseUrl: string;
  readonly encryptedToken: unknown;
}

/** AAD binding an encrypted token to its connection row (ADR-011). */
export function connectionSecretContext(connectionId: string): string {
  return `provider_connection:${connectionId}`;
}

/**
 * Builds a GitLab provider from a stored connection. The token is decrypted in memory only for the
 * client's lifetime; the base URL is re-validated against the SSRF policy before the first request.
 */
export function gitLabProviderFromConnection(
  connection: StoredGitLabConnection,
  projectId: number,
  options: { readonly masterKey: MasterKey; readonly policy: OutboundPolicy; readonly fetchImpl?: typeof fetch },
): GitLabProvider {
  const token = decryptSecret(
    connection.encryptedToken as EncryptedSecret,
    options.masterKey,
    connectionSecretContext(connection.id),
  );
  const client = new GitLabClient({
    baseUrl: connection.baseUrl,
    token,
    policy: options.policy,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return new GitLabProvider(client, projectId);
}

/** Resolves "group/project" or a numeric id to the numeric project id. */
export async function resolveGitLabProjectId(client: GitLabClient, idOrPath: string): Promise<number> {
  if (/^\d+$/.test(idOrPath)) return Number(idOrPath);
  const project = await client.get<{ id: number }>(`/projects/${encodeURIComponent(idOrPath)}`);
  return project.id;
}
