export type ErrorClass =
  | 'validation'
  | 'not_found'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'unauthorized'
  | 'client_limit_reached'
  | 'fail_closed'
  | 'internal';

export interface LatencySummary {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

/** Latency of one route (label), kept apart so `/ratelimit` is not mixed with admin traffic. */
export interface RouteLatency {
  readonly latency: LatencySummary;
  readonly buckets: readonly { readonly leMs: number | null; readonly count: number }[];
}

export interface MetricsSnapshot {
  readonly requests: Readonly<Record<string, number>>;
  readonly decisions: { readonly allowed: number; readonly denied: number };
  readonly errors: Readonly<Record<string, number>>;
  readonly configUpdates: number;
  readonly evictions: number;
  /** Keyed like `requests`; only routes that have been seen appear. */
  readonly latencyByRoute: Readonly<Record<string, RouteLatency>>;
}

/** Recording must be O(1) and allocation-free: it runs on the request hot path. */
export interface Metrics {
  recordRequest(route: string, status: number, durationMs: number): void;
  recordDecision(allowed: boolean): void;
  recordError(errorClass: ErrorClass): void;
  recordConfigUpdate(): void;
  recordEvictions(count: number): void;
  snapshot(): MetricsSnapshot;
}
