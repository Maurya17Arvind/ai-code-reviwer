import { randomBytes, scrypt, type ScryptOptions, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with scrypt from node:crypto (no native dependency). Parameters follow the
 * OWASP Password Storage Cheat Sheet minimum for scrypt (N=2^17, r=8, p=1); each hash records its
 * own parameters so they can be raised later without invalidating stored hashes.
 *
 * Format: `scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>`
 */
export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Constant-time verification. Malformed hashes never verify (and never throw). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0) || N > 2 ** 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const expected = Buffer.from(parts[5] ?? '', 'base64url');
  if (salt.length < 8 || expected.length !== KEY_LENGTH) return false;
  try {
    const actual = await derive(password, salt, { N, r, p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when the stored hash uses weaker parameters than the current default (rehash on login). */
export function needsRehash(stored: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): boolean {
  const [, N, r, p] = stored.split('$').map(Number);
  return N !== params.N || r !== params.r || p !== params.p;
}

let dummyHash: Promise<string> | undefined;
/**
 * A valid hash of a random password. Verifying against it when the e-mail is unknown keeps the
 * response time of "no such user" equal to "wrong password" (no account enumeration by timing).
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}
