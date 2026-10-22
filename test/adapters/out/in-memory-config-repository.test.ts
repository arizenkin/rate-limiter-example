import { ClientLimitReachedError } from '../../../src/domain/errors';
import { InMemoryConfigRepository } from '../../../src/adapters/out/in-memory-config-repository';

describe('InMemoryConfigRepository', () => {
  it('returns undefined for unknown clients', async () => {
    expect(await new InMemoryConfigRepository(1000).get('nope')).toBeUndefined();
  });

  it('creates a client at version 1', async () => {
    const repo = new InMemoryConfigRepository(1000);
    const change = await repo.upsert('a', 10, 5);
    expect(change.previous).toBeUndefined();
    expect(change.current).toEqual({
      clientId: 'a',
      windowSeconds: 10,
      requestPerWindow: 5,
      version: 1,
    });
    expect(await repo.get('a')).toBe(change.current);
  });

  it('increments the version and reports the previous config on update', async () => {
    const repo = new InMemoryConfigRepository(1000);
    const first = await repo.upsert('a', 10, 5);
    const second = await repo.upsert('a', 20, 7);
    expect(second.previous).toBe(first.current);
    expect(second.current.version).toBe(2);
  });

  it('publishes frozen snapshots', async () => {
    const { current } = await new InMemoryConfigRepository(1000).upsert('a', 1, 1);
    expect(Object.isFrozen(current)).toBe(true);
  });

  describe('client cap', () => {
    it('rejects a new client beyond the maximum but still updates existing ones', async () => {
      const repo = new InMemoryConfigRepository(2);
      await repo.upsert('a', 10, 5);
      await repo.upsert('b', 10, 5);
      await expect(repo.upsert('c', 10, 5)).rejects.toBeInstanceOf(ClientLimitReachedError);
      expect(await repo.get('c')).toBeUndefined();
      const update = await repo.upsert('a', 20, 7);
      expect(update.current.version).toBe(2);
    });
  });
});
