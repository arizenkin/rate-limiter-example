import type { ClientConfig } from '../../domain/config';

export interface ConfigChange {
  readonly previous: ClientConfig | undefined;
  readonly current: ClientConfig;
}

export interface ConfigRepository {
  /** Returns an immutable snapshot, or undefined for an unknown client. */
  get(clientId: string): Promise<ClientConfig | undefined>;
  /** Atomically publishes a new version (creating the client when unknown). */
  upsert(clientId: string, windowSeconds: number, requestPerWindow: number): Promise<ConfigChange>;
}
