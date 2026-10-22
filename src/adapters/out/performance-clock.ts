import type { Clock } from '../../application/ports/clock';

export class PerformanceClock implements Clock {
  nowMs(): number {
    return performance.now();
  }
}
