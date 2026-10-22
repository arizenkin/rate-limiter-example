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

export interface MetricsSnapshot {
  readonly requests: Readonly<Record<string, number>>;
  readonly decisions: { readonly allowed: number; readonly denied: number };
  readonly errors: Readonly<Record<string, number>>;
  readonly configUpdates: number;
  readonly evictions: number;
  readonly latency: LatencySummary;
  readonly latencyBuckets: readonly { readonly leMs: number | null; readonly count: number }[];
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
