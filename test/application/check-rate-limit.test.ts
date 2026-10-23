import { CheckRateLimit } from '../../src/application/check-rate-limit';
import type { ConfigRepository } from '../../src/application/ports/config-repository';
import type { CounterStore } from '../../src/application/ports/counter-store';
import { InMemoryConfigRepository } from '../../src/adapters/out/in-memory-config-repository';
import { InMemoryCounterStore } from '../../src/adapters/out/in-memory-counter-store';
import { InMemoryMetrics } from '../../src/adapters/out/in-memory-metrics';
import { ServiceUnavailableError, UnknownClientError } from '../../src/domain/errors';
import { FakeClock } from '../helpers/fake-clock';
import { RecordingLogger } from '../helpers/recording-logger';

function setup(overrides: { configs?: ConfigRepository; counters?: CounterStore } = {}) {
  const configs = new InMemoryConfigRepository(1000);
  const counters = new InMemoryCounterStore({ clock: new FakeClock() });
  const metrics = new InMemoryMetrics();
  const logger = new RecordingLogger();
  const useCase = new CheckRateLimit(
    overrides.configs ?? configs,
    overrides.counters ?? counters,
    metrics,
    logger,
  );
  return { configs, counters, metrics, logger, useCase };
}

describe('CheckRateLimit', () => {
  it('allows within the limit and records the decision', async () => {
    const { configs, metrics, useCase } = setup();
    await configs.upsert('a', 10, 1);
    expect(await useCase.execute({ clientId: 'a', resource: 'r' })).toEqual({
      allowed: true,
      remaining: 0,
    });
    const denied = await useCase.execute({ clientId: 'a', resource: 'r' });
    expect(denied.allowed).toBe(false);
    expect(metrics.snapshot().decisions).toEqual({ allowed: 1, denied: 1 });
  });

  it('ignores the resource', async () => {
    const { configs, useCase } = setup();
    await configs.upsert('a', 10, 1);
    await useCase.execute({ clientId: 'a', resource: 'x' });
    expect((await useCase.execute({ clientId: 'a', resource: 'y' })).allowed).toBe(false);
  });

  it('rejects unknown clients without creating state or failing closed', async () => {
    const { counters, logger, useCase } = setup();
    await expect(useCase.execute({ clientId: 'ghost', resource: 'r' })).rejects.toBeInstanceOf(
      UnknownClientError,
    );
    expect(counters.activeKeys()).toBe(0);
    expect(logger.entries).toEqual([]);
  });

  it('fails closed when the counter store throws', async () => {
    const boom = new Error('store down');
    const { configs, logger, useCase } = setup({
      counters: { consume: () => Promise.reject(boom), activeKeys: () => 0 },
    });
    await configs.upsert('a', 10, 5);
    const error: unknown = await useCase
      .execute({ clientId: 'a', resource: 'r' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect((error as Error).cause).toBe(boom);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({ level: 'error', fields: { clientId: 'a' } });
  });

  it('fails closed when the config repository throws', async () => {
    const { useCase } = setup({
      configs: { get: () => Promise.reject(new Error('corrupt')), upsert: jest.fn() },
    });
    await expect(useCase.execute({ clientId: 'a', resource: 'r' })).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });
});
