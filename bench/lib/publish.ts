import { z } from 'zod';
import type { Mode } from './options';

export const MODES: readonly Mode[] = ['latency', 'capacity', 'hot'];

/** File names under docs/benchmarks/data, without extension. */
export const FRIENDLY_NAMES: Record<Mode, string> = {
  latency: 'latency',
  capacity: 'capacity',
  hot: 'hot-key',
};

export const TITLES: Record<Mode, string> = {
  latency: 'Latency',
  capacity: 'Capacity',
  hot: 'Hot key',
};

const REPORT_NAME =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(latency|capacity|hot)\.(json|md)$/;

export interface ReportName {
  readonly startedAt: string;
  readonly mode: Mode;
  readonly ext: 'json' | 'md';
}

export function parseReportName(file: string): ReportName | undefined {
  const match = REPORT_NAME.exec(file);
  if (match === null) return undefined;
  return { startedAt: match[1] as string, mode: match[2] as Mode, ext: match[3] as 'json' | 'md' };
}

export interface ReportFiles {
  readonly json: string;
  readonly md: string;
}

/** The newest run of each mode for which both the JSON and the Markdown report exist. */
export function pickLatest(files: readonly string[]): Partial<Record<Mode, ReportFiles>> {
  const runs = new Map<string, { mode: Mode; startedAt: string; json?: string; md?: string }>();
  for (const file of files) {
    const parsed = parseReportName(file);
    if (parsed === undefined) continue;
    const key = `${parsed.mode}/${parsed.startedAt}`;
    const run = runs.get(key) ?? { mode: parsed.mode, startedAt: parsed.startedAt };
    run[parsed.ext] = file;
    runs.set(key, run);
  }
  const latest: Partial<Record<Mode, ReportFiles>> = {};
  const newest: Partial<Record<Mode, string>> = {};
  for (const run of runs.values()) {
    const known = newest[run.mode];
    if (run.json === undefined || run.md === undefined) continue;
    if (known !== undefined && known >= run.startedAt) continue;
    newest[run.mode] = run.startedAt;
    latest[run.mode] = { json: run.json, md: run.md };
  }
  return latest;
}

// zod 4 numbers are already finite: a histogram bound of Infinity (serialised as null) is rejected.
const finite = z.number();

/** The part of a bench report JSON that the published page uses. */
export const reportSchema = z.object({
  startedAt: z.string(),
  target: z.string(),
  options: z.object({
    mode: z.enum(['latency', 'capacity', 'hot']),
    url: z.string().optional(),
    durationSec: finite,
    warmupSec: finite,
    connections: finite,
    rate: finite.optional(),
    clients: finite,
    configureEvery: finite,
    p99LimitMs: finite,
  }),
  client: z.object({
    totalRequests: finite,
    requestsPerSec: z.object({ avg: finite, min: finite, max: finite }),
    latencyMs: z.object({ p50: finite, p99: finite, p99_9: finite }),
    errors: finite,
    timeouts: finite,
    non2xx: finite,
  }),
  server: z
    .object({
      allowed: finite,
      denied: finite,
      routeRequests: finite,
      p50Ms: finite,
      p95Ms: finite,
      p99Ms: finite,
    })
    .optional(),
  memory: z.object({ peakRssMb: finite, peakHeapMb: finite }).optional(),
  memorySamples: z.array(z.object({ tSec: finite, rssBytes: finite, heapUsedBytes: finite })),
  passed: z.boolean(),
});

export type PublishedReport = z.infer<typeof reportSchema>;

export interface PublishedRun {
  readonly mode: Mode;
  readonly report: PublishedReport;
}

/** Parses one bench report; throws an Error naming the file when it is unreadable. */
export function parseReport(file: string, text: string): PublishedReport {
  try {
    return reportSchema.parse(JSON.parse(text));
  } catch (cause) {
    const reason = String(cause);
    // Infinity (a latency above the last histogram bucket) is stored as null in the JSON.
    const hint = reason.includes('null')
      ? ' (null latency: the run overflowed the 1000 ms bucket)'
      : '';
    throw new Error(`cannot read report ${file}: ${reason}${hint}`, { cause });
  }
}

export interface MachineInfo {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly release: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly totalMemBytes: number;
}

export function describeEnvironment(info: MachineInfo): [string, string][] {
  const wsl = info.release.toLowerCase().includes('microsoft') ? ' (WSL2)' : '';
  return [
    ['Node.js', info.nodeVersion],
    ['OS', `${info.platform} ${info.arch}, kernel ${info.release}${wsl}`],
    ['CPU', `${info.cpuModel.trim()}, ${info.cpuCount} logical cores`],
    ['Memory', `${(info.totalMemBytes / 2 ** 30).toFixed(1)} GiB`],
  ];
}

export const num = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

const cell = (text: string) => text.replaceAll('|', '\\|');

