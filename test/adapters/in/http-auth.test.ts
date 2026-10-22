import { request } from 'node:http';
import type { MetricsReport } from '../../../src/application/get-metrics';
import { postJson, send, startTestApp, type TestApp } from '../../helpers/test-app';

const CF = '/api/v1/configure';
const RL = '/api/v1/ratelimit';
const validBody = JSON.stringify({ client_id: 'c', window_seconds: 5, request_per_window: 5 });

describe('admin API key authentication', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp([{ client_id: 'open', window_seconds: 60, request_per_window: 5 }]);
  });

  afterAll(async () => {
    await app.stop();
  });

  it.each([
    ['no key', null],
    ['an empty key', ''],
    ['a wrong key', 'not-the-key'],
    ['the key with extra characters', 'x'],
  ])('401 on /configure with %s, identical body in every case', async (_name, apiKey) => {
    const key = apiKey === 'x' ? `${app.apiKey}x` : apiKey;
    const res = await send(app.url, CF, { body: validBody, apiKey: key });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'missing or invalid API key' });
    expect(res.headers.get('www-authenticate')).toBe('ApiKey');
    expect(res.headers.get('connection')).toBe('close'); // the unread body is not drained
  });

  it('401 on /metrics without or with a wrong key', async () => {
    for (const apiKey of [null, 'wrong']) {
      const res = await send(app.url, '/metrics', { method: 'GET', contentType: null, apiKey });
      expect(res.status).toBe(401);
    }
  });

  it('401 when the key header is repeated (even if one value is right)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: app.port,
          path: CF,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': [app.apiKey, app.apiKey] },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(validBody);
    });
    expect(status).toBe(401);
  });

  it('checks the key before the content type, body size and body syntax', async () => {
    const wrongType = await send(app.url, CF, {
      body: validBody,
      contentType: 'text/plain',
      apiKey: null,
    });
    expect(wrongType.status).toBe(401);
    const tooLarge = await send(app.url, CF, { body: 'x'.repeat(5000), apiKey: null });
    expect(tooLarge.status).toBe(401);
    const malformed = await send(app.url, CF, { body: '{ nope', apiKey: null });
    expect(malformed.status).toBe(401);
  });

  it('still reports 404 and 405 without a key (routing comes first)', async () => {
    expect((await send(app.url, '/nope', { method: 'GET', contentType: null })).status).toBe(404);
    expect(
      (await send(app.url, CF, { method: 'GET', contentType: null, apiKey: null })).status,
    ).toBe(405);
  });

  it('keeps /ratelimit open', async () => {
    const res = await postJson(app.url, RL, { client_id: 'open', resource: 'r' });
    expect(res.status).toBe(200);
  });

  it('accepts the right key on /configure and /metrics', async () => {
    expect((await send(app.url, CF, { body: validBody })).status).toBe(200);
    expect((await send(app.url, '/metrics', { method: 'GET', contentType: null })).status).toBe(
      200,
    );
  });

  it('counts failures under errors.unauthorized and creates nothing', async () => {
    await send(app.url, CF, {
      body: JSON.stringify({ client_id: 'sneaky', window_seconds: 1, request_per_window: 500 }),
      apiKey: 'wrong',
    });
    const metrics = (await send(app.url, '/metrics', { method: 'GET', contentType: null }))
      .body as unknown as MetricsReport;
    expect(metrics.errors.unauthorized).toBeGreaterThan(0);
    expect(metrics.requests['POST /api/v1/configure 401']).toBeGreaterThan(0);
    expect((await postJson(app.url, RL, { client_id: 'sneaky', resource: 'r' })).status).toBe(404);
  });

  it('records which key made a change in the audit log, never the key itself', async () => {
    await send(app.url, CF, {
      body: JSON.stringify({ client_id: 'audited', window_seconds: 5, request_per_window: 5 }),
    });
    const entry = app.logger.entries.find((e) => e.fields.clientId === 'audited');
    expect(entry?.fields.actor).toMatch(/^[0-9a-f]{8}$/);
    const everything = JSON.stringify(app.logger.entries);
    expect(everything).not.toContain(app.apiKey);
  });

  it('never echoes the presented key in a response', async () => {
    const res = await send(app.url, CF, { body: validBody, apiKey: 'probe-secret-value' });
    expect(JSON.stringify([...res.headers]) + JSON.stringify(res.body)).not.toContain(
      'probe-secret-value',
    );
  });
});
