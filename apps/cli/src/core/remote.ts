import { CliError } from './cli-context';

export interface ParsedRemote {
  readonly host: string;
  /** "group/sub/project" or "owner/repo" (no .git). */
  readonly path: string;
}

/**
 * Parses an `origin` URL (https, ssh://, or scp-like git@host:path) into host and project path.
 * Credentials in the URL are ignored and never used.
 */
export function parseRemote(url: string): ParsedRemote {
  let host: string;
  let path: string;
  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)(.+)$/.exec(url);
  if (scp?.[1] && scp[2]) {
    host = scp[1];
    path = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CliError('Could not parse the remote URL');
    }
    if (!['https:', 'ssh:', 'http:'].includes(parsed.protocol)) throw new CliError('Unsupported remote URL scheme');
    host = parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  }
  path = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(path) || path.split('/').includes('..')) {
    throw new CliError('Remote URL does not name a project path');
  }
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new CliError('Remote URL has an invalid host');
  return { host: host.toLowerCase(), path };
}

export function detectHostProvider(host: string): 'github' | 'gitlab' | null {
  if (host === 'github.com' || host.startsWith('github.')) return 'github';
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) return 'gitlab';
  return null;
}
