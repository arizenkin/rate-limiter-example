import type { ClientConfig, Decision } from '../../domain/config';

export interface CounterStore {
  /**
   * Single atomic check-and-consume (HLD §4). Implementations must make the decision and the
   * state update one indivisible step.
   */
  consume(config: ClientConfig): Promise<Decision>;
  /** Number of clients currently holding counter state. */
  activeKeys(): number;
}
