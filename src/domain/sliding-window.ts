import type { Decision } from './config';

/**
 * Sliding window counter state for one client (HLD §3.1). Mutable on purpose: the in-memory store
 * updates it in place inside its synchronous critical section to avoid per-request allocation.
 * All times are monotonic milliseconds.
 */
export interface WindowState {
  readonly windowMs: number;
  windowStart: number;
  prev: number;
  curr: number;
  lastSeen: number;
  /**
   * Usage carried over from earlier window lengths (see `rebase`). It counts in full until
   * `legacyHoldUntil`, then decays linearly to zero at `legacyUntil`. All zero when unused.
   */
  legacyAmount: number;
  legacyHoldUntil: number;
  legacyUntil: number;
}

export function newWindowState(nowMs: number, windowMs: number): WindowState {
  return {
    windowMs,
    windowStart: nowMs,
    prev: 0,
    curr: 0,
    lastSeen: nowMs,
    legacyAmount: 0,
    legacyHoldUntil: 0,
    legacyUntil: 0,
  };
}

const EPSILON = 1e-9;

/** Carried-over usage still counting at `nowMs`. */
export function legacyRemaining(state: WindowState, nowMs: number): number {
  if (nowMs >= state.legacyUntil) return 0;
  if (nowMs <= state.legacyHoldUntil) return state.legacyAmount;
  const decaying = state.legacyUntil - state.legacyHoldUntil;
  return state.legacyAmount * ((state.legacyUntil - nowMs) / decaying);
}

/**
 * State for a client whose window length changed. Usage already consumed must not be forgiven
 * faster than the schedule it was earned under, or reconfiguring could refund quota (HLD §6.3):
 * it moves into a "legacy" amount that counts in full until the old window would have rolled and
 * then decays over the following old window, whatever window lengths come next. Merging several
 * changes keeps the later of each deadline, so the result never forgives sooner than any part.
 */
export function rebase(state: WindowState, nowMs: number, newWindowMs: number): WindowState {
  advance(state, nowMs);
  const roll = state.windowStart + state.windowMs;
  const current = estimate(state, nowMs);
  const older = legacyRemaining(state, nowMs);
  const next = newWindowState(nowMs, newWindowMs);
  if (current + older <= EPSILON) return next;

  const hasCurrent = current > EPSILON;
  const hasOlder = older > EPSILON;
  const currentHold = state.curr > 0 ? roll : nowMs;
  const currentUntil = state.curr > 0 ? roll + state.windowMs : roll;
  next.legacyAmount = current + older;
  next.legacyHoldUntil = Math.max(
    hasCurrent ? currentHold : 0,
    hasOlder ? Math.max(nowMs, state.legacyHoldUntil) : 0,
  );
  next.legacyUntil = Math.max(hasCurrent ? currentUntil : 0, hasOlder ? state.legacyUntil : 0);
  return next;
}

/** Rolls the current window forward; after two or more elapsed windows the history is empty. */
export function advance(state: WindowState, nowMs: number): void {
  const elapsed = nowMs - state.windowStart;
  if (elapsed < state.windowMs) return;
  const windows = Math.floor(elapsed / state.windowMs);
  state.prev = windows === 1 ? state.curr : 0;
  state.curr = 0;
  state.windowStart += windows * state.windowMs;
}

/** `prev × (1 − elapsed/W) + curr`; expects `advance` to have been called for `nowMs`. */
export function estimate(state: WindowState, nowMs: number): number {
  const elapsed = nowMs - state.windowStart;
  return state.prev * (1 - elapsed / state.windowMs) + state.curr;
}

/**
 * Milliseconds until a request would be admitted again, assuming no further traffic. Only
 * meaningful when a request is currently denied.
 */
export function waitMs(state: WindowState, nowMs: number, limit: number): number {
  if (state.legacyUntil > nowMs) return searchWaitMs(state, nowMs, limit);
  const elapsed = nowMs - state.windowStart;
  const slack = limit - state.curr - 1;
  if (slack >= 0 && state.prev > 0) {
    // prev × (1 − e/W) ≤ slack  →  e ≥ W × (1 − slack/prev)
    const target = state.windowMs * (1 - slack / state.prev);
    if (target < state.windowMs) return Math.max(target - elapsed, 0);
  }
  // Not satisfiable in this window: wait for the roll, where prev becomes the current count.
  const untilRoll = state.windowMs - elapsed;
  const prevAfterRoll = state.curr;
  const spare = limit - 1;
  if (prevAfterRoll === 0 || spare >= prevAfterRoll) return untilRoll;
  return untilRoll + state.windowMs * (1 - spare / prevAfterRoll);
}

/** Counted usage at a future time without any new traffic; does not modify the state. */
export function usageAt(state: WindowState, atMs: number): number {
  const elapsed = atMs - state.windowStart;
  let windowed: number;
  if (elapsed < state.windowMs) {
    windowed = state.prev * (1 - elapsed / state.windowMs) + state.curr;
  } else {
    const windows = Math.floor(elapsed / state.windowMs);
    const into = elapsed - windows * state.windowMs;
    windowed = windows === 1 ? state.curr * (1 - into / state.windowMs) : 0;
  }
  return windowed + legacyRemaining(state, atMs);
}

/**
 * Smallest whole number of milliseconds after which a request would be admitted, found by
 * bisection (usage never rises without traffic). Used while carried-over usage is active.
 */
function searchWaitMs(state: WindowState, nowMs: number, limit: number): number {
  let denied = 0;
  let allowed = Math.ceil(
    Math.max(state.windowStart + 2 * state.windowMs, state.legacyUntil) - nowMs,
  );
  while (allowed - denied > 1) {
    const middle = denied + Math.floor((allowed - denied) / 2);
    if (usageAt(state, nowMs + middle) + 1 <= limit + EPSILON) allowed = middle;
    else denied = middle;
  }
  return allowed;
}

/** Decides and, when allowed, consumes one request. Denied requests never change the state. */
export function consume(state: WindowState, nowMs: number, limit: number): Decision {
  advance(state, nowMs);
  state.lastSeen = nowMs;
  const projected = estimate(state, nowMs) + legacyRemaining(state, nowMs) + 1;
  if (projected <= limit + EPSILON) {
    state.curr += 1;
    return { allowed: true, remaining: limit - Math.ceil(projected - EPSILON) };
  }
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil(waitMs(state, nowMs, limit) / 1000)),
  };
}
