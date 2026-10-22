import { createHash } from 'node:crypto';
import {
  createApiKeyPair,
  Sha256ApiKeyVerifier,
} from '../../../src/adapters/out/sha256-api-key-verifier';

const hashOf = (key: string) => createHash('sha256').update(key).digest('hex');

describe('Sha256ApiKeyVerifier', () => {
  const verifier = new Sha256ApiKeyVerifier([hashOf('key-one'), hashOf('key-two').toUpperCase()]);

  it('accepts a configured key and returns the first 8 hex chars of its digest as keyId', () => {
    expect(verifier.verify('key-one')).toEqual({ keyId: hashOf('key-one').slice(0, 8) });
  });

  it('accepts any of several configured keys (rotation), including upper-case digests', () => {
    expect(verifier.verify('key-two')).toEqual({ keyId: hashOf('key-two').slice(0, 8) });
  });

  it.each([undefined, '', 'key-on', 'key-one ', 'KEY-ONE', 'key-one, key-one', 'x'.repeat(5000)])(
    'rejects %j',
    (presented) => {
      expect(verifier.verify(presented)).toBeUndefined();
    },
  );

  it('never authenticates an absent or empty key, even if the digest of "" is configured', () => {
    const emptyDigest = hashOf('');
    const risky = new Sha256ApiKeyVerifier([emptyDigest]);
    expect(risky.verify(undefined)).toBeUndefined();
    expect(risky.verify('')).toBeUndefined();
    expect(risky.verify('anything')).toBeUndefined();
  });

  it.each(['abcd', 'a'.repeat(63), 'a'.repeat(66)])(
    'refuses digests that are not 32 bytes (%j)',
    (bad) => {
      expect(() => new Sha256ApiKeyVerifier([bad])).toThrow('32-byte SHA-256');
    },
  );

  it('rejects everything when no key is configured', () => {
    expect(new Sha256ApiKeyVerifier([]).verify('key-one')).toBeUndefined();
  });

  it('never exposes the key or the full digest in the keyId', () => {
    const { keyId } = verifier.verify('key-one') ?? { keyId: '' };
    expect(keyId).toHaveLength(8);
    expect(keyId).not.toContain('key-one');
  });
});

describe('createApiKeyPair', () => {
  it('derives a url-safe key and the sha256 digest the verifier accepts', () => {
    const pair = createApiKeyPair(Buffer.alloc(32, 7));
    expect(pair.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.hash).toBe(hashOf(pair.key));
    expect(new Sha256ApiKeyVerifier([pair.hash]).verify(pair.key)).toBeDefined();
  });

  it('produces different keys for different random bytes', () => {
    expect(createApiKeyPair(Buffer.alloc(32, 1)).key).not.toBe(
      createApiKeyPair(Buffer.alloc(32, 2)).key,
    );
  });
});
