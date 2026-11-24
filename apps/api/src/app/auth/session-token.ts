import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingHttpHeaders } from 'node:http';

/** Session cookie name. The `__Host-` prefix (production) pins it to this origin, path `/`, Secure. */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-acra_session' : 'acra_session';
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Reads one cookie from the Cookie header without a parsing dependency. */
export function readCookie(headers: IncomingHttpHeaders, name: string): string | null {
  const header = headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** Only tokens this server could have issued (32 random bytes, base64url) are considered. */
export function isWellFormedSessionToken(token: string | null): token is string {
  return token !== null && TOKEN_PATTERN.test(token);
}

/**
 * CSRF token bound to the session: SHA-256 over a domain-separated session token. The browser
 * gets it in the session response (readable by our JS only) and echoes it in `X-CSRF-Token`;
 * a cross-site page can neither read it nor compute it, and it changes with every session.
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHash('sha256').update(`acra-csrf:v1:${sessionToken}`, 'utf8').digest('base64url');
}

export function csrfTokenMatches(sessionToken: string, presented: string | undefined | string[]): boolean {
  if (typeof presented !== 'string' || presented.length > 100) return false;
  const expected = Buffer.from(csrfTokenFor(sessionToken), 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function serializeSessionCookie(input: {
  name: string;
  value: string;
  maxAgeSeconds: number;
  secure: boolean;
}): string {
  return [
    `${input.name}=${input.value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(input.maxAgeSeconds))}`,
    ...(input.secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(name: string, secure: boolean): string {
  return serializeSessionCookie({ name, value: '', maxAgeSeconds: 0, secure });
}
