import type { Clock } from '../../src/application/ports/clock';

export class FakeClock implements Clock {
  constructor(private now = 0) {}

  nowMs(): number {
    return this.now;
  }

  advance(ms: number): void {
    this.now += ms;
  }
}
