import type { Clock } from '../../application/ports/clock';
import type { CounterStore } from '../../application/ports/counter-store';
import type { ClientConfig, Decision } from '../../domain/config';
import { consume, newWindowState, rebase, type WindowState } from '../../domain/sliding-window';

export interface CounterStoreOptions {
  readonly clock: Clock;
  readonly onEvict?: (count: number) => void;
}

/**
 * Atomicity comes from `consumeNow` being fully synchronous: no `await` or I/O between reading
 * and updating a client's state, so no other request can interleave (HLD §5.1). The only `await`
 * happens in the caller, after this body has finished. Keep it that way.
 */
export class InMemoryCounterStore implements CounterStore {
  private readonly states = new Map<string, WindowState>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: CounterStoreOptions) {}

  consume(config: ClientConfig): Promise<Decision> {
    return Promise.resolve(this.consumeNow(config));
  }

  activeKeys(): number {
    return this.states.size;
  }

  /** Starts the periodic idle sweep; the timer never keeps the process alive. */
  startSweeping(intervalMs: number): void {
    this.timer ??= setInterval(() => this.sweep(), intervalMs).unref();
  }

  stopSweeping(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Drops counter state idle for more than 2×W. Synchronous, so it cannot race `consume`. */
  sweep(): number {
    const now = this.options.clock.nowMs();
    let evicted = 0;
    for (const [clientId, state] of this.states) {
      if (now - state.lastSeen > 2 * state.windowMs && now >= state.legacyUntil) {
        this.states.delete(clientId);
        evicted++;
      }
    }
    if (evicted > 0) this.options.onEvict?.(evicted);
    return evicted;
  }

  private consumeNow(config: ClientConfig): Decision {
    const now = this.options.clock.nowMs();
    const windowMs = config.windowSeconds * 1000;
    let state = this.states.get(config.clientId);
    if (state === undefined) {
      state = newWindowState(now, windowMs);
      this.states.set(config.clientId, state);
    } else if (state.windowMs !== windowMs) {
      // A new window length needs new window boundaries, but usage so far still counts, so a
      // configuration change never refunds quota (HLD §6.3).
      state = rebase(state, now, windowMs);
      this.states.set(config.clientId, state);
    }
    return consume(state, now, config.requestPerWindow);
  }
}
