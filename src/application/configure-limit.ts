import type { ClientConfig } from '../domain/config';
import { ClientLimitReachedError, ServiceUnavailableError } from '../domain/errors';
import type { ConfigChange, ConfigRepository } from './ports/config-repository';
import type { Logger } from './ports/logger';
import type { Metrics } from './ports/metrics';

export interface ConfigureLimitRequest {
  readonly clientId: string;
  readonly windowSeconds: number;
  readonly requestPerWindow: number;
  /** Non-secret id of the API key that made the change, for the audit log. */
  readonly actor: string;
}

const describe = (config: ClientConfig | undefined) =>
  config === undefined
    ? null
    : {
        windowSeconds: config.windowSeconds,
        requestPerWindow: config.requestPerWindow,
        version: config.version,
      };

export class ConfigureLimit {
  constructor(
    private readonly configs: ConfigRepository,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  /** Upserts a client's limits; counters are reconciled lazily by the store (HLD §6). */
  async execute(request: ConfigureLimitRequest): Promise<ClientConfig> {
    let change: ConfigChange;
    try {
      change = await this.configs.upsert(
        request.clientId,
        request.windowSeconds,
        request.requestPerWindow,
      );
    } catch (cause) {
      if (cause instanceof ClientLimitReachedError) {
        this.logger.warn(
          { clientId: request.clientId },
          'client limit reached; configuration rejected',
        );
        throw cause;
      }
      this.logger.error(
        { err: cause, clientId: request.clientId },
        'fail-closed: configuration update failed',
      );
      throw new ServiceUnavailableError({ cause });
    }
    this.metrics.recordConfigUpdate();
    this.logger.info(
      {
        clientId: request.clientId,
        actor: request.actor,
        old: describe(change.previous),
        new: describe(change.current),
      },
      'client configuration changed',
    );
    return change.current;
  }
}
