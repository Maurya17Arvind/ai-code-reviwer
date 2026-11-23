import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Envelope encryption for stored credentials (ADR-011).
 *
 * Each secret gets its own random 256-bit data key (DEK). The payload is encrypted with the DEK
 * (AES-256-GCM); the DEK is encrypted ("wrapped") with the master key (AES-256-GCM). Rotating the
 * master key only re-wraps DEKs. The master key comes from CREDENTIALS_MASTER_KEY (base64, 32
 * bytes) today and from a KMS in production.
 */
export interface EncryptedSecret {
  readonly v: 1;
  /** Master key identifier, for rotation. */
  readonly kid: string;
  readonly wrappedKey: string;
  readonly wrapIv: string;
  readonly wrapTag: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export interface MasterKey {
  readonly id: string;
  readonly key: Buffer;
}

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialCryptoError';
  }
}

/** Parses CREDENTIALS_MASTER_KEY ("base64" or "<kid>:<base64>"). Never echoes the value. */
export function parseMasterKey(value: string): MasterKey {
  const [maybeId, maybeKey] = value.includes(':') ? value.split(':', 2) : ['k1', value];
  const key = Buffer.from(maybeKey ?? '', 'base64');
  if (key.length !== 32) throw new CredentialCryptoError('CREDENTIALS_MASTER_KEY must be 32 bytes, base64-encoded');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(maybeId ?? '')) throw new CredentialCryptoError('Invalid master key id');
  return { id: maybeId as string, key };
}

export function generateMasterKey(): string {
  return randomBytes(32).toString('base64');
}

function seal(key: Buffer, plaintext: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function open(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * @param context Associated data binding the ciphertext to its owner (e.g. "provider_connection:<id>"),
 *                so a ciphertext copied to another row fails to decrypt.
 */
export function encryptSecret(plaintext: string, master: MasterKey, context: string): EncryptedSecret {
  const dek = randomBytes(32);
  try {
    const payload = seal(dek, Buffer.from(plaintext, 'utf8'), context);
    const wrapped = seal(master.key, dek, `dek:${context}`);
    return {
      v: 1,
      kid: master.id,
      wrappedKey: wrapped.ciphertext.toString('base64'),
      wrapIv: wrapped.iv.toString('base64'),
      wrapTag: wrapped.tag.toString('base64'),
      iv: payload.iv.toString('base64'),
      tag: payload.tag.toString('base64'),
      ciphertext: payload.ciphertext.toString('base64'),
    };
  } finally {
    dek.fill(0);
  }
}

export function decryptSecret(secret: EncryptedSecret, master: MasterKey, context: string): string {
  if (secret.v !== 1) throw new CredentialCryptoError('Unsupported secret format');
  if (secret.kid !== master.id) throw new CredentialCryptoError(`Secret was encrypted with master key "${secret.kid}"`);
  const b = (value: string) => Buffer.from(value, 'base64');
  let dek: Buffer | undefined;
  try {
    dek = open(master.key, b(secret.wrapIv), b(secret.wrapTag), b(secret.wrappedKey), `dek:${context}`);
    return open(dek, b(secret.iv), b(secret.tag), b(secret.ciphertext), context).toString('utf8');
  } catch {
    throw new CredentialCryptoError('Secret could not be decrypted (wrong key or tampered data)');
  } finally {
    dek?.fill(0);
  }
}

/** Webhook secrets are stored only as SHA-256 hashes; received tokens are compared in constant time. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenMatchesHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
