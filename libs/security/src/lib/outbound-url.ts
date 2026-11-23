import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF protection for outbound requests to user-configured hosts (self-hosted GitLab).
 *
 * - https only (http only when private networks are explicitly allowed, e.g. local development)
 * - no credentials in the URL, no unusual ports unless allowlisted
 * - the host must be on the allowlist, AND every resolved address must be public unless private
 *   networks are explicitly allowed (blocks 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 incl.
 *   cloud metadata, 100.64/10, ::1, fc00::/7, fe80::/10, IPv4-mapped forms, 0.0.0.0).
 *
 * Residual risk: DNS rebinding between this check and the connection. Mitigated by re-checking
 * before each request batch; a pinned-IP agent is planned for production hardening (Phase 8).
 */
export interface OutboundPolicy {
  /** Exact hostnames (lower case) allowed, e.g. ["gitlab.com", "gitlab.example.org"]. */
  readonly allowedHosts: readonly string[];
  /** Allow private/loopback addresses and plain http (development / on-prem). Default false. */
  readonly allowPrivateNetwork?: boolean;
  /** Injected resolver (tests). */
  readonly resolve?: (hostname: string) => Promise<string[]>;
}

export class UnsafeOutboundUrlError extends Error {
  constructor(reason: string) {
    super(`Outbound URL rejected: ${reason}`);
    this.name = 'UnsafeOutboundUrlError';
  }
}

export async function assertSafeOutboundUrl(rawUrl: string, policy: OutboundPolicy): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeOutboundUrlError('not a valid URL');
  }
  const allowPrivate = policy.allowPrivateNetwork ?? false;
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new UnsafeOutboundUrlError('only https is allowed');
  }
  if (url.username || url.password) throw new UnsafeOutboundUrlError('credentials in URL are not allowed');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!policy.allowedHosts.map((h) => h.toLowerCase()).includes(hostname)) {
    throw new UnsafeOutboundUrlError(`host "${hostname}" is not in the allowlist`);
  }
  if (url.port && !['443', '80'].includes(url.port) && !allowPrivate) {
    throw new UnsafeOutboundUrlError('non-standard ports require private-network mode');
  }

  const addresses = isIP(hostname)
    ? [hostname]
    : await (policy.resolve ?? defaultResolve)(hostname).catch(() => {
        throw new UnsafeOutboundUrlError(`host "${hostname}" does not resolve`);
      });
  if (addresses.length === 0) throw new UnsafeOutboundUrlError(`host "${hostname}" does not resolve`);
  if (!allowPrivate) {
    const blocked = addresses.find(isPrivateAddress);
    if (blocked) throw new UnsafeOutboundUrlError(`host "${hostname}" resolves to a private or reserved address`);
  }
  return url;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

export function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);

  if (isIP(lower) === 4) {
    const [a = 0, b = 0] = lower.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(lower) === 6) {
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith('ff')
    );
  }
  return true; // not an IP literal: treat as unsafe
}
