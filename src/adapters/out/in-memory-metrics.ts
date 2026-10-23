import type {
  ErrorClass,
  LatencySummary,
  Metrics,
  MetricsSnapshot,
  RouteLatency,
} from '../../application/ports/metrics';

/** Upper bounds in milliseconds; the final implicit bucket is +Inf. */
export const LATENCY_BUCKETS_MS: readonly number[] = [
  0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 25, 50, 100, 250, 500, 1000,
];

/** Fixed-size, allocation-free recording; percentiles are bucket upper bounds capped at the observed max. */
class LatencyHistogram {
  private readonly buckets = [...LATENCY_BUCKETS_MS, Infinity].map((leMs) => ({
    leMs,
    count: 0,
  }));
  private count = 0;
  private max = 0;

  record(durationMs: number): void {
    for (const bucket of this.buckets) {
      if (durationMs <= bucket.leMs) {
        bucket.count++;
        break;
      }
    }
    this.count++;
    if (durationMs > this.max) this.max = durationMs;
  }

  snapshot(): RouteLatency {
    return {
      latency: this.summary(),
      buckets: this.buckets.map(({ leMs, count }) => ({
        leMs: Number.isFinite(leMs) ? leMs : null,
        count,
      })),
    };
  }

  private summary(): LatencySummary {
    return {
      count: this.count,
      p50Ms: this.percentile(0.5),
      p95Ms: this.percentile(0.95),
      p99Ms: this.percentile(0.99),
      maxMs: this.max,
    };
  }

  private percentile(fraction: number): number {
    const rank = Math.ceil(this.count * fraction);
    let seen = 0;
    let result = this.max;
    for (const { leMs, count } of this.buckets) {
      seen += count;
      if (seen >= rank) {
        result = Math.min(leMs, this.max);
        break;
      }
    }
    return result;
  }
}

/** Status counts and latency of one route label; created the first time the label is seen. */
interface RouteStats {
  readonly byStatus: Map<number, number>;
  readonly latency: LatencyHistogram;
}

export class InMemoryMetrics implements Metrics {
  private readonly routes = new Map<string, RouteStats>();
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
  private allowed = 0;
  private denied = 0;
  private configUpdates = 0;
  private evictions = 0;

  recordRequest(route: string, status: number, durationMs: number): void {
    let stats = this.routes.get(route);
    if (stats === undefined) {
      stats = { byStatus: new Map(), latency: new LatencyHistogram() };
      this.routes.set(route, stats);
    }
    stats.byStatus.set(status, (stats.byStatus.get(status) ?? 0) + 1);
    stats.latency.record(durationMs);
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
    const latencyByRoute: Record<string, RouteLatency> = {};
    for (const [route, { byStatus, latency }] of this.routes) {
      for (const [status, count] of byStatus) requests[`${route} ${status}`] = count;
      latencyByRoute[route] = latency.snapshot();
    }
    return {
      requests,
      decisions: { allowed: this.allowed, denied: this.denied },
      errors: { ...this.errors },
      configUpdates: this.configUpdates,
      evictions: this.evictions,
      latencyByRoute,
    };
  }
}
