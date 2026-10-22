/** Monotonic time source in milliseconds (HLD §4). Injectable for deterministic tests. */
export interface Clock {
  nowMs(): number;
}
