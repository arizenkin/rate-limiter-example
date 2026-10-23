import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import {
  createApiKeyPair,
  Sha256ApiKeyVerifier,
} from '../../../src/adapters/out/sha256-api-key-verifier';
import { InMemoryConfigRepository } from '../../../src/adapters/out/in-memory-config-repository';
import { InMemoryCounterStore } from '../../../src/adapters/out/in-memory-counter-store';
import { InMemoryMetrics } from '../../../src/adapters/out/in-memory-metrics';
import {
  createHttpServer,
  DEFAULT_HTTP_OPTIONS,
  type HttpServerOptions,
} from '../../../src/adapters/in/http/server';
import { CheckRateLimit } from '../../../src/application/check-rate-limit';
import { ConfigureLimit } from '../../../src/application/configure-limit';
import { GetMetrics } from '../../../src/application/get-metrics';
import type { ConfigRepository } from '../../../src/application/ports/config-repository';
import type { CounterStore } from '../../../src/application/ports/counter-store';
import { FakeClock } from '../../helpers/fake-clock';
import { RecordingLogger } from '../../helpers/recording-logger';
import { postJson, registerApiKey, send } from '../../helpers/test-app';

interface Parts {
  counters?: CounterStore;
  configs?: ConfigRepository;
  checkRateLimit?: Pick<CheckRateLimit, 'execute'>;
  options?: Partial<HttpServerOptions>;
}

