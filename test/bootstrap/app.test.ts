import { connect, createServer } from 'node:net';
import { startApp } from '../../src/bootstrap/app';
import { StartupError } from '../../src/bootstrap/startup-error';
import type { MetricsReport } from '../../src/application/get-metrics';
import { FakeClock } from '../helpers/fake-clock';
import { postJson, send, TEST_ADMIN_HASH, startTestApp, writeSeedFile } from '../helpers/test-app';

describe('startApp', () => {
  it('seeds clients from the file and serves requests', async () => {
    const app = await startTestApp([
      { client_id: 'seeded', window_seconds: 60, request_per_window: 3 },
    ]);
    try {
      const res = await postJson(app.url, '/api/v1/ratelimit', {
        client_id: 'seeded',
        resource: 'r',
      });
      expect(res.body).toEqual({ allowed: true, remaining: 2 });
      expect(app.logger.entries.at(-1)).toMatchObject({
        level: 'info',
        message: 'rate limiter listening',
        fields: { seededClients: 1 },
      });
    } finally {
      await app.stop();
    }
  });

  it('logs, rather than crashes on, server errors after startup', async () => {
    const app = await startTestApp();
    try {
      app.server.emit('error', new Error('accept EMFILE'));
      expect(app.logger.entries.at(-1)).toMatchObject({
        level: 'error',
        message: 'http server error',
      });
    } finally {
      await app.stop();
    }
  });

  it('refuses to start when the seed file exceeds MAX_CLIENTS', async () => {
    const seedFile = writeSeedFile({
      clients: [
        { client_id: 'a', window_seconds: 1, request_per_window: 1 },
        { client_id: 'b', window_seconds: 1, request_per_window: 1 },
      ],
    });
    await expect(
      startApp({
        PORT: '0',
        HOST: '127.0.0.1',
        SEED_FILE: seedFile,
        LOG_LEVEL: 'silent',
        ADMIN_API_KEYS: TEST_ADMIN_HASH,
        MAX_CLIENTS: '1',
      }),
    ).rejects.toThrow(/exceed the limit of 1/);
  });

  it('stops listening on stop()', async () => {
    const app = await startTestApp();
    await app.stop();
    await expect(
      postJson(app.url, '/api/v1/ratelimit', { client_id: 'a', resource: 'r' }),
    ).rejects.toThrow();
  });

  describe('stop()', () => {
    const startSlowRequest = (url: string) =>
      new Promise<{ socket: ReturnType<typeof connect>; response: Promise<string> }>((resolve) => {
        const socket = connect(Number(new URL(url).port), '127.0.0.1', () => {
          // Headers promise a body that has not arrived yet, so the request stays in flight.
          socket.write(
            'POST /api/v1/ratelimit HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n' +
              'Content-Length: 32\r\n\r\n{"client_id":"a",',
          );
          const response = new Promise<string>((done) => {
            let data = '';
            socket.on('data', (chunk) => (data += String(chunk)));
            socket.on('close', () => {
              done(data);
            });
          });
          resolve({ socket, response });
        });
      });

    it('lets an in-flight request finish within the grace period', async () => {
      const app = await startTestApp(
        [{ client_id: 'a', window_seconds: 60, request_per_window: 3 }],
        { SHUTDOWN_GRACE_MS: '5000' },
      );
      const { socket, response } = await startSlowRequest(app.url);
      const stopped = app.stop();
      await new Promise((resolve) => setTimeout(resolve, 50));
      socket.write('"resource":"r"}');
      expect(await response).toContain('200 OK');
      await stopped;
    });

    it('cuts connections that are still active when the grace period ends', async () => {
      const app = await startTestApp([], { SHUTDOWN_GRACE_MS: '50' });
      const { response } = await startSlowRequest(app.url);
      await app.stop();
      expect(await response).not.toContain('200 OK');
      expect(app.logger.entries.map((e) => [e.level, e.message])).toEqual([
        ['info', 'rate limiter listening'],
        ['info', 'shutting down'],
        ['warn', 'shutdown grace period elapsed; closing remaining connections'],
        ['info', 'stopped'],
      ]);
    });

    it('can be called twice', async () => {
      const app = await startTestApp();
      await app.stop();
      await expect(app.stop()).resolves.toBeUndefined();
    });

    it('returns promptly when only idle connections remain', async () => {
      const app = await startTestApp([], { SHUTDOWN_GRACE_MS: '60000' });
      await postJson(app.url, '/api/v1/ratelimit', { client_id: 'x', resource: 'r' });
      const startedAt = Date.now();
      await app.stop();
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(app.logger.entries.map((e) => e.message)).toEqual([
        'rate limiter listening',
        'shutting down',
        'stopped',
      ]);
    });
  });

  it('evicts idle counter state on the configured sweep interval and counts it', async () => {
    const clock = new FakeClock();
    const app = await startTestApp(
      [{ client_id: 'a', window_seconds: 1, request_per_window: 5 }],
      { SWEEP_INTERVAL_MS: '10' },
      { clock },
    );
    const metrics = () =>
      send(app.url, '/metrics', { method: 'GET', contentType: null }).then(
        (r) => r.body as unknown as MetricsReport,
      );
    try {
      await postJson(app.url, '/api/v1/ratelimit', { client_id: 'a', resource: 'r' });
      expect((await metrics()).activeKeys).toBe(1);
      clock.advance(2001);
      const deadline = Date.now() + 2000;
      while ((await metrics()).activeKeys > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const final = await metrics();
      expect(final.activeKeys).toBe(0);
      expect(final.evictions).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('refuses to start on an invalid environment', async () => {
    await expect(startApp({ PORT: 'x' })).rejects.toThrow(StartupError);
  });

  it('refuses to start, without opening a port, when the seed file is bad', async () => {
    const seedFile = writeSeedFile({
      clients: [{ client_id: 'a', window_seconds: 0, request_per_window: 1 }],
    });
    await expect(
      startApp({
        PORT: '0',
        HOST: '127.0.0.1',
        SEED_FILE: seedFile,
        LOG_LEVEL: 'silent',
        ADMIN_API_KEYS: TEST_ADMIN_HASH,
      }),
    ).rejects.toThrow(/window_seconds must be between 1 and 300/);
  });

  it('reports a clear error when the port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(
        startApp({
          PORT: String(port),
          HOST: '127.0.0.1',
          SEED_FILE: writeSeedFile({ clients: [] }),
          LOG_LEVEL: 'silent',
          ADMIN_API_KEYS: TEST_ADMIN_HASH,
        }),
      ).rejects.toThrow(`Could not listen on 127.0.0.1:${port}`);
    } finally {
      blocker.close();
    }
  });

  it('uses the pino logger when none is injected', async () => {
    const app = await startApp({
      PORT: '0',
      HOST: '127.0.0.1',
      SEED_FILE: writeSeedFile({ clients: [] }),
      LOG_LEVEL: 'silent',
      ADMIN_API_KEYS: TEST_ADMIN_HASH,
    });
    await app.stop();
  });
});
