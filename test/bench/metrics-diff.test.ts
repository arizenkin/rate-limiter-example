import {
  diffMetrics,
  percentileFromBuckets,
  type ServerMetrics,
} from '../../bench/lib/metrics-diff';

const metrics = (over: Partial<ServerMetrics> = {}): ServerMetrics => ({
  requests: { a: 10, b: 5 },
  decisions: { allowed: 8, denied: 2 },
  errors: { validation: 1 },
  evictions: 0,
  activeKeys: 3,
  latencyBuckets: [
    { leMs: 0.1, count: 10 },
    { leMs: 1, count: 4 },
    { leMs: null, count: 1 },
  ],
  process: { rssBytes: 1, heapUsedBytes: 1 },
  ...over,
});

describe('percentileFromBuckets', () => {
  const buckets = [
    { leMs: 0.1, count: 90 },
    { leMs: 1, count: 9 },
    { leMs: null, count: 1 },
  ];

  it('returns the upper bound of the bucket holding the percentile', () => {
    expect(percentileFromBuckets(buckets, 0.5)).toBe(0.1);
    expect(percentileFromBuckets(buckets, 0.95)).toBe(1);
  });

  it('returns Infinity when the percentile lands in the overflow bucket', () => {
    expect(percentileFromBuckets(buckets, 1)).toBe(Infinity);
  });

  it('returns 0 for an empty histogram', () => {
    expect(percentileFromBuckets([{ leMs: 1, count: 0 }], 0.99)).toBe(0);
  });

  it('returns Infinity if the fraction exceeds the recorded counts', () => {
    expect(percentileFromBuckets([{ leMs: 1, count: 1 }], 1.5)).toBe(Infinity);
  });
});

describe('diffMetrics', () => {
  it('subtracts the before snapshot from the after snapshot', () => {
    const after = metrics({
      requests: { a: 110, b: 15, c: 3 },
      decisions: { allowed: 88, denied: 22 },
      errors: { validation: 4 },
      evictions: 2,
      activeKeys: 7,
      latencyBuckets: [
        { leMs: 0.1, count: 110 },
        { leMs: 1, count: 14 },
        { leMs: null, count: 1 },
      ],
    });
    expect(diffMetrics(metrics(), after)).toEqual({
      requests: 113,
      allowed: 80,
      denied: 20,
      errors: 3,
      evictions: 2,
      activeKeys: 7,
      p50Ms: 0.1,
      p95Ms: 1,
      p99Ms: 1,
    });
  });

  it('treats buckets missing from the before snapshot as zero', () => {
    const delta = diffMetrics(metrics({ latencyBuckets: [] }), metrics());
    expect(delta.p50Ms).toBe(0.1);
  });
});
