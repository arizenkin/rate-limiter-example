import { z } from 'zod';
import { StartupError } from './startup-error';

export interface AppConfig {
  readonly port: number;
  readonly host: string;
  readonly seedFile: string;
  readonly logLevel: string;
  readonly sweepIntervalMs: number;
  readonly maxClients: number;
  /** How long `stop()` lets in-flight requests finish before closing their connections. */
  readonly shutdownGraceMs: number;
  /** Lower-case SHA-256 hex digests of the admin API keys. */
  readonly adminKeyHashes: readonly string[];
}

const integer = (name: string, min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, `${name} must be an integer`)
    .transform(Number)
    .pipe(
      z
        .number()
        .min(min, `${name} must be between ${min} and ${max}`)
        .max(max, `${name} must be between ${min} and ${max}`),
    );

const MAX_ADMIN_KEYS = 10;
/** SHA-256 of the empty string: what an unset shell variable would hash to. */
const EMPTY_KEY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Parses `ADMIN_API_KEYS`; messages name entries by position and never echo their values. */
const adminKeyHashes = z
  .string({
    error:
      'ADMIN_API_KEYS is required: comma-separated SHA-256 hex digests of the admin API keys (generate one with `pnpm gen-key`)',
  })
  .transform((raw, ctx) => {
    const fail = (message: string) => {
      ctx.issues.push({ code: 'custom', message: `ADMIN_API_KEYS ${message}`, input: raw });
      return z.NEVER;
    };
    const entries = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    if (entries.length === 0) return fail('must contain at least one SHA-256 hex digest');
    if (entries.length > MAX_ADMIN_KEYS) return fail(`must contain at most ${MAX_ADMIN_KEYS} keys`);
    const hashes: string[] = [];
    for (const [index, entry] of entries.entries()) {
      if (!/^[0-9a-f]{64}$/i.test(entry)) {
        return fail(`entry ${index + 1} must be a 64-character SHA-256 hex digest`);
      }
      const hash = entry.toLowerCase();
      if (hash === EMPTY_KEY_DIGEST) {
        return fail(`entry ${index + 1} is the digest of an empty key (is a variable unset?)`);
      }
      const first = hashes.indexOf(hash);
      if (first !== -1) return fail(`entry ${index + 1} duplicates entry ${first + 1}`);
      hashes.push(hash);
    }
    return hashes;
  });

const envSchema = z.object({
  ADMIN_API_KEYS: adminKeyHashes,
  PORT: integer('PORT', 0, 65535).default(3000),
  HOST: z.string().min(1, 'HOST must not be empty').default('0.0.0.0'),
  SEED_FILE: z.string().min(1, 'SEED_FILE must not be empty').default('config/clients.json'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], {
      error: 'LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent',
    })
    .default('info'),
  SWEEP_INTERVAL_MS: integer('SWEEP_INTERVAL_MS', 10, 3_600_000).default(30_000),
  MAX_CLIENTS: integer('MAX_CLIENTS', 1, 10_000_000).default(100_000),
  SHUTDOWN_GRACE_MS: integer('SHUTDOWN_GRACE_MS', 0, 60_000).default(5000),
});

/** Parses and validates process environment variables; throws a StartupError naming the variable. */
export function parseEnv(env: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => i.message).join('; ');
    throw new StartupError(`Invalid environment: ${problems}`);
  }
  const e = result.data;
  return {
    port: e.PORT,
    host: e.HOST,
    seedFile: e.SEED_FILE,
    logLevel: e.LOG_LEVEL,
    sweepIntervalMs: e.SWEEP_INTERVAL_MS,
    maxClients: e.MAX_CLIENTS,
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    adminKeyHashes: e.ADMIN_API_KEYS,
  };
}
