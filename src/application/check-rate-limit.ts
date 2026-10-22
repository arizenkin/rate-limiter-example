import type { Decision } from '../domain/config';
import { ServiceUnavailableError, UnknownClientError } from '../domain/errors';
import type { ConfigRepository } from './ports/config-repository';
import type { CounterStore } from './ports/counter-store';
import type { Logger } from './ports/logger';
import type { Metrics } from './ports/metrics';

export interface CheckRateLimitRequest {
  readonly clientId: string;
  /** Accepted and validated but has no effect on decisions (HLD §2). */
  readonly resource: string;
}

export class CheckRateLimit {
  constructor(
    private readonly configs: ConfigRepository,
    private readonly counters: CounterStore,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  /**
   * Fail-closed seam (HLD §7): the only place where an unexpected error in the decision path is
   * mapped to a policy outcome. Adapters never decide policy themselves.
   */
  async execute(request: CheckRateLimitRequest): Promise<Decision> {
    // The config snapshot is read once and used for the whole decision (HLD §6.1). A reconfigure
    // landing between the read and consume is the accepted "one decision of staleness" (§6.4).
    let decision: Decision | undefined;
    try {
      const config = await this.configs.get(request.clientId);
      if (config !== undefined) decision = await this.counters.consume(config);
    } catch (cause) {
      this.logger.error(
        { err: cause, clientId: request.clientId },
        'fail-closed: rate limit decision failed',
      );
      throw new ServiceUnavailableError({ cause });
    }
    if (decision === undefined) throw new UnknownClientError(request.clientId);
    this.metrics.recordDecision(decision.allowed);
    return decision;
  }
}
