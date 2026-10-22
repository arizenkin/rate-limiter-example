import { randomBytes } from 'node:crypto';
import { createApiKeyPair } from '../src/adapters/out/sha256-api-key-verifier';

const { key, hash } = createApiKeyPair(randomBytes(32));
console.log(`API key (give to the caller, shown only once):\n  ${key}\n`);
console.log(`Service configuration (store the hash, not the key):\n  ADMIN_API_KEYS=${hash}`);
