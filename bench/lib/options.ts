import { parseArgs } from 'node:util';

export type Mode = 'latency' | 'capacity' | 'hot';

export interface BenchOptions {
  readonly mode: Mode;
  /** Target server; when undefined the harness spawns `dist/main.js` itself. */
  readonly url: string | undefined;
  readonly durationSec: number;
  readonly warmupSec: number;
  readonly connections: number;
  /** Fixed overall request rate (req/s); undefined means unthrottled. */
  readonly rate: number | undefined;
  readonly clients: number;
  /** Every Nth request is a /configure call; 0 disables. */
  readonly configureEvery: number;
  readonly outDir: string;
  readonly p99LimitMs: number;
  readonly minRps: number;
  /** Admin API key for /configure and /metrics; never written to reports. */
  readonly apiKey: string | undefined;
}

/** A server the harness spawned itself, with the admin key it minted for it. */
export interface SpawnedTarget {
  readonly url: string;
  readonly key: string;
}

/** Where to send load and which admin key to use: the spawned server if any, else `--url` + env. */
export const resolveTarget = (
  options: BenchOptions,
  spawned: SpawnedTarget | undefined,
): { readonly url: string; readonly apiKey: string } => {
  if (spawned !== undefined) return { url: spawned.url, apiKey: spawned.key };
  if (options.url === undefined || options.apiKey === undefined) {
    throw new UsageError('no target: pass --url together with BENCH_API_KEY');
  }
  return { url: options.url, apiKey: options.apiKey };
};

/** The options as recorded in reports: everything except secrets. */
export const redactOptions = (options: BenchOptions): Omit<BenchOptions, 'apiKey'> =>
  Object.fromEntries(Object.entries(options).filter(([name]) => name !== 'apiKey')) as Omit<
    BenchOptions,
    'apiKey'
  >;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const MODES: readonly Mode[] = ['latency', 'capacity', 'hot'];

const MODE_DEFAULTS: Record<
  Mode,
  { connections: number; rate: number | undefined; clients: number; durationSec: number }
> = {
  latency: { connections: 50, rate: 1500, clients: 100, durationSec: 30 },
  capacity: { connections: 100, rate: undefined, clients: 1000, durationSec: 15 },
  hot: { connections: 50, rate: 1500, clients: 1, durationSec: 30 },
};

export const USAGE = `Usage: pnpm bench [options]

  --mode <latency|capacity|hot>   latency (default): fixed ~1500 req/s, pass/fail on p99 < 10 ms
                                  capacity: unthrottled; passes if throughput >= 1000 req/s
                                  hot: fixed rate against a single client_id
  --url <http://host:port>        target an already running server (default: spawn dist/main.js)
  --duration <sec>                measured run length
  --warmup <sec>                  unmeasured warm-up (default 3)
  --connections <n>               concurrent connections
  --rate <req/s>                  overall request rate (latency/hot modes)
  --clients <n>                   distinct client_ids in the mix
  --configure-every <n>           every nth request is a /configure call (0 = off, default 100)
  Environment: BENCH_API_KEY        admin API key for /configure and /metrics; required with --url,
                                  generated automatically when spawning (kept out of argv/ps)
  --out <dir>                     report directory (default bench/reports)`;

function positiveInt(name: string, raw: string | undefined, fallback: number, min = 1): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new UsageError(`--${name} must be an integer >= ${min}`);
  }
  return value;
}

export function parseOptions(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): BenchOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        mode: { type: 'string' },
        url: { type: 'string' },
        duration: { type: 'string' },
        warmup: { type: 'string' },
        connections: { type: 'string' },
        rate: { type: 'string' },
        clients: { type: 'string' },
        'configure-every': { type: 'string' },
        out: { type: 'string' },
      },
      strict: true,
    }));
  } catch (cause) {
    throw new UsageError((cause as Error).message);
  }

  const mode = (values.mode ?? 'latency') as Mode;
  if (!MODES.includes(mode)) throw new UsageError(`--mode must be one of ${MODES.join(', ')}`);
  const defaults = MODE_DEFAULTS[mode];
  const rate = values.rate === undefined ? defaults.rate : positiveInt('rate', values.rate, 1);

  const apiKey = env.BENCH_API_KEY;
  if (values.url !== undefined && (apiKey === undefined || apiKey === '')) {
    throw new UsageError(
      '--url requires an admin API key: set the BENCH_API_KEY environment variable',
    );
  }

  return {
    mode,
    url: values.url,
    durationSec: positiveInt('duration', values.duration, defaults.durationSec),
    warmupSec: positiveInt('warmup', values.warmup, 3, 0),
    connections: positiveInt('connections', values.connections, defaults.connections),
    rate,
    clients: positiveInt('clients', values.clients, defaults.clients),
    configureEvery: positiveInt('configure-every', values['configure-every'], 100, 0),
    outDir: values.out ?? 'bench/reports',
    p99LimitMs: 10,
    minRps: 1000,
    apiKey,
  };
}
