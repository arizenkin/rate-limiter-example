import type { MemorySample, MemorySummary } from './memory';
import type { ServerDelta } from './metrics-diff';
import type { BenchOptions } from './options';

/** Client-side numbers as measured by the load generator. */
export interface ClientStats {
  readonly totalRequests: number;
  readonly durationSec: number;
  readonly requestsPerSec: { readonly avg: number; readonly min: number; readonly max: number };
  readonly latencyMs: {
    readonly avg: number;
    readonly p50: number;
    readonly p97_5: number;
    readonly p99: number;
    readonly p99_9: number;
    readonly max: number;
  };
  readonly errors: number;
  readonly timeouts: number;
  readonly non2xx: number;
}

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface BenchReport {
  readonly startedAt: string;
  readonly target: string;
  readonly options: Omit<BenchOptions, 'apiKey'>;
  readonly client: ClientStats;
  /** Undefined when the server's /metrics could not be read. */
  readonly server: ServerDelta | undefined;
  readonly memory: MemorySummary | undefined;
  readonly memorySamples: readonly MemorySample[];
  readonly checks: readonly Check[];
  readonly passed: boolean;
}

const fmt = (n: number, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : '>1000');

export function evaluate(
  options: Omit<BenchOptions, 'apiKey'>,
  client: ClientStats,
  server: ServerDelta | undefined,
): Check[] {
  const checks: Check[] = [
    {
      name: 'no errors or timeouts',
      pass: client.errors === 0 && client.timeouts === 0,
      detail: `errors=${client.errors} timeouts=${client.timeouts}`,
    },
    {
      name: 'no non-2xx responses',
      pass: client.non2xx === 0,
      detail: `non2xx=${client.non2xx}`,
    },
  ];
  if (options.mode === 'capacity') {
    checks.push({
      name: `throughput >= ${options.minRps} req/s`,
      pass: client.requestsPerSec.avg >= options.minRps,
      detail: `${fmt(client.requestsPerSec.avg, 0)} req/s`,
    });
    return checks;
  }
  checks.push({
    name: `client p99 latency < ${options.p99LimitMs} ms`,
    pass: client.latencyMs.p99 < options.p99LimitMs,
    detail: `${fmt(client.latencyMs.p99)} ms`,
  });
  checks.push(
    server === undefined
      ? { name: 'server /ratelimit p99 latency', pass: false, detail: 'server metrics unavailable' }
      : server.routeRequests === 0
        ? {
            name: 'server /ratelimit p99 latency',
            pass: false,
            detail: 'no /ratelimit requests were recorded by the server',
          }
        : {
            name: `server /ratelimit p99 latency <= ${options.p99LimitMs} ms`,
            pass: server.p99Ms <= options.p99LimitMs,
            detail: `<= ${fmt(server.p99Ms)} ms (histogram bucket bound)`,
          },
  );
  const target = options.rate ?? 0;
  checks.push({
    name: 'achieved at least 90% of the target rate',
    pass: client.requestsPerSec.avg >= target * 0.9,
    detail: `${fmt(client.requestsPerSec.avg, 0)} of ${target} req/s`,
  });
  return checks;
}

export function renderMarkdown(report: BenchReport): string {
  const { options, client, server, memory } = report;
  const lines = [
    `# Load test report: ${options.mode}`,
    '',
    `- Started: ${report.startedAt}`,
    `- Target: ${report.target}`,
    `- Duration: ${options.durationSec}s (warm-up ${options.warmupSec}s), connections: ${options.connections}, ` +
      `rate: ${options.rate === undefined ? 'unthrottled' : `${options.rate} req/s`}, ` +
      `clients: ${options.clients}, configure every: ${options.configureEvery || 'off'}`,
    `- Result: **${report.passed ? 'PASS' : 'FAIL'}**`,
    '',
    '## Checks',
    '',
    '| Check | Result | Detail |',
    '|---|---|---|',
    ...report.checks.map((c) => `| ${c.name} | ${c.pass ? 'pass' : 'FAIL'} | ${c.detail} |`),
    '',
    '## Client-side (load generator)',
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Requests | ${client.totalRequests} |`,
    `| Requests/s (avg / min / max) | ${fmt(client.requestsPerSec.avg, 0)} / ${fmt(client.requestsPerSec.min, 0)} / ${fmt(client.requestsPerSec.max, 0)} |`,
    `| Latency avg | ${fmt(client.latencyMs.avg)} ms |`,
    `| Latency p50 | ${fmt(client.latencyMs.p50)} ms |`,
    `| Latency p97.5 | ${fmt(client.latencyMs.p97_5)} ms |`,
    `| Latency p99 | ${fmt(client.latencyMs.p99)} ms |`,
    `| Latency p99.9 | ${fmt(client.latencyMs.p99_9)} ms |`,
    `| Latency max | ${fmt(client.latencyMs.max)} ms |`,
    `| Errors / timeouts / non-2xx | ${client.errors} / ${client.timeouts} / ${client.non2xx} |`,
    '',
    '## Server-side (from /metrics, measured run only)',
    '',
  ];
  if (server === undefined) {
    lines.push('Server metrics were unavailable.');
  } else {
    lines.push(
      '| Metric | Value |',
      '|---|---|',
      `| Requests handled | ${server.requests} |`,
      `| Decisions allowed / denied | ${server.allowed} / ${server.denied} |`,
      `| Error responses | ${server.errors} |`,
      `| /ratelimit handler latency p50 / p95 / p99 (bucket upper bounds) | ${fmt(server.p50Ms)} / ${fmt(server.p95Ms)} / ${fmt(server.p99Ms)} ms |`,
      `| Active keys at end | ${server.activeKeys} |`,
      `| Counter evictions | ${server.evictions} |`,
    );
  }
  lines.push('', '## Server memory (sampled from /metrics once per second)', '');
  if (memory === undefined) {
    lines.push('No memory samples were collected.');
  } else {
    lines.push(
      '| Metric | Value |',
      '|---|---|',
      `| Samples | ${memory.samples} |`,
      `| RSS start / peak / end | ${memory.startRssMb} / ${memory.peakRssMb} / ${memory.endRssMb} MB |`,
      `| RSS growth over run | ${memory.growthRssMb} MB |`,
      `| Heap used peak / end | ${memory.peakHeapMb} / ${memory.endHeapMb} MB |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
