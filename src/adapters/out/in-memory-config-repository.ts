import type { ConfigChange, ConfigRepository } from '../../application/ports/config-repository';
import type { ClientConfig } from '../../domain/config';
import { ClientLimitReachedError } from '../../domain/errors';

/**
 * Configs are never evicted (HLD §5.3). Publishing replaces a frozen object in one synchronous
 * step, so readers see either the whole old or the whole new config (HLD §6.1). The number of
 * clients is capped so unauthenticated `/configure` calls cannot grow memory without bound.
 */
export class InMemoryConfigRepository implements ConfigRepository {
  private readonly configs = new Map<string, ClientConfig>();

  constructor(private readonly maxClients: number) {}

  get(clientId: string): Promise<ClientConfig | undefined> {
    return Promise.resolve(this.configs.get(clientId));
  }

  upsert(clientId: string, windowSeconds: number, requestPerWindow: number): Promise<ConfigChange> {
    const previous = this.configs.get(clientId);
    if (previous === undefined && this.configs.size >= this.maxClients) {
      return Promise.reject(new ClientLimitReachedError(this.maxClients));
    }
    const current: ClientConfig = Object.freeze({
      clientId,
      windowSeconds,
      requestPerWindow,
      version: (previous?.version ?? 0) + 1,
    });
    this.configs.set(clientId, current);
    return Promise.resolve({ previous, current });
  }
}
