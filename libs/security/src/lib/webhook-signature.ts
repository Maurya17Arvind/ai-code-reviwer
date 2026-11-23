import { createHmac, timingSafeEqual } from 'node:crypto';

/** Computes a GitHub-style `sha256=<hex>` signature over the exact request bytes. */
export function signWebhookPayload(secret: string, payload: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

/**
 * Verifies an `X-Hub-Signature-256` header (HMAC-SHA256 of the raw body) in constant time.
 * The body must be the raw bytes received — never a re-serialised JSON object.
 */
export function verifyWebhookSignature(secret: string, payload: Buffer, header: string | undefined): boolean {
  if (!secret || !header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = Buffer.from(signWebhookPayload(secret, payload), 'utf8');
  const actual = Buffer.from(header, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
