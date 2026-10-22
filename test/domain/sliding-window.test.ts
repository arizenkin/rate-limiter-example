import {
  advance,
  consume,
  estimate,
  legacyRemaining,
  usageAt,
  newWindowState,
  rebase,
  waitMs,
  type WindowState,
} from '../../src/domain/sliding-window';

const clone = (s: WindowState): WindowState => ({ ...s });

describe('newWindowState', () => {
  it('starts empty at the given time', () => {
    expect(newWindowState(50, 1000)).toEqual({
      windowMs: 1000,
      windowStart: 50,
      prev: 0,
      curr: 0,
      lastSeen: 50,
      legacyAmount: 0,
      legacyHoldUntil: 0,
      legacyUntil: 0,
    });
  });
});

describe('advance', () => {
  it('does nothing inside the current window', () => {
    const s = { ...newWindowState(0, 1000), curr: 3 };
    advance(s, 999);
    expect(s).toMatchObject({ windowStart: 0, prev: 0, curr: 3 });
  });

  it('rolls current into previous after exactly one window', () => {
    const s = { ...newWindowState(0, 1000), curr: 3 };
    advance(s, 1000);
    expect(s).toMatchObject({ windowStart: 1000, prev: 3, curr: 0 });
  });

  it('keeps window alignment when rolling mid-window', () => {
    const s = { ...newWindowState(0, 1000), curr: 3 };
    advance(s, 1700);
    expect(s).toMatchObject({ windowStart: 1000, prev: 3, curr: 0 });
  });

  it('drops history after two or more windows', () => {
    const s = { ...newWindowState(0, 1000), prev: 2, curr: 3 };
    advance(s, 2500);
    expect(s).toMatchObject({ windowStart: 2000, prev: 0, curr: 0 });
  });
});

describe('estimate', () => {
  it('weights the previous window by the time left in the current one', () => {
    const s = { ...newWindowState(0, 1000), prev: 10, curr: 2 };
    expect(estimate(s, 250)).toBeCloseTo(10 * 0.75 + 2);
  });
});

describe('consume', () => {
  it('allows up to the limit then denies without consuming', () => {
    const s = newWindowState(0, 1000);
    expect(consume(s, 0, 2)).toEqual({ allowed: true, remaining: 1 });
    expect(consume(s, 0, 2)).toEqual({ allowed: true, remaining: 0 });
    // curr=2 rolls into prev at 1000ms and then decays linearly: allowed again at 1500ms -> 2s
    expect(consume(s, 0, 2)).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 2 });
    expect(s.curr).toBe(2);
  });

  it('records lastSeen', () => {
    const s = newWindowState(0, 1000);
    consume(s, 400, 5);
    expect(s.lastSeen).toBe(400);
  });

  it('blocks the 2N boundary burst of a fixed window', () => {
    const s = newWindowState(0, 1000);
    for (let i = 0; i < 10; i++) consume(s, 999, 10);
    expect(consume(s, 1000, 10).allowed).toBe(false);
  });

  it('rounds remaining against the fractional estimate', () => {
    const s = { ...newWindowState(0, 1000), prev: 5, curr: 0 };
    // estimate at t=500 is 2.5, projected 3.5 -> ceil 4
    expect(consume(s, 500, 10)).toEqual({ allowed: true, remaining: 6 });
  });
});

