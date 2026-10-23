import type { CounterStore } from './ports/counter-store';
import type { Metrics, MetricsSnapshot } from './ports/metrics';
import type { RuntimeInfo, RuntimeSample } from './ports/runtime-info';

export interface MetricsReport extends MetricsSnapshot {
  readonly activeKeys: number;
  readonly process: RuntimeSample;
}

export class GetMetrics {
  constructor(
    private readonly metrics: Metrics,
    private readonly counters: CounterStore,
    private readonly runtime: RuntimeInfo,
  ) {}

  execute(): MetricsReport {
    return {
      ...this.metrics.snapshot(),
      activeKeys: this.counters.activeKeys(),
      process: this.runtime.sample(),
    };
  }
}
