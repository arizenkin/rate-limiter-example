import { summarizeMemory } from '../../bench/lib/memory';
import type { ServerDelta } from '../../bench/lib/metrics-diff';
import { parseOptions } from '../../bench/lib/options';
import {
  evaluate,
  renderMarkdown,
  type BenchReport,
  type ClientStats,
} from '../../bench/lib/report';

const MB = 1024 * 1024;

const client = (over: Partial<ClientStats> = {}): ClientStats => ({
  totalRequests: 3000,
  durationSec: 2,
  requestsPerSec: { avg: 1500, min: 1400, max: 1600 },
  latencyMs: { avg: 0.5, p50: 0.4, p97_5: 2, p99: 3, p99_9: 5, max: 9 },
  errors: 0,
  timeouts: 0,
  non2xx: 0,
  ...over,
});

const server = (over: Partial<ServerDelta> = {}): ServerDelta => ({
  requests: 3000,
  allowed: 2000,
  denied: 1000,
  errors: 0,
  evictions: 0,
  activeKeys: 100,
  routeRequests: 3000,
  p50Ms: 0.05,
  p95Ms: 0.1,
  p99Ms: 0.2,
  ...over,
});

const byName = (checks: ReturnType<typeof evaluate>, fragment: string) =>
  checks.find((c) => c.name.includes(fragment));

describe('summarizeMemory', () => {
  it('is undefined without samples', () => {
    expect(summarizeMemory([])).toBeUndefined();
  });

  it('summarises start, peak, end and growth in MB', () => {
    expect(
      summarizeMemory([
        { tSec: 0, rssBytes: 100 * MB, heapUsedBytes: 10 * MB },
        { tSec: 1, rssBytes: 130 * MB, heapUsedBytes: 20 * MB },
        { tSec: 2, rssBytes: 120 * MB, heapUsedBytes: 15 * MB },
      ]),
    ).toEqual({
      samples: 3,
      startRssMb: 100,
      peakRssMb: 130,
      endRssMb: 120,
      growthRssMb: 20,
      peakHeapMb: 20,
      endHeapMb: 15,
    });
  });
});

describe('evaluate', () => {
  const latency = parseOptions([]);

  it('passes a healthy latency run', () => {
    const checks = evaluate(latency, client(), server());
    expect(checks.every((c) => c.pass)).toBe(true);
    expect(checks).toHaveLength(5);
  });

  it('fails on errors, timeouts or non-2xx', () => {
    expect(byName(evaluate(latency, client({ errors: 1 }), server()), 'errors')?.pass).toBe(false);
    expect(byName(evaluate(latency, client({ timeouts: 1 }), server()), 'errors')?.pass).toBe(
      false,
    );
    expect(byName(evaluate(latency, client({ non2xx: 2 }), server()), 'non-2xx')?.pass).toBe(false);
  });

  it('fails when client or server p99 reach the limit', () => {
    const slowClient = evaluate(
      latency,
      client({ latencyMs: { ...client().latencyMs, p99: 10 } }),
      server(),
    );
    expect(byName(slowClient, 'client p99')?.pass).toBe(false);
    const slowServer = evaluate(latency, client(), server({ p99Ms: Infinity }));
    expect(byName(slowServer, 'server /ratelimit p99')?.pass).toBe(false);
    expect(byName(slowServer, 'server /ratelimit p99')?.detail).toContain('>1000');
  });

  it('fails when the server recorded no /ratelimit requests', () => {
    const check = byName(
      evaluate(latency, client(), server({ routeRequests: 0 })),
      'server /ratelimit p99',
    );
    expect(check).toMatchObject({
      pass: false,
      detail: 'no /ratelimit requests were recorded by the server',
    });
  });

  it('fails when server metrics are unavailable', () => {
    const check = byName(evaluate(latency, client(), undefined), 'server /ratelimit p99');
    expect(check).toMatchObject({ pass: false, detail: 'server metrics unavailable' });
  });

  it('fails when the generator cannot reach the target rate', () => {
    const checks = evaluate(
      latency,
      client({ requestsPerSec: { avg: 1000, min: 0, max: 0 } }),
      server(),
    );
    expect(byName(checks, 'target rate')?.pass).toBe(false);
  });

  it('checks throughput only in capacity mode', () => {
    const capacity = parseOptions(['--mode', 'capacity']);
    const ok = evaluate(
      capacity,
      client({ requestsPerSec: { avg: 5000, min: 0, max: 0 } }),
      server(),
    );
    expect(ok.map((c) => c.pass)).toEqual([true, true, true]);
    const slow = evaluate(
      capacity,
      client({ requestsPerSec: { avg: 999, min: 0, max: 0 } }),
      undefined,
    );
    expect(byName(slow, 'throughput')?.pass).toBe(false);
  });

  it('treats an unthrottled non-capacity run as having a zero target', () => {
    const odd = { ...latency, rate: undefined };
    expect(byName(evaluate(odd, client(), server()), 'target rate')?.pass).toBe(true);
  });
});

describe('renderMarkdown', () => {
  const options = parseOptions([]);
  const base = (over: Partial<BenchReport> = {}): BenchReport => ({
    startedAt: '2026-01-01T00:00:00.000Z',
    target: 'http://x',
    options,
    client: client(),
    server: server(),
    memory: summarizeMemory([{ tSec: 0, rssBytes: 50 * MB, heapUsedBytes: 5 * MB }]),
    memorySamples: [],
    checks: [{ name: 'c', pass: true, detail: 'd' }],
    passed: true,
    ...over,
  });

  it('renders every section for a passing run', () => {
    const md = renderMarkdown(base());
    expect(md).toContain('# Load test report: latency');
    expect(md).toContain('Result: **PASS**');
    expect(md).toContain('rate: 1500 req/s');
    expect(md).toContain('configure every: 100');
    expect(md).toContain('| c | pass | d |');
    expect(md).toContain('Latency p99 | 3.00 ms');
    expect(md).toContain('Decisions allowed / denied | 2000 / 1000');
    expect(md).toContain('RSS start / peak / end | 50 / 50 / 50 MB');
  });

  it('marks failures and renders unthrottled / disabled settings', () => {
    const md = renderMarkdown(
      base({
        passed: false,
        checks: [{ name: 'c', pass: false, detail: 'd' }],
        options: { ...options, rate: undefined, configureEvery: 0 },
      }),
    );
    expect(md).toContain('Result: **FAIL**');
    expect(md).toContain('| c | FAIL | d |');
    expect(md).toContain('rate: unthrottled');
    expect(md).toContain('configure every: off');
  });

  it('says so when server metrics or memory samples are missing', () => {
    const md = renderMarkdown(base({ server: undefined, memory: undefined }));
    expect(md).toContain('Server metrics were unavailable.');
    expect(md).toContain('No memory samples were collected.');
  });
});
