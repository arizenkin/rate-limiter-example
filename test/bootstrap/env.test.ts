import { createHash } from 'node:crypto';
import { parseEnv } from '../../src/bootstrap/env';
import { StartupError } from '../../src/bootstrap/startup-error';

const H1 = 'a'.repeat(64);
const H2 = 'B'.repeat(64);
const required = { ADMIN_API_KEYS: H1 };

describe('parseEnv', () => {
  it('applies defaults', () => {
    expect(parseEnv({ ...required })).toEqual({
      port: 3000,
      host: '0.0.0.0',
      seedFile: 'config/clients.json',
      logLevel: 'info',
      sweepIntervalMs: 30_000,
      maxClients: 100_000,
      shutdownGraceMs: 5000,
      adminKeyHashes: [H1],
    });
  });

  it('reads overrides', () => {
    expect(
      parseEnv({
        PORT: '8080',
        HOST: '127.0.0.1',
        SEED_FILE: '/x.json',
        LOG_LEVEL: 'warn',
        SWEEP_INTERVAL_MS: '100',
        MAX_CLIENTS: '50',
        SHUTDOWN_GRACE_MS: '250',
        ADMIN_API_KEYS: ` ${H1} , ${H2},`,
      }),
    ).toEqual({
      port: 8080,
      host: '127.0.0.1',
      seedFile: '/x.json',
      logLevel: 'warn',
      sweepIntervalMs: 100,
      maxClients: 50,
      shutdownGraceMs: 250,
      adminKeyHashes: [H1, H2.toLowerCase()],
    });
  });

  it.each([
    [{ PORT: 'abc' }, 'PORT must be an integer'],
    [{ PORT: '' }, 'PORT must be an integer'],
    [{ PORT: '70000' }, 'PORT must be between 0 and 65535'],
    [{ HOST: '' }, 'HOST must not be empty'],
    [{ SEED_FILE: '' }, 'SEED_FILE must not be empty'],
    [{ LOG_LEVEL: 'loud' }, 'LOG_LEVEL must be one of'],
    [{ MAX_CLIENTS: '0' }, 'MAX_CLIENTS must be between 1 and 10000000'],
    [{ SWEEP_INTERVAL_MS: '1' }, 'SWEEP_INTERVAL_MS must be between 10 and 3600000'],
    [{ SHUTDOWN_GRACE_MS: '60001' }, 'SHUTDOWN_GRACE_MS must be between 0 and 60000'],
  ])('rejects %j', (env, message) => {
    expect(() => parseEnv({ ...required, ...env })).toThrow(StartupError);
    expect(() => parseEnv({ ...required, ...env })).toThrow(message);
  });

  it('reports every problem at once', () => {
    expect(() => parseEnv({ ...required, PORT: 'x', LOG_LEVEL: 'y' })).toThrow(/PORT.*; LOG_LEVEL/);
  });

  describe('ADMIN_API_KEYS', () => {
    it.each([
      [{}, 'ADMIN_API_KEYS is required'],
      [{ ADMIN_API_KEYS: '' }, 'must contain at least one SHA-256 hex digest'],
      [{ ADMIN_API_KEYS: ' , ,' }, 'must contain at least one SHA-256 hex digest'],
      [
        { ADMIN_API_KEYS: createHash('sha256').update('').digest('hex') },
        'entry 1 is the digest of an empty key',
      ],
      [{ ADMIN_API_KEYS: 'plaintext-key' }, 'entry 1 must be a 64-character SHA-256 hex digest'],
      [{ ADMIN_API_KEYS: `${H1},${'g'.repeat(64)}` }, 'entry 2 must be a 64-character'],
      [{ ADMIN_API_KEYS: `${H1},${H1.toUpperCase()}` }, 'entry 2 duplicates entry 1'],
      [
        { ADMIN_API_KEYS: Array.from({ length: 11 }, (_, i) => String(i).repeat(64)).join(',') },
        'must contain at most 10 keys',
      ],
    ])('rejects %j', (env, message) => {
      expect(() => parseEnv(env)).toThrow(StartupError);
      expect(() => parseEnv(env)).toThrow(message);
    });

    it('accepts ten distinct keys', () => {
      const keys = Array.from({ length: 10 }, (_, i) => String(i).repeat(64));
      expect(parseEnv({ ADMIN_API_KEYS: keys.join(',') }).adminKeyHashes).toEqual(keys);
    });

    it('never echoes the supplied value in the error', () => {
      const bad = 'super-secret-plaintext-key';
      expect(() => parseEnv({ ADMIN_API_KEYS: bad })).not.toThrow(new RegExp(bad));
    });
  });
});
