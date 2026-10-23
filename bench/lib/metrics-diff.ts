export interface ServerBucket {
  readonly leMs: number | null;
  readonly count: number;
}

/** The subset of GET /metrics the harness relies on. */
export interface ServerMetrics {
  readonly requests: Readonly<Record<string, number>>;
  readonly decisions: { readonly allowed: number; readonly denied: number };
  readonly errors: Readonly<Record<string, number>>;
  readonly evictions: number;
  /** Latency histograms per route label, as in `GET /metrics`. */
  readonly latencyByRoute: Readonly<Record<string, { readonly buckets: readonly ServerBucket[] }>>;
  readonly activeKeys: number;
  readonly process: { readonly rssBytes: number; readonly heapUsedBytes: number };
}

export interface ServerDelta {
  readonly requests: number;
  readonly allowed: number;
  readonly denied: number;
  readonly errors: number;
  readonly evictions: number;
  readonly activeKeys: number;
  /** Requests the measured route handled between the two snapshots (0 means nothing to judge). */
  readonly routeRequests: number;
  /** Percentile upper bounds (ms) over the measured route's requests between the two snapshots. */
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

const sum = (values: Iterable<number>) => {
  let total = 0;
  for (const v of values) total += v;
  return total;
};

/** Upper bound of the bucket holding the requested percentile; Infinity for the overflow bucket. */
export function percentileFromBuckets(buckets: readonly ServerBucket[], fraction: number): number {
  const total = sum(buckets.map((b) => b.count));
  if (total === 0) return 0;
  const rank = Math.ceil(total * fraction);
  let seen = 0;
  for (const { leMs, count } of buckets) {
    seen += count;
    if (seen >= rank) return leMs ?? Infinity;
  }
  return Infinity;
}

/**
 * Server-side view of just the measured run: `after` minus `before`. Latency percentiles cover only
 * `route` (the latency-sensitive endpoint), so admin traffic cannot skew them; a route that was
 * not seen yet counts as empty.
 */
export function diffMetrics(
  before: ServerMetrics,
  after: ServerMetrics,
  route: string,
): ServerDelta {
  const beforeBuckets = before.latencyByRoute[route]?.buckets;
  const buckets = (after.latencyByRoute[route]?.buckets ?? []).map((bucket, i) => ({
    leMs: bucket.leMs,
    count: bucket.count - (beforeBuckets?.[i]?.count ?? 0),
  }));
  return {
    requests: sum(Object.values(after.requests)) - sum(Object.values(before.requests)),
    allowed: after.decisions.allowed - before.decisions.allowed,
    denied: after.decisions.denied - before.decisions.denied,
    errors: sum(Object.values(after.errors)) - sum(Object.values(before.errors)),
    evictions: after.evictions - before.evictions,
    activeKeys: after.activeKeys,
    routeRequests: sum(buckets.map((b) => b.count)),
    p50Ms: percentileFromBuckets(buckets, 0.5),
    p95Ms: percentileFromBuckets(buckets, 0.95),
    p99Ms: percentileFromBuckets(buckets, 0.99),
  };
}
