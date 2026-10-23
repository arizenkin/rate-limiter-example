import { InMemoryMetrics } from '../../../src/adapters/out/in-memory-metrics';

describe('InMemoryMetrics', () => {
  it('starts empty', () => {
    const s = new InMemoryMetrics().snapshot();
    expect(s.requests).toEqual({});
    expect(s.decisions).toEqual({ allowed: 0, denied: 0 });
    expect(s.latencyByRoute).toEqual({});
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
    const latency = m.snapshot().latencyByRoute.r?.latency;
    expect(latency?.count).toBe(100);
    expect(latency?.p50Ms).toBe(0.05);
    expect(latency?.p95Ms).toBe(0.05);
    expect(latency?.p99Ms).toBe(0.5);
    expect(latency?.maxMs).toBe(8);
  });

  it('reports the observed max when samples overflow the last bucket', () => {
    const m = new InMemoryMetrics();
    m.recordRequest('r', 200, 5000);
    const route = m.snapshot().latencyByRoute.r;
    expect(route?.latency.p99Ms).toBe(5000);
    expect(route?.buckets.at(-1)).toEqual({ leMs: null, count: 1 });
    expect(route?.buckets[0]).toEqual({ leMs: 0.05, count: 0 });
  });

  it('keeps latency per route, so slow admin calls do not affect /ratelimit', () => {
    const m = new InMemoryMetrics();
    for (let i = 0; i < 100; i++) m.recordRequest('POST /api/v1/ratelimit', 200, 0.04);
    for (let i = 0; i < 100; i++) m.recordRequest('POST /api/v1/configure', 200, 40);
    const { latencyByRoute } = m.snapshot();
    expect(latencyByRoute['POST /api/v1/ratelimit']?.latency).toEqual({
      count: 100,
      p50Ms: 0.04,
      p95Ms: 0.04,
      p99Ms: 0.04,
      maxMs: 0.04,
    });
    expect(latencyByRoute['POST /api/v1/configure']?.latency.p99Ms).toBe(40);
  });

  it('lists only routes that have been seen and shares one histogram across statuses', () => {
    const m = new InMemoryMetrics();
    expect(Object.keys(m.snapshot().latencyByRoute)).toEqual([]);
    m.recordRequest('POST /api/v1/configure', 401, 0.1);
    m.recordRequest('POST /api/v1/configure', 200, 0.1);
    const { latencyByRoute } = m.snapshot();
    expect(Object.keys(latencyByRoute)).toEqual(['POST /api/v1/configure']);
    expect(latencyByRoute['POST /api/v1/configure']?.latency.count).toBe(2);
  });
});
