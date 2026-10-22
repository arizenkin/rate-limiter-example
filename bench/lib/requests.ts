import type { BenchOptions } from './options';

export interface BenchRequest {
  readonly path: string;
  readonly body: string;
}

export interface ClientConfigBody {
  readonly client_id: string;
  readonly window_seconds: number;
  readonly request_per_window: number;
}

const WINDOW_SECONDS = 1;

/** Latency mode uses a low limit so that roughly a third of decisions are denials. */
export const limitFor = (options: Pick<BenchOptions, 'mode'>): number =>
  options.mode === 'latency' ? 10 : 500;

export function clientIds(options: Pick<BenchOptions, 'mode' | 'clients'>): string[] {
  if (options.mode === 'hot') return ['bench-hot'];
  return Array.from({ length: options.clients }, (_, i) => `bench-${String(i).padStart(4, '0')}`);
}

/** Bodies for POST /configure that create every benchmark client before the run. */
export function seedBodies(options: Pick<BenchOptions, 'mode' | 'clients'>): ClientConfigBody[] {
  const limit = limitFor(options);
  return clientIds(options).map((client_id) => ({
    client_id,
    window_seconds: WINDOW_SECONDS,
    request_per_window: limit,
  }));
}

export interface RequestPlan {
  readonly rateLimitBodies: readonly string[];
  /** Two variants per client (limit and limit - 1) so a configure call really changes the limit. */
  readonly configureBodies: readonly string[];
  readonly configureEvery: number;
}

export const RATELIMIT_PATH = '/api/v1/ratelimit';
export const CONFIGURE_PATH = '/api/v1/configure';

export function buildPlan(
  options: Pick<BenchOptions, 'mode' | 'clients' | 'configureEvery'>,
): RequestPlan {
  const ids = clientIds(options);
  const limit = limitFor(options);
  return {
    rateLimitBodies: ids.map((client_id) => JSON.stringify({ client_id, resource: 'bench' })),
    configureBodies: ids.flatMap((client_id) =>
      [limit - 1, limit].map((request_per_window) =>
        JSON.stringify({ client_id, window_seconds: WINDOW_SECONDS, request_per_window }),
      ),
    ),
    configureEvery: options.configureEvery,
  };
}

const pickOne = (items: readonly string[], random: () => number): string =>
  items[Math.floor(random() * items.length)] as string;

/**
 * Chooses the next request at random, so load is spread over clients evenly in time rather than
 * in synchronised sweeps; about one request in `configureEvery` is a /configure call.
 */
export function pickRequest(
  plan: RequestPlan,
  random: () => number,
): Pick<BenchRequest, 'path' | 'body'> {
  if (plan.configureEvery > 0 && random() < 1 / plan.configureEvery) {
    return { path: CONFIGURE_PATH, body: pickOne(plan.configureBodies, random) };
  }
  return { path: RATELIMIT_PATH, body: pickOne(plan.rateLimitBodies, random) };
}

export interface RequestHeaders {
  readonly ratelimit: Record<string, string>;
  readonly configure: Record<string, string>;
}

/** Only /configure carries the admin key; /ratelimit is open and never sees it. */
export function buildHeaders(apiKey: string): RequestHeaders {
  const base = { 'content-type': 'application/json' };
  return { ratelimit: base, configure: { ...base, 'x-api-key': apiKey } };
}
