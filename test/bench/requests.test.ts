import {
  buildHeaders,
  buildPlan,
  clientIds,
  limitFor,
  pickRequest,
  seedBodies,
} from '../../bench/lib/requests';

describe('bench requests', () => {
  it('uses a low limit in latency mode so denials occur, a high one elsewhere', () => {
    expect(limitFor({ mode: 'latency' })).toBe(10);
    expect(limitFor({ mode: 'capacity' })).toBe(500);
    expect(limitFor({ mode: 'hot' })).toBe(500);
  });

  it('generates distinct client ids, or one id in hot mode', () => {
    expect(clientIds({ mode: 'latency', clients: 3 })).toEqual([
      'bench-0000',
      'bench-0001',
      'bench-0002',
    ]);
    expect(clientIds({ mode: 'hot', clients: 50 })).toEqual(['bench-hot']);
  });

  it('seeds every client within the service bounds', () => {
    expect(seedBodies({ mode: 'latency', clients: 2 })).toEqual([
      { client_id: 'bench-0000', window_seconds: 1, request_per_window: 10 },
      { client_id: 'bench-0001', window_seconds: 1, request_per_window: 10 },
    ]);
  });

  it('plans rate-limit bodies per client and two configure variants per client', () => {
    const plan = buildPlan({ mode: 'latency', clients: 2, configureEvery: 50 });
    expect(plan.rateLimitBodies.map((b) => JSON.parse(b) as unknown)).toEqual([
      { client_id: 'bench-0000', resource: 'bench' },
      { client_id: 'bench-0001', resource: 'bench' },
    ]);
    expect(
      plan.configureBodies.map(
        (b) => (JSON.parse(b) as { request_per_window: number }).request_per_window,
      ),
    ).toEqual([9, 10, 9, 10]);
    expect(plan.configureEvery).toBe(50);
  });

  describe('pickRequest', () => {
    const plan = buildPlan({ mode: 'latency', clients: 2, configureEvery: 10 });

    it('picks a rate-limit call by default', () => {
      const picked = pickRequest(plan, () => 0.5);
      expect(picked.path).toBe('/api/v1/ratelimit');
      expect(plan.rateLimitBodies).toContain(picked.body);
    });

    it('picks a configure call about once in configureEvery requests', () => {
      const picked = pickRequest(plan, () => 0.05);
      expect(picked.path).toBe('/api/v1/configure');
      expect(plan.configureBodies).toContain(picked.body);
    });

    it('never configures when disabled', () => {
      const off = buildPlan({ mode: 'latency', clients: 2, configureEvery: 0 });
      expect(pickRequest(off, () => 0).path).toBe('/api/v1/ratelimit');
    });

    it('spreads picks over every client', () => {
      let n = 0;
      const seen = new Set<string>();
      for (let i = 0; i < 20; i++)
        seen.add(pickRequest(plan, () => ((n++ * 37) % 100) / 100 + 0.1).body);
      expect(seen.size).toBeGreaterThan(1);
    });
  });

  it('sends the admin key only on configure requests', () => {
    const headers = buildHeaders('the-key');
    expect(headers.configure).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'the-key',
    });
    expect(headers.ratelimit).toEqual({ 'content-type': 'application/json' });
  });
});
