import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiKeyVerifier, VerifiedKey } from '../../application/ports/api-key-verifier';

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Verifies keys against configured SHA-256 digests; plaintext keys are never held. The presented
 * value is hashed first so every comparison is between equal-length digests, and all digests are
 * compared (no early exit) with `timingSafeEqual`.
 */
export class Sha256ApiKeyVerifier implements ApiKeyVerifier {
  private readonly digests: readonly Buffer[];

  constructor(hexDigests: readonly string[]) {
    this.digests = hexDigests.map((hex) => {
      const digest = Buffer.from(hex, 'hex');
      if (digest.length !== sha256('').length) {
        throw new Error('API key digests must be 32-byte SHA-256 values (64 hex characters)');
      }
      return digest;
    });
  }

  verify(presented: string | undefined): VerifiedKey | undefined {
    // An absent or empty key never authenticates, even if the digest of '' were configured.
    if (presented === undefined || presented === '') return undefined;
    const candidate = sha256(presented);
    let matched: Buffer | undefined;
    for (const digest of this.digests) {
      if (timingSafeEqual(candidate, digest)) matched = digest;
    }
    return matched === undefined ? undefined : { keyId: matched.toString('hex', 0, 4) };
  }
}

export interface ApiKeyPair {
  /** The secret to give to the caller; shown once. */
  readonly key: string;
  /** SHA-256 hex digest to put in `ADMIN_API_KEYS`. */
  readonly hash: string;
}

/** Derives a key (from 32 random bytes) and the digest the service is configured with. */
export function createApiKeyPair(randomBytes: Buffer): ApiKeyPair {
  const key = randomBytes.toString('base64url');
  return { key, hash: sha256(key).toString('hex') };
}
