import { InMemoryCounterStore } from '../src/adapters/out/in-memory-counter-store';
import { postJson, startTestApp } from './helpers/test-app';
import { FakeClock } from './helpers/fake-clock';

describe('concurrency (HLD §5.2)', () => {
  it('never admits more than N concurrent consume() calls for one client', async () => {
    const store = new InMemoryCounterStore({ clock: new FakeClock() });
    const config = { clientId: 'a', windowSeconds: 60, requestPerWindow: 50, version: 1 };
    const decisions = await Promise.all(Array.from({ length: 1000 }, () => store.consume(config)));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(50);
  });

  it('admits exactly N of a concurrent HTTP burst against one client', async () => {
    const app = await startTestApp([
      { client_id: 'hot', window_seconds: 300, request_per_window: 40 },
    ]);
    try {
      const results = await Promise.all(
        Array.from({ length: 300 }, () =>
          postJson(app.url, '/api/v1/ratelimit', { client_id: 'hot', resource: 'r' }),
        ),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => r.body.allowed === true)).toHaveLength(40);
    } finally {
      await app.stop();
    }
  });

  it('keeps clients independent under a mixed burst', async () => {
    const clients = Array.from({ length: 10 }, (_, i) => ({
      client_id: `c${i}`,
      window_seconds: 300,
      request_per_window: 5,
    }));
    const app = await startTestApp(clients);
    try {
      const results = await Promise.all(
        clients.flatMap((c) =>
          Array.from({ length: 20 }, () =>
            postJson(app.url, '/api/v1/ratelimit', { client_id: c.client_id, resource: 'r' }),
          ),
        ),
      );
      expect(results.filter((r) => r.body.allowed === true)).toHaveLength(50);
    } finally {
      await app.stop();
    }
  });

  it('keeps usage on both limit-only and window changes (no refund)', async () => {
    const app = await startTestApp([
      { client_id: 'live', window_seconds: 300, request_per_window: 100 },
    ]);
    const burst = async (n: number) => {
      const results = await Promise.all(
        Array.from({ length: n }, () =>
          postJson(app.url, '/api/v1/ratelimit', { client_id: 'live', resource: 'r' }),
        ),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      return results.filter((r) => r.body.allowed === true).length;
    };
    const configure = (window_seconds: number, request_per_window: number) =>
      postJson(app.url, '/api/v1/configure', {
        client_id: 'live',
        window_seconds,
        request_per_window,
      });
    try {
      expect(await burst(150)).toBe(100);
      await configure(300, 200); // limit-only: usage kept, so exactly 100 more fit
      expect(await burst(300)).toBe(100);
      await configure(200, 150); // window change: usage (200) is carried over, so nothing is refunded
      expect(await burst(50)).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it('serves every request while configure calls interleave with a burst', async () => {
    const app = await startTestApp([
      { client_id: 'live', window_seconds: 300, request_per_window: 100 },
    ]);
    try {
      const calls: Promise<{ status: number }>[] = [];
      for (let i = 0; i < 400; i++) {
        calls.push(postJson(app.url, '/api/v1/ratelimit', { client_id: 'live', resource: 'r' }));
        if (i % 40 === 0) {
          calls.push(
            postJson(app.url, '/api/v1/configure', {
              client_id: 'live',
              window_seconds: 300,
              request_per_window: i % 80 === 0 ? 100 : 200,
            }),
          );
        }
      }
      expect((await Promise.all(calls)).every((r) => r.status === 200)).toBe(true);
    } finally {
      await app.stop();
    }
  });
});
