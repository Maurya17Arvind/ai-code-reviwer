import { signWebhookPayload, verifyWebhookSignature } from './webhook-signature';

describe('webhook HMAC signatures', () => {
  const secret = "It's a Secret to Everybody";
  const body = Buffer.from('Hello, World!');

  it('matches the GitHub documentation test vector', () => {
    expect(signWebhookPayload(secret, body)).toBe(
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    );
  });

  it('accepts the right signature and rejects anything else', () => {
    const signature = signWebhookPayload(secret, body);
    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, Buffer.from('Hello, World?'), signature)).toBe(false);
    expect(verifyWebhookSignature('other secret', body, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, body, signature.toUpperCase())).toBe(false);
    expect(verifyWebhookSignature(secret, body, signature.replace('sha256=', 'sha1='))).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature('', body, signature)).toBe(false);
  });
});
