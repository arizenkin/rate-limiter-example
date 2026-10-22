import { request } from 'node:http';
import { connect } from 'node:net';
import type { MetricsReport } from '../../../src/application/get-metrics';
import { postJson, send, startTestApp, type TestApp } from '../../helpers/test-app';

const RL = '/api/v1/ratelimit';
const CF = '/api/v1/configure';

describe('HTTP API', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp([
      { client_id: 'big', window_seconds: 300, request_per_window: 500 },
      { client_id: 'tiny', window_seconds: 300, request_per_window: 2 },
    ]);
  });

  afterAll(async () => {
    await app.stop();
  });

  describe('POST /api/v1/ratelimit', () => {
    it('returns exactly allowed + remaining when allowed', async () => {
      const first = await postJson(app.url, RL, { client_id: 'big', resource: 'r' });
      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(first.body).toEqual({ allowed: true, remaining: 499 });
      const second = await postJson(app.url, RL, { client_id: 'big', resource: 'r' });
      expect(second.body).toEqual({ allowed: true, remaining: 498 });
    });

    it('adds retry_after (whole seconds) only when denied, and still returns 200', async () => {
      await postJson(app.url, RL, { client_id: 'tiny', resource: 'r' });
      await postJson(app.url, RL, { client_id: 'tiny', resource: 'r' });
      const denied = await postJson(app.url, RL, { client_id: 'tiny', resource: 'r' });
      expect(denied.status).toBe(200);
      expect(Object.keys(denied.body).sort()).toEqual(['allowed', 'remaining', 'retry_after']);
      expect(denied.body.allowed).toBe(false);
      expect(denied.body.remaining).toBe(0);
      expect(Number.isInteger(denied.body.retry_after)).toBe(true);
      expect(denied.body.retry_after as number).toBeGreaterThanOrEqual(1);
    });

    it('ignores unknown properties and the query string', async () => {
      const res = await postJson(app.url, `${RL}?debug=1`, {
        client_id: 'big',
        resource: 'r',
        extra: true,
      });
      expect(res.status).toBe(200);
    });

    it('accepts a Content-Type with parameters, any case', async () => {
      const res = await send(app.url, RL, {
        body: JSON.stringify({ client_id: 'big', resource: 'r' }),
        contentType: 'Application/JSON; charset=utf-8',
      });
      expect(res.status).toBe(200);
    });

    it('accepts ids of exactly 36 characters (unknown -> 404)', async () => {
      const id = 'x'.repeat(36);
      const res = await postJson(app.url, RL, { client_id: id, resource: id });
      expect(res.status).toBe(404);
    });

    it('returns 404 with a message for unknown clients and creates no state', async () => {
      const before = (await send(app.url, '/metrics', { method: 'GET', contentType: null })).body;
      const res = await postJson(app.url, RL, { client_id: 'ghost', resource: 'r' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "client_id 'ghost' is not configured" });
      const after = (await send(app.url, '/metrics', { method: 'GET', contentType: null })).body;
      expect(after.activeKeys).toBe(before.activeKeys);
    });

    it.each([
      [{ resource: 'r' }, 'client_id is required', 'client_id', undefined],
      [{ client_id: 'big' }, 'resource is required', 'resource', undefined],
      [{ client_id: 5, resource: 'r' }, 'client_id must be a string', 'client_id', undefined],
      [{ client_id: 'big', resource: null }, 'resource must be a string', 'resource', undefined],
      [
        { client_id: '', resource: 'r' },
        'client_id must be between 1 and 36 characters',
        'client_id',
        { min: 1, max: 36 },
      ],
      [
        { client_id: 'big', resource: 'y'.repeat(37) },
        'resource must be between 1 and 36 characters',
        'resource',
        { min: 1, max: 36 },
      ],
    ])('400 for invalid body %j', async (payload, message, field, bounds) => {
      const res = await postJson(app.url, RL, payload);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: message, field, ...bounds });
    });

    it.each([['[]'], ['null'], ['"text"'], ['42']])('400 when the JSON body is %s', async (raw) => {
      const res = await send(app.url, RL, { body: raw });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'request body must be a JSON object' });
    });

    it.each([[''], ['{ nope'], ['{"client_id":']])('400 for malformed JSON %j', async (raw) => {
      const res = await send(app.url, RL, { body: raw });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'request body must be valid JSON' });
    });

    it('415 when there is no Content-Type header at all', async () => {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port: app.port, path: RL, method: 'POST' },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end('{}');
      });
      expect(status).toBe(415);
    });

    it('415 when Content-Type is not JSON', async () => {
      for (const contentType of ['text/plain', 'application/jsonx', null]) {
        const res = await send(app.url, RL, { body: '{}', contentType });
        expect(res.status).toBe(415);
        expect(res.body).toEqual({ error: 'Content-Type must be application/json' });
      }
    });

    it('413 when the declared body is too large', async () => {
      const res = await send(app.url, RL, {
        body: JSON.stringify({ client_id: 'big', resource: 'x'.repeat(2000) }),
      });
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: 'request body must not exceed 1024 bytes' });
    });

    it('413 when a chunked body (no Content-Length) grows past the cap', async () => {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: app.port,
            path: RL,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.write('{"client_id":"');
        req.write('a'.repeat(700));
        req.write('a'.repeat(700));
        req.end('"}');
      });
      expect(status).toBe(413);
    });

    it('survives a client that disconnects mid-body', async () => {
      await new Promise<void>((resolve) => {
        const socket = connect(app.port, '127.0.0.1', () => {
          socket.write(
            `POST ${RL} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"client`,
          );
          socket.destroy();
          resolve();
        });
      });
      const res = await postJson(app.url, RL, { client_id: 'big', resource: 'r' });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/v1/configure', () => {
    it('creates a new client (upsert) and echoes the stored configuration', async () => {
      const res = await postJson(app.url, CF, {
        client_id: 'fresh',
        window_seconds: 30,
        request_per_window: 3,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ client_id: 'fresh', window_seconds: 30, request_per_window: 3 });
      const decision = await postJson(app.url, RL, { client_id: 'fresh', resource: 'r' });
      expect(decision.body).toEqual({ allowed: true, remaining: 2 });
    });

    it('updates an existing client; a lower limit takes effect immediately', async () => {
      await postJson(app.url, CF, { client_id: 'upd', window_seconds: 300, request_per_window: 5 });
      await postJson(app.url, RL, { client_id: 'upd', resource: 'r' });
      await postJson(app.url, RL, { client_id: 'upd', resource: 'r' });
      await postJson(app.url, CF, { client_id: 'upd', window_seconds: 300, request_per_window: 2 });
      const res = await postJson(app.url, RL, { client_id: 'upd', resource: 'r' });
      expect(res.body.allowed).toBe(false);
    });

    it('logs the old -> new change', async () => {
      await postJson(app.url, CF, {
        client_id: 'logged',
        window_seconds: 5,
        request_per_window: 5,
      });
      await postJson(app.url, CF, {
        client_id: 'logged',
        window_seconds: 6,
        request_per_window: 7,
      });
      const entries = app.logger.entries.filter((e) => e.fields.clientId === 'logged');
      expect(entries).toHaveLength(2);
      expect(entries[1]?.fields).toMatchObject({
        old: { windowSeconds: 5, requestPerWindow: 5, version: 1 },
        new: { windowSeconds: 6, requestPerWindow: 7, version: 2 },
      });
    });

    it.each([
      [
        { window_seconds: 10, request_per_window: 5 },
        'client_id is required',
        'client_id',
        undefined,
      ],
      [
        { client_id: 'c', request_per_window: 5 },
        'window_seconds is required',
        'window_seconds',
        undefined,
      ],
      [
        { client_id: 'c', window_seconds: 10 },
        'request_per_window is required',
        'request_per_window',
        undefined,
      ],
      [
        { client_id: 'c', window_seconds: '10', request_per_window: 5 },
        'window_seconds must be an integer',
        'window_seconds',
        undefined,
      ],
      [
        { client_id: 'c', window_seconds: 1.5, request_per_window: 5 },
        'window_seconds must be an integer',
        'window_seconds',
        undefined,
      ],
      [
        { client_id: 'c', window_seconds: 0, request_per_window: 5 },
        'window_seconds must be between 1 and 300',
        'window_seconds',
        { min: 1, max: 300 },
      ],
      [
        { client_id: 'c', window_seconds: 301, request_per_window: 5 },
        'window_seconds must be between 1 and 300',
        'window_seconds',
        { min: 1, max: 300 },
      ],
      [
        { client_id: 'c', window_seconds: 10, request_per_window: 0 },
        'request_per_window must be between 1 and 500',
        'request_per_window',
        { min: 1, max: 500 },
      ],
      [
        { client_id: 'c', window_seconds: 10, request_per_window: 501 },
        'request_per_window must be between 1 and 500',
        'request_per_window',
        { min: 1, max: 500 },
      ],
      [
        { client_id: 'x'.repeat(37), window_seconds: 10, request_per_window: 5 },
        'client_id must be between 1 and 36 characters',
        'client_id',
        { min: 1, max: 36 },
      ],
    ])('400 for invalid body %j', async (payload, message, field, bounds) => {
      const res = await postJson(app.url, CF, payload);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: message, field, ...bounds });
    });

    it('accepts both bounds inclusively', async () => {
      for (const [w, n] of [
        [1, 1],
        [300, 500],
      ] as const) {
        const res = await postJson(app.url, CF, {
          client_id: `edge-${w}`,
          window_seconds: w,
          request_per_window: n,
        });
        expect(res.status).toBe(200);
      }
    });

    it('409 for a new client beyond MAX_CLIENTS, while updates and decisions keep working', async () => {
      const capped = await startTestApp(
        [{ client_id: 'only', window_seconds: 60, request_per_window: 5 }],
        { MAX_CLIENTS: '1' },
      );
      try {
        const rejected = await postJson(capped.url, CF, {
          client_id: 'second',
          window_seconds: 1,
          request_per_window: 1,
        });
        expect(rejected.status).toBe(409);
        expect(rejected.body.error).toBe(
          'client limit of 1 reached; existing clients can still be updated',
        );
        expect(
          (await postJson(capped.url, RL, { client_id: 'second', resource: 'r' })).status,
        ).toBe(404);
        const update = await postJson(capped.url, CF, {
          client_id: 'only',
          window_seconds: 60,
          request_per_window: 9,
        });
        expect(update.status).toBe(200);
        expect((await postJson(capped.url, RL, { client_id: 'only', resource: 'r' })).status).toBe(
          200,
        );
        const metrics = (await send(capped.url, '/metrics', { method: 'GET', contentType: null }))
          .body as unknown as MetricsReport;
        expect(metrics.errors.client_limit_reached).toBe(1);
      } finally {
        await capped.stop();
      }
    });

    it('stores nothing when validation fails', async () => {
      await postJson(app.url, CF, {
        client_id: 'nothing',
        window_seconds: 0,
        request_per_window: 1,
      });
      expect((await postJson(app.url, RL, { client_id: 'nothing', resource: 'r' })).status).toBe(
        404,
      );
    });
  });

  describe('routing', () => {
    it('404 for unknown routes', async () => {
      const res = await send(app.url, '/nope', { method: 'GET', contentType: null });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'route not found' });
    });

    it.each([
      ['GET', RL, 'POST'],
      ['PUT', CF, 'POST'],
      ['POST', '/metrics', 'GET'],
    ])('405 for %s %s with an Allow header', async (method, path, allow) => {
      const res = await send(app.url, path, { method, contentType: null });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe(allow);
      expect(res.body.error).toBe(`method not allowed; use ${allow}`);
    });
  });

  describe('GET /metrics', () => {
    it('reports requests, decisions, errors, latency, active keys and process memory', async () => {
      await postJson(app.url, RL, { client_id: 'big', resource: 'r' });
      await postJson(app.url, RL, { client_id: 'ghost', resource: 'r' });
      const res = await send(app.url, '/metrics', { method: 'GET', contentType: null });
      expect(res.status).toBe(200);
      const m = res.body as unknown as MetricsReport;
      expect(m.requests['POST /api/v1/ratelimit 200']).toBeGreaterThan(0);
      expect(m.requests['POST /api/v1/ratelimit 404']).toBeGreaterThan(0);
      expect(m.requests['UNMATCHED 404']).toBeGreaterThan(0);
      expect(m.decisions.allowed).toBeGreaterThan(0);
      expect(m.decisions.denied).toBeGreaterThan(0);
      expect(m.errors.validation).toBeGreaterThan(0);
      expect(m.errors.not_found).toBeGreaterThan(0);
      expect(m.configUpdates).toBeGreaterThan(0);
      expect(m.latency.count).toBeGreaterThan(0);
      expect(m.latency.p99Ms).toBeGreaterThan(0);
      expect(m.latencyBuckets.at(-1)?.leMs).toBeNull();
      expect(m.activeKeys).toBeGreaterThan(0);
      expect(m.process.rssBytes).toBeGreaterThan(0);
      expect(m.process.heapUsedBytes).toBeGreaterThan(0);
      expect(m.process.uptimeSeconds).toBeGreaterThan(0);
    });
  });
});
