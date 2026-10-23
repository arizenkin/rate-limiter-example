import type { PublishedReport } from '../../bench/lib/publish';

export const report = (over: Partial<PublishedReport> = {}): PublishedReport => ({
  startedAt: '2026-10-23T00:52:51.771Z',
  target: 'http://127.0.0.1:3000',
  options: {
    mode: 'latency',
    durationSec: 300,
    warmupSec: 3,
    connections: 50,
    rate: 1500,
    clients: 100,
    configureEvery: 2000,
    p99LimitMs: 10,
  },
  client: {
    totalRequests: 450005,
    requestsPerSec: { avg: 1500.02, min: 1427, max: 1585 },
    latencyMs: { p50: 0, p99: 2, p99_9: 3 },
    errors: 0,
    timeouts: 0,
    non2xx: 0,
  },
  server: {
    allowed: 155440,
    denied: 294378,
    routeRequests: 449818,
    p50Ms: 0.05,
    p95Ms: 0.05,
    p99Ms: 0.1,
  },
  memory: { peakRssMb: 105.01, peakHeapMb: 20.14 },
  memorySamples: [
    { tSec: 0, rssBytes: 91762688, heapUsedBytes: 17928384 },
    { tSec: 1, rssBytes: 92155904, heapUsedBytes: 17893952 },
  ],
  passed: true,
  ...over,
});