const table = (header: string[], rows: string[][]): string =>
  [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/;

export interface ReadmeInput {
  readonly runs: readonly PublishedRun[];
  readonly environment: readonly (readonly [string, string])[];
}

/** The generated docs/benchmarks/README.md. Deterministic: no clock, no commit hash. */
export function renderReadme({ runs, environment }: ReadmeInput): string {
  const notRun = MODES.filter((mode) => !runs.some((run) => run.mode === mode));
  const loopback = runs.every((run) => LOOPBACK.test(run.report.target));

  const parameters = table(
    [
      'Test',
      'Started (UTC)',
      'Duration',
      'Warm-up',
      'Connections',
      'Rate',
      'Clients',
      'Configure every',
    ],
    runs.map(({ mode, report: { startedAt, options } }) => [
      TITLES[mode],
      startedAt.replace('T', ' ').replace(/\.\d+Z$/, ''),
      `${num(options.durationSec)} s`,
      `${num(options.warmupSec)} s`,
      num(options.connections),
      options.rate === undefined ? 'unthrottled' : `${num(options.rate)} req/s`,
      num(options.clients),
      options.configureEvery === 0 ? 'off' : `${num(options.configureEvery)} requests`,
    ]),
  );

  const results = table(
    [
      'Test',
      'Requests/s (avg)',
      'Client p99',
      'Server /ratelimit p99',
      'Allowed / denied',
      'Errors',
      'Peak RSS',
      'Result',
    ],
    runs.map(({ mode, report: { client, server, memory, passed } }) => [
      TITLES[mode],
      num(client.requestsPerSec.avg),
      `${num(client.latencyMs.p99)} ms`,
      server === undefined ? 'n/a' : `≤ ${num(server.p99Ms)} ms`,
      server === undefined ? 'n/a' : `${num(server.allowed)} / ${num(server.denied)}`,
      num(client.errors + client.timeouts + client.non2xx),
      memory === undefined ? 'n/a' : `${num(memory.peakRssMb)} MB`,
      passed ? 'PASS' : 'FAIL',
    ]),
  );

  const files = table(
    ['Test', 'Report', 'Data'],
    runs.map(({ mode }) => {
      const name = FRIENDLY_NAMES[mode];
      return [TITLES[mode], `[${name}.md](data/${name}.md)`, `[${name}.json](data/${name}.json)`];
    }),
  );

  const lines = [
    '# Benchmarks',
    '',
    '<!-- Generated by `pnpm bench:publish`. Do not edit by hand. -->',
    '',
    'Results of the most recent run of each load test (see [load-testing.md](../load-testing.md) for what the tests do and how to run them).',
    '',
    ...(notRun.length === 0
      ? []
      : [`Not run yet: ${notRun.map((mode) => TITLES[mode]).join(', ')}.`, '']),
    '## Test environment',
    '',
    table(
      ['Item', 'Value'],
      environment.map(([item, value]) => [item, value]),
    ),
    '',
    'The reports do not record the machine. These details were read when this page was generated, on the machine that ran `pnpm bench:publish`, and assume the benchmarks ran there too.' +
      (loopback
        ? ' Every run targeted the loopback interface, so the service and the load generator (autocannon) shared this machine and competed for its CPU.'
        : ''),
    '',
    '## Runs',
    '',
    parameters,
    '',
    '## Results',
    '',
    results,
    '',
    'The runs differ in duration and in how often `/configure` was called, so compare tests with care.',
    '',
    '## Charts',
    '',
    '### Latency',
    '',
    '![Latency percentiles per test: client side and server side](charts/latency.svg)',
    '',
    '### Throughput',
    '',
    '![Requests per second per test, with minimum, average and maximum](charts/throughput.svg)',
    '',
    '### Memory',
    '',
    '![Server RSS and heap used over each run](charts/memory.svg)',
    '',
    '## Reading the numbers',
    '',
    '- Client latency comes from autocannon and has 1 ms resolution, so a value of 0 means "under 1 ms".',
    '- Server latency is handler time for `/ratelimit` only, taken from `/metrics`. It excludes network and queueing, and each percentile is the upper bound of a histogram bucket.',
    '- The latency and hot-key tests send a fixed rate of requests; the capacity test is unthrottled and reports how much the service can take.',
    '- Memory comes from `/metrics`, sampled once per second during the measured run.',
    ...(runs.some((run) => run.report.options.url !== undefined)
      ? [
          '- At least one run used `--url`, so the service was started separately. If one process served several runs, a later run starts with the memory and counters its predecessors left behind: compare the first RSS sample in each memory panel with the end of the run before it.',
        ]
      : []),
    '',
    '## Raw data',
    '',
    files,
    '',
    '## Regenerating',
    '',
    'Run the benchmarks (`pnpm bench`, `pnpm bench:capacity`, `pnpm bench:hot`), then `pnpm bench:publish`. It copies the newest report of each test from `bench/reports/` into `data/`, redraws the charts and rewrites this page.',
    '',
  ];
  return lines.join('\n');
}
