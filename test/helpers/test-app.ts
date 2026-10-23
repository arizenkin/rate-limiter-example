import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApiKeyPair } from '../../src/adapters/out/sha256-api-key-verifier';
import { startApp, type AppOverrides, type RunningApp } from '../../src/bootstrap/app';
import { RecordingLogger } from './recording-logger';

export interface TestApp extends RunningApp {
  readonly logger: RecordingLogger;
  readonly apiKey: string;
  readonly url: string;
}

export interface SeedClient {
  client_id: string;
  window_seconds: number;
  request_per_window: number;
}

export const writeSeedFile = (content: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rate-limiter-'));
  const path = join(dir, 'clients.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
};

/** Admin key per server URL, so `send` can authenticate protected paths automatically. */
const keysByUrl = new Map<string, string>();
export const registerApiKey = (url: string, apiKey: string) => {
  keysByUrl.set(url, apiKey);
};
const PROTECTED = ['/api/v1/configure', '/metrics'];

/** Starts the real composition on an ephemeral port with a temporary seed file. */
export async function startTestApp(
  clients: SeedClient[] = [],
  env: Record<string, string> = {},
  overrides: Omit<AppOverrides, 'logger'> = {},
): Promise<TestApp> {
  const logger = new RecordingLogger();
  const seedFile = writeSeedFile({ clients });
  const pair = createApiKeyPair(randomBytes(32));
  const app = await startApp(
    {
      PORT: '0',
      HOST: '127.0.0.1',
      SEED_FILE: seedFile,
      LOG_LEVEL: 'silent',
      ADMIN_API_KEYS: pair.hash,
      ...env,
    },
    { ...overrides, logger },
  );
  const url = `http://127.0.0.1:${app.port}`;
  registerApiKey(url, pair.key);
  return { ...app, logger, url, apiKey: pair.key };
}

export interface Response {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export async function send(
  url: string,
  path: string,
  options: {
    method?: string;
    body?: string;
    contentType?: string | null;
    /** A key to send; undefined uses the registered key for protected paths; null sends none. */
    apiKey?: string | null;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.contentType !== null)
    headers['content-type'] = options.contentType ?? 'application/json';
  const apiKey =
    options.apiKey === undefined
      ? PROTECTED.includes(path)
        ? keysByUrl.get(url)
        : undefined
      : (options.apiKey ?? undefined);
  if (apiKey !== undefined) headers['x-api-key'] = apiKey;
  const res = await fetch(url + path, {
    method: options.method ?? 'POST',
    headers,
    ...(options.body !== undefined && { body: options.body }),
  });
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json()) as Record<string, unknown>,
  };
}

export const postJson = (url: string, path: string, payload: unknown) =>
  send(url, path, { body: JSON.stringify(payload) });

/** A valid `ADMIN_API_KEYS` value for tests that call `startApp` directly. */
export const TEST_ADMIN_HASH = createApiKeyPair(Buffer.alloc(32, 9)).hash;
