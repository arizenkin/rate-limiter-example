import { InMemoryCounterStore } from '../../../src/adapters/out/in-memory-counter-store';
import type { ClientConfig } from '../../../src/domain/config';
import { FakeClock } from '../../helpers/fake-clock';

const config = (over: Partial<ClientConfig> = {}): ClientConfig => ({
  clientId: 'a',
  windowSeconds: 10,
  requestPerWindow: 2,
  version: 1,
  ...over,
});

describe('InMemoryCounterStore', () => {
  let clock: FakeClock;
  let evicted: number[];
  let store: InMemoryCounterStore;

  beforeEach(() => {
    clock = new FakeClock(1000);
    evicted = [];
    store = new InMemoryCounterStore({ clock, onEvict: (n) => evicted.push(n) });
  });

  afterEach(() => {
    store.stopSweeping();
  });

  it('allows up to the limit and then denies', async () => {
    expect((await store.consume(config())).allowed).toBe(true);
    expect((await store.consume(config())).allowed).toBe(true);
    expect((await store.consume(config())).allowed).toBe(false);
  });

  it('keeps clients independent', async () => {
    await store.consume(config());
    await store.consume(config());
    expect((await store.consume(config({ clientId: 'b' }))).allowed).toBe(true);
    expect(store.activeKeys()).toBe(2);
  });

  it('keeps counters when only the limit changes', async () => {
    await store.consume(config());
    await store.consume(config());
    expect((await store.consume(config({ requestPerWindow: 5, version: 2 }))).allowed).toBe(true);
    expect((await store.consume(config({ requestPerWindow: 1, version: 3 }))).allowed).toBe(false);
  });

  it('carries usage over when the window length changes (no refund)', async () => {
    await store.consume(config());
    await store.consume(config());
    const decision = await store.consume(config({ windowSeconds: 20, version: 2 }));
    expect(decision.allowed).toBe(false);
  });

  it('ignores an older config snapshot instead of rebasing back to its window', async () => {
    await store.consume(config());
    await store.consume(config());
    await store.consume(config({ windowSeconds: 20, version: 2 }));
    // A request that read version 1 before the reconfigure is decided with its own limit...
    expect((await store.consume(config({ requestPerWindow: 5 }))).allowed).toBe(true);
    // ...but leaves the window and the carried usage of version 2 alone.
    // eslint-disable-next-line @typescript-eslint/dot-notation -- inspects private state
    const state = store['states'].get('a');
    expect(state?.windowMs).toBe(20_000);
    expect(state?.configVersion).toBe(2);
    expect(state?.legacyAmount).toBe(2);
  });

  it('lets carried usage decay under the new window', async () => {
    await store.consume(config());
    await store.consume(config());
    expect((await store.consume(config({ windowSeconds: 20, version: 2 }))).allowed).toBe(false);
    clock.advance(40_000); // two full new windows later the carried usage is gone
    expect((await store.consume(config({ windowSeconds: 20, version: 2 }))).allowed).toBe(true);
  });

  it('starts fresh when a client with no usage changes its window', async () => {
    await store.consume(config({ clientId: 'b', windowSeconds: 5 }));
    expect(store.activeKeys()).toBe(1);
    const decision = await store.consume(config({ clientId: 'never-seen', windowSeconds: 20 }));
    expect(decision).toEqual({ allowed: true, remaining: 1 });
  });

  it('cannot be refunded by switching to a tiny window, waiting, and switching back', async () => {
    const big = (version: number) => config({ windowSeconds: 3600, requestPerWindow: 3, version });
    for (let i = 0; i < 3; i++) await store.consume(big(1));
    clock.advance(1000);
    await store.consume(config({ windowSeconds: 1, requestPerWindow: 3, version: 2 })); // denied
    clock.advance(5000);
    expect((await store.consume(big(3))).allowed).toBe(false);
    clock.advance(3_500_000);
    expect((await store.consume(big(3))).allowed).toBe(false);
    clock.advance(8_000_000); // the carried usage has now fully expired
    expect((await store.consume(big(3))).allowed).toBe(true);
  });

  it('keeps counter state while carried-over usage is still active (not evicted)', async () => {
    await store.consume(config({ windowSeconds: 3600, requestPerWindow: 3 }));
    await store.consume(config({ windowSeconds: 1, requestPerWindow: 3, version: 2 })); // rebase
    clock.advance(10_000); // idle > 2 x 1s, but the carried usage lasts up to 2 x 3600s
    expect(store.sweep()).toBe(0);
    clock.advance(8_000_000);
    expect(store.sweep()).toBe(1);
  });

  it('cannot be reset by repeatedly toggling the window length', async () => {
    let allowed = 0;
    for (let i = 0; i < 40; i++) {
      const windowSeconds = i % 2 === 0 ? 10 : 11;
      const decision = await store.consume(config({ windowSeconds, version: i + 1 }));
      if (decision.allowed) allowed++;
      clock.advance(100);
    }
    expect(allowed).toBe(2); // the limit, despite 40 attempts across 40 configuration changes
  });

  it('applies window rollover using the injected clock', async () => {
    await store.consume(config());
    await store.consume(config());
    clock.advance(20_000);
    expect((await store.consume(config())).allowed).toBe(true);
  });

  describe('idle eviction', () => {
    it('evicts state idle for more than 2×W and reports the count', async () => {
      await store.consume(config());
      clock.advance(20_001);
      expect(store.sweep()).toBe(1);
      expect(store.activeKeys()).toBe(0);
      expect(evicted).toEqual([1]);
    });

    it('keeps state idle for at most 2×W', async () => {
      await store.consume(config());
      clock.advance(20_000);
      expect(store.sweep()).toBe(0);
      expect(store.activeKeys()).toBe(1);
      expect(evicted).toEqual([]);
    });

    it('works without an onEvict callback', async () => {
      const bare = new InMemoryCounterStore({ clock });
      await bare.consume(config());
      clock.advance(30_000);
      expect(bare.sweep()).toBe(1);
    });

    it('sweeps on a timer that can be stopped and restarted', async () => {
      await store.consume(config());
      clock.advance(30_000);
      store.startSweeping(5);
      store.startSweeping(5); // second call keeps the existing timer
      const deadline = Date.now() + 2000;
      while (store.activeKeys() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(store.activeKeys()).toBe(0);
      store.stopSweeping();
      store.stopSweeping();
    });
  });

  describe('sliced sweep', () => {
    const fill = async (target: InMemoryCounterStore, count: number) => {
      for (let i = 0; i < count; i++) await target.consume(config({ clientId: `c${i}` }));
    };

    it('spreads one pass over several slices and evicts everything idle', async () => {
      const small = new InMemoryCounterStore({
        clock,
        sweepSliceSize: 2,
        onEvict: (n) => evicted.push(n),
      });
      await fill(small, 5);
      clock.advance(20_001);
      expect(small.sweepSlice()).toBe(2);
      expect(small.sweepSlice()).toBe(2);
      expect(small.sweepSlice()).toBe(1);
      expect(small.activeKeys()).toBe(0);
      expect(evicted).toEqual([2, 2, 1]);
    });

    it('treats a slice size below 1 as 1 so a pass always advances', async () => {
      const zero = new InMemoryCounterStore({ clock, sweepSliceSize: 0 });
      await fill(zero, 2);
      clock.advance(20_001);
      expect(zero.sweep()).toBe(2);
    });

    it('copes with inserts and deletes between slices', async () => {
      const small = new InMemoryCounterStore({ clock, sweepSliceSize: 2 });
      await fill(small, 4);
      clock.advance(20_001);
      small.sweepSlice(); // c0, c1 evicted
      await small.consume(config({ clientId: 'late' })); // fresh, must survive
      while (small.activeKeys() > 1) small.sweepSlice();
      small.sweepSlice();
      expect(small.activeKeys()).toBe(1);
    });

    it('sweep() restarts from the beginning and completes a full pass', async () => {
      const small = new InMemoryCounterStore({ clock, sweepSliceSize: 2 });
      await fill(small, 5);
      clock.advance(20_001);
      small.sweepSlice();
      expect(small.sweep()).toBe(3);
      expect(small.activeKeys()).toBe(0);
    });

    it('timer ticks continue a pass on later event-loop turns and can be stopped', async () => {
      const small = new InMemoryCounterStore({ clock, sweepSliceSize: 1 });
      await fill(small, 4);
      clock.advance(20_001);
      small.startSweeping(5);
      const deadline = Date.now() + 2000;
      while (small.activeKeys() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(small.activeKeys()).toBe(0);
      small.stopSweeping();
    });

    it('stopSweeping cancels a pending continuation', async () => {
      const small = new InMemoryCounterStore({ clock, sweepSliceSize: 1 });
      await fill(small, 4);
      clock.advance(20_001);
      small.startSweeping(5);
      await new Promise((resolve) => setTimeout(resolve, 8)); // one tick: 1 slice, more pending
      small.stopSweeping();
      const remaining = small.activeKeys();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(small.activeKeys()).toBe(remaining);
    });
  });

  it('decides synchronously: state is updated before consume() returns its promise', () => {
    void store.consume(config());
    void store.consume(config());
    void store.consume(config());
    // All three already ran to completion without yielding to the event loop.
    expect(store.activeKeys()).toBe(1);
    return expect(store.consume(config())).resolves.toMatchObject({ allowed: false });
  });
});
