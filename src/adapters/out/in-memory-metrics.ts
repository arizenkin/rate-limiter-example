import type { ErrorClass, Metrics, MetricsSnapshot } from '../../application/ports/metrics';

/** Upper bounds in milliseconds; the final implicit bucket is +Inf. */
export const LATENCY_BUCKETS_MS: readonly number[] = [
  0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 25, 50, 100, 250, 500, 1000,
];

/** Fixed-size, allocation-free recording; percentiles are bucket upper bounds capped at the observed max. */
export class InMemoryMetrics implements Metrics {
  private readonly requests = new Map<string, Map<number, number>>();
  private readonly errors: Record<ErrorClass, number> = {
    validation: 0,
    not_found: 0,
    method_not_allowed: 0,
    payload_too_large: 0,
    unsupported_media_type: 0,
    unauthorized: 0,
    client_limit_reached: 0,
    fail_closed: 0,
    internal: 0,
  };
  private readonly buckets = [...LATENCY_BUCKETS_MS, Infinity].map((leMs) => ({
    leMs,
    count: 0,
  }));
  private allowed = 0;
  private denied = 0;
  private configUpdates = 0;
  private evictions = 0;
  private latencyCount = 0;
  private latencyMax = 0;

  recordRequest(route: string, status: number, durationMs: number): void {
    let byStatus = this.requests.get(route);
    if (byStatus === undefined) {
      byStatus = new Map();
      this.requests.set(route, byStatus);
    }
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);

    for (const bucket of this.buckets) {
      if (durationMs <= bucket.leMs) {
        bucket.count++;
        break;
      }
    }
    this.latencyCount++;
    if (durationMs > this.latencyMax) this.latencyMax = durationMs;
  }

  recordDecision(allowed: boolean): void {
    if (allowed) this.allowed++;
    else this.denied++;
  }

  recordError(errorClass: ErrorClass): void {
    this.errors[errorClass]++;
  }

  recordConfigUpdate(): void {
    this.configUpdates++;
  }

  recordEvictions(count: number): void {
    this.evictions += count;
  }

  snapshot(): MetricsSnapshot {
    const requests: Record<string, number> = {};
    for (const [route, byStatus] of this.requests) {
      for (const [status, count] of byStatus) requests[`${route} ${status}`] = count;
    }
    return {
      requests,
      decisions: { allowed: this.allowed, denied: this.denied },
      errors: { ...this.errors },
      configUpdates: this.configUpdates,
      evictions: this.evictions,
      latency: {
        count: this.latencyCount,
        p50Ms: this.percentile(0.5),
        p95Ms: this.percentile(0.95),
        p99Ms: this.percentile(0.99),
        maxMs: this.latencyMax,
      },
      latencyBuckets: this.buckets.map(({ leMs, count }) => ({
        leMs: Number.isFinite(leMs) ? leMs : null,
        count,
      })),
    };
  }

  private percentile(fraction: number): number {
    if (this.latencyCount === 0) return 0;
    const rank = Math.ceil(this.latencyCount * fraction);
    let seen = 0;
    let result = this.latencyMax;
    for (const { leMs, count } of this.buckets) {
      seen += count;
      if (seen >= rank) {
        result = Math.min(leMs, this.latencyMax);
        break;
      }
    }
    return result;
  }
}
