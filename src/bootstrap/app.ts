import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryConfigRepository } from '../adapters/out/in-memory-config-repository';
import { InMemoryCounterStore } from '../adapters/out/in-memory-counter-store';
import { InMemoryMetrics } from '../adapters/out/in-memory-metrics';
import { Sha256ApiKeyVerifier } from '../adapters/out/sha256-api-key-verifier';
import { PerformanceClock } from '../adapters/out/performance-clock';
import { createPinoLogger } from '../adapters/out/pino-logger';
import { ProcessRuntimeInfo } from '../adapters/out/process-runtime-info';
import { createHttpServer } from '../adapters/in/http/server';
import { CheckRateLimit } from '../application/check-rate-limit';
import { ConfigureLimit } from '../application/configure-limit';
import { GetMetrics } from '../application/get-metrics';
import type { Clock } from '../application/ports/clock';
import type { Logger } from '../application/ports/logger';
import { parseEnv } from './env';
import { loadSeedClients } from './seed-loader';
import { StartupError } from './startup-error';

const SHUTDOWN_POLL_MS = 50;

export interface RunningApp {
  readonly port: number;
  readonly server: Server;
  stop(): Promise<void>;
}

export interface AppOverrides {
  readonly logger?: Logger;
  readonly clock?: Clock;
}

/** Composition root: wires adapters to the application core and starts listening. */
export async function startApp(
  env: NodeJS.ProcessEnv,
  overrides: AppOverrides = {},
): Promise<RunningApp> {
  const config = parseEnv(env);
  const logger = overrides.logger ?? createPinoLogger(config.logLevel);
  const clock = overrides.clock ?? new PerformanceClock();
  const metrics = new InMemoryMetrics();
  const configs = new InMemoryConfigRepository(config.maxClients);
  const counters = new InMemoryCounterStore({
    clock,
    onEvict: (count) => {
      metrics.recordEvictions(count);
    },
  });

  // Validate everything before opening the port: no partial start (HLD §11).
  const seeds = loadSeedClients(config.seedFile, config.maxClients);
  for (const seed of seeds) {
    await configs.upsert(seed.client_id, seed.window_seconds, seed.request_per_window);
  }

  const server = createHttpServer({
    checkRateLimit: new CheckRateLimit(configs, counters, metrics, logger),
    configureLimit: new ConfigureLimit(configs, metrics, logger),
    getMetrics: new GetMetrics(metrics, counters, new ProcessRuntimeInfo()),
    verifier: new Sha256ApiKeyVerifier(config.adminKeyHashes),
    clock,
    metrics,
    logger,
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (cause) => {
      reject(
        new StartupError(`Could not listen on ${config.host}:${config.port}: ${cause.message}`, {
          cause,
        }),
      );
    });
    server.listen(config.port, config.host, resolve);
  });
  // After startup, listener errors (e.g. EMFILE) must be logged rather than crash the process.
  server.removeAllListeners('error');
  server.on('error', (err) => {
    logger.error({ err }, 'http server error');
  });
  counters.startSweeping(config.sweepIntervalMs);

  const port = (server.address() as AddressInfo).port;
  logger.info({ port, host: config.host, seededClients: seeds.length }, 'rate limiter listening');

  return {
    port,
    server,
    stop: () =>
      new Promise<void>((resolve) => {
        counters.stopSweeping();
        logger.info({ graceMs: config.shutdownGraceMs }, 'shutting down');
        // close() stops accepting and drops idle connections. Active requests get the grace period
        // to finish; connections that go idle meanwhile are dropped on the next poll.
        const poll = setInterval(() => {
          server.closeIdleConnections();
        }, SHUTDOWN_POLL_MS);
        const force = setTimeout(() => {
          logger.warn(
            { graceMs: config.shutdownGraceMs },
            'shutdown grace period elapsed; closing remaining connections',
          );
          server.closeAllConnections();
        }, config.shutdownGraceMs);
        server.close(() => {
          clearInterval(poll);
          clearTimeout(force);
          logger.info({}, 'stopped');
          resolve();
        });
      }),
  };
}
