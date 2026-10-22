import { InMemoryMetrics } from '../../../src/adapters/out/in-memory-metrics';

describe('InMemoryMetrics', () => {
  it('starts empty', () => {
    const s = new InMemoryMetrics().snapshot();
    expect(s.requests).toEqual({});
    expect(s.decisions).toEqual({ allowed: 0, denied: 0 });
    expect(s.latency).toEqual({ count: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 });
    expect(Object.values(s.errors).every((n) => n === 0)).toBe(true);
    expect(s.configUpdates).toBe(0);
    expect(s.evictions).toBe(0);
  });

  it('counts requests per route and status', () => {
    const m = new InMemoryMetrics();
    m.recordRequest('POST /api/v1/ratelimit', 200, 0.1);
    m.recordRequest('POST /api/v1/ratelimit', 200, 0.1);
    m.recordRequest('POST /api/v1/ratelimit', 404, 0.1);
    m.recordRequest('POST /api/v1/configure', 200, 0.1);
    expect(m.snapshot().requests).toEqual({
      'POST /api/v1/ratelimit 200': 2,
      'POST /api/v1/ratelimit 404': 1,
      'POST /api/v1/configure 200': 1,
    });
  });

  it('counts decisions, errors, config updates and evictions', () => {
    const m = new InMemoryMetrics();
    m.recordDecision(true);
    m.recordDecision(false);
    m.recordDecision(false);
    m.recordError('fail_closed');
    m.recordError('fail_closed');
    m.recordConfigUpdate();
    m.recordEvictions(3);
    m.recordEvictions(2);
    const s = m.snapshot();
    expect(s.decisions).toEqual({ allowed: 1, denied: 2 });
    expect(s.errors.fail_closed).toBe(2);
    expect(s.configUpdates).toBe(1);
    expect(s.evictions).toBe(5);
  });

  it('derives percentiles from bucket bounds, capped at the observed max', () => {
    const m = new InMemoryMetrics();
    for (let i = 0; i < 98; i++) m.recordRequest('r', 200, 0.04); // <= 0.05 bucket
    m.recordRequest('r', 200, 0.4); // <= 0.5 bucket
    m.recordRequest('r', 200, 8); // <= 10 bucket
    const { latency } = m.snapshot();
    expect(latency.count).toBe(100);
    expect(latency.p50Ms).toBe(0.05);
    expect(latency.p95Ms).toBe(0.05);
    expect(latency.p99Ms).toBe(0.5);
    expect(latency.maxMs).toBe(8);
  });

  it('reports the observed max when samples overflow the last bucket', () => {
    const m = new InMemoryMetrics();
    m.recordRequest('r', 200, 5000);
    const s = m.snapshot();
    expect(s.latency.p99Ms).toBe(5000);
    expect(s.latencyBuckets.at(-1)).toEqual({ leMs: null, count: 1 });
    expect(s.latencyBuckets[0]).toEqual({ leMs: 0.05, count: 0 });
  });
});
