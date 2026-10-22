import { ConfigureLimit } from '../../src/application/configure-limit';
import { GetMetrics } from '../../src/application/get-metrics';
import { InMemoryConfigRepository } from '../../src/adapters/out/in-memory-config-repository';
import { InMemoryCounterStore } from '../../src/adapters/out/in-memory-counter-store';
import { InMemoryMetrics } from '../../src/adapters/out/in-memory-metrics';
import { ClientLimitReachedError, ServiceUnavailableError } from '../../src/domain/errors';
import { FakeClock } from '../helpers/fake-clock';
import { RecordingLogger } from '../helpers/recording-logger';

describe('ConfigureLimit', () => {
  it('creates a client, logs old=null -> new, and counts the update', async () => {
    const configs = new InMemoryConfigRepository(1000);
    const metrics = new InMemoryMetrics();
    const logger = new RecordingLogger();
    const useCase = new ConfigureLimit(configs, metrics, logger);

    const created = await useCase.execute({
      clientId: 'a',
      windowSeconds: 10,
      requestPerWindow: 5,
      actor: 'k1',
    });
    expect(created).toEqual({ clientId: 'a', windowSeconds: 10, requestPerWindow: 5, version: 1 });
    expect(logger.entries[0]).toMatchObject({
      level: 'info',
      fields: {
        clientId: 'a',
        old: null,
        new: { windowSeconds: 10, requestPerWindow: 5, version: 1 },
      },
    });

    await useCase.execute({ clientId: 'a', windowSeconds: 20, requestPerWindow: 7, actor: 'k1' });
    expect(logger.entries[1]?.fields).toMatchObject({
      old: { windowSeconds: 10, requestPerWindow: 5, version: 1 },
      new: { windowSeconds: 20, requestPerWindow: 7, version: 2 },
    });
    expect(metrics.snapshot().configUpdates).toBe(2);
  });

  it('rethrows the client limit error (not fail-closed), logs a warning and counts nothing', async () => {
    const metrics = new InMemoryMetrics();
    const logger = new RecordingLogger();
    const useCase = new ConfigureLimit(new InMemoryConfigRepository(0), metrics, logger);
    await expect(
      useCase.execute({ clientId: 'a', windowSeconds: 1, requestPerWindow: 1, actor: 'k1' }),
    ).rejects.toBeInstanceOf(ClientLimitReachedError);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({ level: 'warn', fields: { clientId: 'a' } });
    expect(metrics.snapshot().configUpdates).toBe(0);
  });

  it('fails closed when the repository throws and does not count the update', async () => {
    const metrics = new InMemoryMetrics();
    const logger = new RecordingLogger();
    const useCase = new ConfigureLimit(
      { get: jest.fn(), upsert: () => Promise.reject(new Error('nope')) },
      metrics,
      logger,
    );
    await expect(
      useCase.execute({ clientId: 'a', windowSeconds: 1, requestPerWindow: 1, actor: 'k1' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(logger.entries[0]).toMatchObject({ level: 'error' });
    expect(metrics.snapshot().configUpdates).toBe(0);
  });
});

describe('GetMetrics', () => {
  it('combines the snapshot, active keys and runtime sample', async () => {
    const metrics = new InMemoryMetrics();
    const counters = new InMemoryCounterStore({ clock: new FakeClock() });
    await counters.consume({ clientId: 'a', windowSeconds: 1, requestPerWindow: 1, version: 1 });
    const sample = { uptimeSeconds: 5, rssBytes: 100, heapUsedBytes: 50 };
    const report = new GetMetrics(metrics, counters, { sample: () => sample }).execute();
    expect(report.activeKeys).toBe(1);
    expect(report.process).toBe(sample);
    expect(report.decisions).toEqual({ allowed: 0, denied: 0 });
  });
});
