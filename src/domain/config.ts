/** Input bounds, shared by `/configure`, `/ratelimit` and the startup seed file (HLD §2). */
export const BOUNDS = {
  windowSeconds: { min: 1, max: 300 },
  requestPerWindow: { min: 1, max: 500 },
  idMaxLength: 36,
} as const;

/** Immutable per-client policy. `version` increases by one on every change. */
export interface ClientConfig {
  readonly clientId: string;
  readonly windowSeconds: number;
  readonly requestPerWindow: number;
  readonly version: number;
}

export interface Decision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Whole seconds until a retry could succeed; only set when `allowed` is false. */
  readonly retryAfterSeconds?: number;
}
