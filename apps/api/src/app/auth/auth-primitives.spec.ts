import { AttemptLimiter } from './login-throttle';
import { hashPassword, needsRehash, verifyPassword } from './password';
import {
  csrfTokenFor,
  csrfTokenMatches,
  isWellFormedSessionToken,
  readCookie,
  serializeSessionCookie,
  sessionCookieName,
} from './session-token';

// Cheap parameters keep unit tests fast; production uses DEFAULT_SCRYPT_PARAMS.
const FAST = { N: 2 ** 10, r: 8, p: 1 };

describe('password hashing', () => {
  it('verifies the right password only', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password here', FAST)).not.toBe(await hashPassword('same password here', FAST));
  });

  it('normalises Unicode so visually identical passwords match', async () => {
    const composed = `caf${String.fromCodePoint(0xe9)}-password-1`; // é as one code point (NFC)
    const decomposed = `cafe${String.fromCodePoint(0x301)}-password-1`; // e + combining accent (NFD)
    expect(composed).not.toBe(decomposed);
    const hash = await hashPassword(composed, FAST);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  });

  it('never verifies malformed or abusive hashes', async () => {
    for (const bad of [
      '',
      'plain',
      'scrypt$1$8$1$abc$def',
      'bcrypt$x',
      `scrypt$${2 ** 30}$8$1$c2FsdHNhbHQ$${'A'.repeat(43)}`,
    ]) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('flags hashes made with weaker parameters for rehashing', async () => {
    expect(needsRehash(await hashPassword('another password', FAST))).toBe(true);
  });
});

describe('session cookie and CSRF token', () => {
  const token = 'A'.repeat(43);

  it('reads only the named cookie', () => {
    expect(readCookie({ cookie: 'other=1; acra_session=abc; x=y' }, 'acra_session')).toBe('abc');
    expect(readCookie({ cookie: 'xacra_session=abc' }, 'acra_session')).toBeNull();
    expect(readCookie({}, 'acra_session')).toBeNull();
  });

  it('accepts only tokens the server could have issued', () => {
    expect(isWellFormedSessionToken(token)).toBe(true);
    expect(isWellFormedSessionToken(`${token}A`)).toBe(false);
    expect(isWellFormedSessionToken("' OR 1=1 --")).toBe(false);
    expect(isWellFormedSessionToken(null)).toBe(false);
  });

  it('binds the CSRF token to the session', () => {
    const csrf = csrfTokenFor(token);
    expect(csrfTokenMatches(token, csrf)).toBe(true);
    expect(csrfTokenMatches('B'.repeat(43), csrf)).toBe(false);
    expect(csrfTokenMatches(token, undefined)).toBe(false);
    expect(csrfTokenMatches(token, [csrf, csrf])).toBe(false);
    expect(csrf).not.toContain(token);
  });

  it('uses a __Host- Secure cookie in production', () => {
    expect(sessionCookieName(true)).toBe('__Host-acra_session');
    const cookie = serializeSessionCookie({
      name: '__Host-acra_session',
      value: token,
      maxAgeSeconds: 60,
      secure: true,
    });
    expect(cookie).toBe(`__Host-acra_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=60; Secure`);
  });
});

describe('AttemptLimiter', () => {
  it('refuses attempts over the budget within the window and recovers after it', () => {
    const limiter = new AttemptLimiter(3, 1_000);
    expect([0, 1, 2, 3].map((t) => limiter.tryConsume('ip', t))).toEqual([true, true, true, false]);
    expect(limiter.tryConsume('other', 3)).toBe(true);
    expect(limiter.tryConsume('ip', 1_001)).toBe(true);
  });

  it('stays bounded under a key-spraying attack', () => {
    const limiter = new AttemptLimiter(1, 60_000, 100);
    for (let i = 0; i < 1_000; i++) limiter.tryConsume(`key-${i}`, i);
    expect((limiter as unknown as { attempts: Map<string, number[]> }).attempts.size).toBeLessThanOrEqual(101);
  });
});
