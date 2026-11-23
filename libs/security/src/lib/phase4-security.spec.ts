import {
  CredentialCryptoError,
  decryptSecret,
  encryptSecret,
  generateMasterKey,
  generateToken,
  hashToken,
  parseMasterKey,
  tokenMatchesHash,
} from './envelope-crypto';
import { assertSafeOutboundUrl, isPrivateAddress, UnsafeOutboundUrlError } from './outbound-url';

describe('envelope encryption', () => {
  const master = parseMasterKey(generateMasterKey());

  it('round-trips and produces a fresh ciphertext every time', () => {
    const a = encryptSecret('glpat-secret-token', master, 'provider_connection:1');
    const b = encryptSecret('glpat-secret-token', master, 'provider_connection:1');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(JSON.stringify(a)).not.toContain('glpat-secret-token');
    expect(decryptSecret(a, master, 'provider_connection:1')).toBe('glpat-secret-token');
  });

  it('rejects the wrong context, wrong key and tampering', () => {
    const sealed = encryptSecret('s3cret', master, 'provider_connection:1');
    expect(() => decryptSecret(sealed, master, 'provider_connection:2')).toThrow(CredentialCryptoError);
    expect(() =>
      decryptSecret(sealed, { ...parseMasterKey(generateMasterKey()), id: master.id }, 'provider_connection:1'),
    ).toThrow(CredentialCryptoError);
    const tampered = { ...sealed, ciphertext: Buffer.from('x' + sealed.ciphertext).toString('base64') };
    expect(() => decryptSecret(tampered, master, 'provider_connection:1')).toThrow(CredentialCryptoError);
  });

  it('validates master keys without echoing them', () => {
    expect(() => parseMasterKey('too-short')).toThrow(/32 bytes/);
    expect(parseMasterKey(`k2:${generateMasterKey()}`).id).toBe('k2');
  });

  it('hashes webhook tokens and compares in constant time', () => {
    const token = generateToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(tokenMatchesHash(token, hashToken(token))).toBe(true);
    expect(tokenMatchesHash('wrong', hashToken(token))).toBe(false);
    expect(tokenMatchesHash(token, 'abcd')).toBe(false);
  });
});

describe('assertSafeOutboundUrl (SSRF guard)', () => {
  const resolveTo =
    (...addresses: string[]) =>
    () =>
      Promise.resolve(addresses);
  const policy = { allowedHosts: ['gitlab.com', 'gitlab.example.org'], resolve: resolveTo('172.65.251.78') };

  it('accepts allowlisted https hosts resolving to public addresses', async () => {
    await expect(assertSafeOutboundUrl('https://gitlab.com/api/v4', policy)).resolves.toBeInstanceOf(URL);
  });

  it.each([
    ['http://gitlab.com', /only https/],
    ['https://user:pw@gitlab.com', /credentials/],
    ['https://evil.example', /allowlist/],
    ['https://gitlab.com:8443', /non-standard ports/],
    ['not a url', /valid URL/],
  ])('rejects %s', async (url, reason) => {
    await expect(assertSafeOutboundUrl(url, policy)).rejects.toThrow(reason);
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.1.5',
    '172.20.0.1',
    '::1',
    'fd00::1',
    '::ffff:10.0.0.1',
    '100.64.0.1',
  ])('rejects allowlisted hosts that resolve to private address %s', async (address) => {
    await expect(
      assertSafeOutboundUrl('https://gitlab.example.org', { ...policy, resolve: resolveTo('8.8.8.8', address) }),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });

  it('allows private networks and http only when explicitly enabled', async () => {
    const local = { allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true };
    await expect(assertSafeOutboundUrl('http://127.0.0.1:8929', local)).resolves.toBeInstanceOf(URL);
  });

  it('classifies addresses', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
    expect(isPrivateAddress('0.0.0.0')).toBe(true);
  });
});
