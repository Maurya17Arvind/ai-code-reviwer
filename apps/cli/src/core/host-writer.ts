import { GitHubClient, GitHubProvider } from '@acra/git-providers-github';
import { GitLabClient, GitLabProvider, resolveGitLabProjectId } from '@acra/git-providers-gitlab';
import { type HostWriterFactory } from '../commands/fix.command';

/**
 * Real GitLab/GitHub writers for `ai-review fix open`, authenticated with the user's own token from
 * the environment. The only allowed host is the one the fix was pushed to (SSRF policy).
 */
export const defaultHostWriter: HostWriterFactory = async ({ provider, host, projectPath, token }) => {
  if (provider === 'gitlab') {
    const client = new GitLabClient({ baseUrl: `https://${host}`, token, policy: { allowedHosts: [host] } });
    return new GitLabProvider(client, await resolveGitLabProjectId(client, projectPath));
  }
  const dotCom = host === 'github.com';
  const client = new GitHubClient({
    apiBaseUrl: dotCom ? 'https://api.github.com' : `https://${host}/api/v3`,
    token: () => Promise.resolve(token),
    policy: { allowedHosts: [dotCom ? 'api.github.com' : host] },
  });
  return new GitHubProvider(client, projectPath, { botLogin: '' });
};