async function listen(parts: Parts = {}) {
  const pair = createApiKeyPair(randomBytes(32));
  const clock = new FakeClock();
  const metrics = new InMemoryMetrics();
  const logger = new RecordingLogger();
  const configs = parts.configs ?? new InMemoryConfigRepository(1000);
  const counters = parts.counters ?? new InMemoryCounterStore({ clock });
  const server: Server = createHttpServer({
    checkRateLimit: (parts.checkRateLimit ??
      new CheckRateLimit(configs, counters, metrics, logger)) as CheckRateLimit,
    configureLimit: new ConfigureLimit(configs, metrics, logger),
    getMetrics: new GetMetrics(metrics, counters, {
      sample: () => ({ uptimeSeconds: 1, rssBytes: 1, heapUsedBytes: 1 }),
    }),
    verifier: new Sha256ApiKeyVerifier([pair.hash]),
    clock,
    metrics,
    logger,
    ...(parts.options && { options: parts.options }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  registerApiKey(url, pair.key);
  return {
    server,
    url,
    metrics,
    logger,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

describe('fail-closed behaviour', () => {
  it('returns 503 (never 200) with Retry-After when the counter store fails', async () => {
    const h = await listen({
      counters: { consume: () => Promise.reject(new Error('boom')), activeKeys: () => 0 },
    });
    try {
      await postJson(h.url, '/api/v1/configure', {
        client_id: 'a',
        window_seconds: 5,
        request_per_window: 5,
      });
      const res = await postJson(h.url, '/api/v1/ratelimit', { client_id: 'a', resource: 'r' });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(res.body.error).toMatch(/treat the request as denied/);
      expect(h.metrics.snapshot().errors.fail_closed).toBe(1);
      expect(h.logger.entries.some((e) => e.level === 'error')).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('returns 503 when configure cannot store the config', async () => {
    const h = await listen({
      configs: {
        get: () => Promise.resolve(undefined),
        upsert: () => Promise.reject(new Error('disk')),
      },
    });
    try {
      const res = await postJson(h.url, '/api/v1/configure', {
        client_id: 'a',
        window_seconds: 5,
        request_per_window: 5,
      });
      expect(res.status).toBe(503);
      expect(h.metrics.snapshot().errors.fail_closed).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('returns 503 for an unexpected error that escapes the use case', async () => {
    const h = await listen({
      checkRateLimit: { execute: () => Promise.reject(new TypeError('bug')) },
    });
    try {
      const res = await postJson(h.url, '/api/v1/ratelimit', { client_id: 'a', resource: 'r' });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'internal error; treat the request as denied' });
      expect(h.metrics.snapshot().errors.internal).toBe(1);
      expect(h.logger.entries[0]).toMatchObject({
        level: 'error',
        message: 'fail-closed: unexpected error while handling request',
      });
    } finally {
      await h.close();
    }
  });

  it('drops the connection (no bogus 200) if the response cannot be serialised', async () => {
    const h = await listen({
      checkRateLimit: {
        execute: () => Promise.resolve({ allowed: true, remaining: 1n as unknown as number }),
      },
    });
    try {
      await expect(
        postJson(h.url, '/api/v1/ratelimit', { client_id: 'a', resource: 'r' }),
      ).rejects.toThrow();
      expect(h.logger.entries.some((e) => e.message === 'failed to write response')).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe('server options', () => {
  it('sets explicit timeouts from the defaults', async () => {
    const h = await listen();
    try {
      expect(h.server.keepAliveTimeout).toBe(DEFAULT_HTTP_OPTIONS.keepAliveTimeoutMs);
      expect(h.server.headersTimeout).toBe(DEFAULT_HTTP_OPTIONS.headersTimeoutMs);
      expect(h.server.requestTimeout).toBe(DEFAULT_HTTP_OPTIONS.requestTimeoutMs);
      expect(h.server.maxConnections).toBe(DEFAULT_HTTP_OPTIONS.maxConnections);
    } finally {
      await h.close();
    }
  });

  it('drops a slow-headers connection soon after headersTimeout (not after 30 s)', async () => {
    const h = await listen({ options: { headersTimeoutMs: 1000, requestTimeoutMs: 1000 } });
    try {
      const started = Date.now();
      await new Promise<void>((resolve) => {
        const socket = connect((h.server.address() as AddressInfo).port, '127.0.0.1', () => {
          socket.write('POST /api/v1/ratelimit HTTP/1.1\r\nHost: x\r\n');
        });
        socket.on('close', () => {
          resolve();
        });
        socket.on('error', () => undefined);
        socket.resume();
      });
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      await h.close();
    }
  });

  it('honours overrides, including the body cap', async () => {
    const h = await listen({
      options: {
        maxBodyBytes: 10,
        keepAliveTimeoutMs: 1000,
        headersTimeoutMs: 2000,
        requestTimeoutMs: 3000,
      },
    });
    try {
      expect([h.server.keepAliveTimeout, h.server.headersTimeout, h.server.requestTimeout]).toEqual(
        [1000, 2000, 3000],
      );
      const res = await send(h.url, '/api/v1/ratelimit', {
        body: '{"client_id":"a","resource":"b"}',
      });
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('request body must not exceed 10 bytes');
    } finally {
      await h.close();
    }
  });
});

describe('oversized chunked body', () => {
  it('closes the connection after the 413 instead of draining a continuing upload', async () => {
    const h = await listen({ options: { requestTimeoutMs: 30_000 } });
    try {
      const outcome = await new Promise<{ response: string; closedAfterMs: number }>((resolve) => {
        const startedAt = Date.now();
        const socket = connect((h.server.address() as AddressInfo).port, '127.0.0.1', () => {
          socket.write(
            'POST /api/v1/ratelimit HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n' +
              'Transfer-Encoding: chunked\r\n\r\n',
          );
          const chunk = `${(2048).toString(16)}\r\n${'x'.repeat(2048)}\r\n`;
          const pump = setInterval(() => {
            socket.write(chunk);
          }, 5);
          let response = '';
          socket.on('data', (data) => (response += String(data)));
          socket.on('error', () => undefined);
          socket.on('close', () => {
            clearInterval(pump);
            resolve({ response, closedAfterMs: Date.now() - startedAt });
          });
        });
      });
      expect(outcome.response).toContain('413');
      expect(outcome.closedAfterMs).toBeLessThan(5000);
    } finally {
      await h.close();
    }
  });
});