describe('rebase and carried-over (legacy) usage', () => {
  const used = (windowMs: number, curr: number, prev = 0): WindowState => ({
    ...newWindowState(0, windowMs),
    curr,
    prev,
  });

  it('starts a clean window of the new length', () => {
    const next = rebase(used(1000, 3), 400, 5000);
    expect(next).toMatchObject({
      windowMs: 5000,
      windowStart: 400,
      prev: 0,
      curr: 0,
      lastSeen: 400,
    });
  });

  it('keeps current-window usage in full until the old window would have rolled, then decays it', () => {
    const next = rebase(used(1000, 3), 400, 5000);
    expect(legacyRemaining(next, 400)).toBe(3);
    expect(legacyRemaining(next, 1000)).toBe(3); // old roll
    expect(legacyRemaining(next, 1500)).toBeCloseTo(1.5);
    expect(legacyRemaining(next, 2000)).toBe(0);
    expect(legacyRemaining(next, 9000)).toBe(0);
  });

  it('decays previous-window usage over the rest of the old window', () => {
    const next = rebase(used(1000, 0, 5), 500, 2000); // estimate 2.5
    expect(legacyRemaining(next, 500)).toBeCloseTo(2.5);
    expect(legacyRemaining(next, 750)).toBeCloseTo(1.25);
    expect(legacyRemaining(next, 1000)).toBe(0);
  });

  it('carries nothing when there is no usage', () => {
    const next = rebase(newWindowState(0, 1000), 10, 2000);
    expect(next.legacyAmount).toBe(0);
    expect(legacyRemaining(next, 10)).toBe(0);
    expect(rebase(used(1000, 4), 2500, 1000).legacyAmount).toBe(0); // fully decayed history
  });

  it('counts legacy usage in decisions and in retry_after', () => {
    const state = rebase(used(10_000, 3), 0, 1000);
    const denied = consume(state, 100, 3);
    expect(denied.allowed).toBe(false);
    // legacy holds 3 until 10s, decays to 0 by 20s: need 3*(20-t)/10+1 <= 3 -> t >= 13.33s
    expect(denied.retryAfterSeconds).toBe(14);
    expect(consume(clone(state), 13_400, 3).allowed).toBe(true);
    expect(consume(clone(state), 13_300, 3).allowed).toBe(false);
  });

  it('merges repeated changes without ever forgiving sooner than any part', () => {
    const first = rebase(used(10_000, 3), 0, 1000); // 3 held until 10s, gone by 20s
    first.curr = 2; // two more admitted under the new 1s window
    const second = rebase(first, 500, 7000);
    expect(second.legacyAmount).toBeCloseTo(5);
    expect(legacyRemaining(second, 9_000)).toBeCloseTo(5); // still inside the older hold
    expect(second.legacyUntil).toBeGreaterThanOrEqual(20_000);
    expect(legacyRemaining(second, 10_000)).toBeGreaterThanOrEqual(legacyRemaining(first, 10_000));
  });

  it('cannot be refunded by big -> tiny -> wait -> big window changes', () => {
    const state = newWindowState(0, 3_600_000);
    for (let i = 0; i < 3; i++) consume(state, 0, 3);
    const tiny = rebase(state, 1000, 1000);
    const back = rebase(tiny, 6000, 3_600_000);
    expect(consume(back, 6000, 3).allowed).toBe(false);
    expect(consume(back, 3_599_000, 3).allowed).toBe(false);
  });

  it('merges a changed-twice client where one part is the older legacy only', () => {
    const first = rebase(used(10_000, 3), 0, 1000);
    const second = rebase(first, 12_000, 2000); // current window empty, only legacy remains
    expect(second.legacyAmount).toBeCloseTo(legacyRemaining(first, 12_000));
    expect(second.legacyUntil).toBe(first.legacyUntil);
  });

  it('never lowers counted usage at any future time (property test, fractional times)', () => {
    let seed = 99;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let run = 0; run < 2000; run++) {
      let state = newWindowState(0, (1 + Math.floor(rand() * 10)) * 1000);
      let now = 0;
      for (let i = 0; i < 30; i++) {
        now += rand() * state.windowMs * 1.5;
        if (rand() < 0.4) {
          const before = clone(state);
          advance(before, now);
          const rebased = rebase(state, now, (1 + Math.floor(rand() * 10)) * 1000);
          for (let k = 0; k < 10; k++) {
            const t = now + rand() * 40_000;
            expect(usageAt(rebased, t)).toBeGreaterThanOrEqual(usageAt(before, t) - 1e-9);
          }
          state = rebased;
        }
        consume(state, now, 1 + Math.floor(rand() * 6));
      }
    }
  });

  it('keeps the older schedule when merging with legacy usage that is already decaying', () => {
    const first = rebase(used(10_000, 3), 0, 1000); // hold until 10s, gone by 20s
    const second = rebase(first, 12_000, 2000);
    expect(second.legacyHoldUntil).toBe(12_000); // already past the old hold: decays from now
    expect(second.legacyUntil).toBe(20_000);
    expect(second.legacyAmount).toBeCloseTo(2.4);
  });

  it('is deliberately conservative when merging: new short-window usage inherits the longer deadlines', () => {
    const first = rebase(used(100_000, 5), 0, 1000); // 5 held until 100s
    const state = clone(first);
    state.curr = 5; // five more admitted in the new 1s window
    const merged = rebase(state, 500, 1000);
    expect(merged.legacyAmount).toBeCloseTo(10);
    expect(legacyRemaining(merged, 99_000)).toBeCloseTo(10); // not 5: documented in HLD 6.3
  });

  it('works with fractional now values', () => {
    const state = newWindowState(0.25, 1000);
    for (let i = 0; i < 2; i++) consume(state, 10.125, 2);
    expect(consume(state, 10.5, 2)).toMatchObject({ allowed: false });
  });

  it('retry_after stays exact (property test) with changes and legacy usage mixed in', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    let checked = 0;
    for (let run = 0; run < 300; run++) {
      const limit = 1 + Math.floor(rand() * 8);
      let state = newWindowState(0, (1 + Math.floor(rand() * 10)) * 1000);
      let now = 0;
      for (let i = 0; i < 60; i++) {
        now += Math.floor(rand() * rand() * state.windowMs * 0.5);
        if (rand() < 0.15) state = rebase(state, now, (1 + Math.floor(rand() * 10)) * 1000);
        const d = consume(state, now, limit);
        if (d.allowed) continue;
        const r = d.retryAfterSeconds as number;
        expect(consume(clone(state), now + r * 1000, limit).allowed).toBe(true);
        if (r > 1) expect(consume(clone(state), now + (r - 1) * 1000, limit).allowed).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});

describe('waitMs', () => {
  it('waits for the previous window to decay inside the current window', () => {
    // prev=10, curr=0, limit 5: need 10*(1-e/1000)+1 <= 5 -> e >= 600
    const s = { ...newWindowState(0, 1000), prev: 10 };
    expect(waitMs(s, 100, 5)).toBeCloseTo(500);
  });

  it('waits only for the roll when nothing is left to decay afterwards (curr = 0)', () => {
    const s = { ...newWindowState(0, 1000), prev: 1 };
    expect(waitMs(s, 200, 1)).toBeCloseTo(800);
  });

  it('waits only for the roll when the next window can absorb the current count', () => {
    // limit 3, curr 2: after the roll prev=2 and 2*(1-x)+1 <= 3 holds immediately
    const s = { ...newWindowState(0, 1000), prev: 5, curr: 2 };
    expect(waitMs(s, 300, 3)).toBeCloseTo(700);
  });

  it('adds decay time after the roll when the full window still weighs on the next one', () => {
    // limit 2, curr 2 -> after roll prev=2: need 2*(1-x)+1 <= 2 -> x >= 0.5
    const s = { ...newWindowState(0, 1000), curr: 2 };
    expect(waitMs(s, 0, 2)).toBeCloseTo(1500);
  });
});

describe('retry_after is exact (property test against stepping the clock)', () => {
  // Small deterministic PRNG so failures are reproducible.
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  it('allows at retry_after and still denies one second earlier, over random traffic', () => {
    const rand = rng(42);
    let checked = 0;
    for (let run = 0; run < 300; run++) {
      const windowMs = (1 + Math.floor(rand() * 20)) * 1000;
      const limit = 1 + Math.floor(rand() * 12);
      const s = newWindowState(0, windowMs);
      let now = 0;
      for (let i = 0; i < 80; i++) {
        now += Math.floor(rand() * rand() * windowMs * 0.4);
        const d = consume(s, now, limit);
        if (d.allowed) continue;
        const r = d.retryAfterSeconds as number;
        expect(Number.isInteger(r) && r >= 1).toBe(true);
        expect(consume(clone(s), now + r * 1000, limit).allowed).toBe(true);
        if (r > 1) expect(consume(clone(s), now + (r - 1) * 1000, limit).allowed).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('covers the edge cases N = 1 and prev = 0', () => {
    const s = newWindowState(0, 5000);
    expect(consume(s, 0, 1).allowed).toBe(true);
    const d = consume(s, 1000, 1);
    // The single request weighs fully at the roll (5000ms) and decays to 0 at 10000ms.
    expect(d).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 9 });
    expect(consume(clone(s), 5000, 1).allowed).toBe(false);
    expect(consume(clone(s), 10000, 1).allowed).toBe(true);
  });
});
