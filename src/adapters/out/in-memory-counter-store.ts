import type { Clock } from '../../application/ports/clock';
import type { CounterStore } from '../../application/ports/counter-store';
import type { ClientConfig, Decision } from '../../domain/config';
import { consume, newWindowState, rebase, type WindowState } from '../../domain/sliding-window';

export interface CounterStoreOptions {
  readonly clock: Clock;
  readonly onEvict?: (count: number) => void;
  /** Counters examined per synchronous sweep slice; defaults to `SWEEP_SLICE_SIZE`. */
  readonly sweepSliceSize?: number;
}

const SWEEP_SLICE_SIZE = 5000;

/**
 * Atomicity comes from `consumeNow` being fully synchronous: no `await` or I/O between reading
 * and updating a client's state, so no other request can interleave (HLD §5.1). The only `await`
 * happens in the caller, after this body has finished. Keep it that way.
 */
export class InMemoryCounterStore implements CounterStore {
  private readonly states = new Map<string, WindowState>();
  private timer: NodeJS.Timeout | undefined;
  private continuation: NodeJS.Immediate | undefined;
  private cursor: MapIterator<[string, WindowState]> | undefined;

  constructor(private readonly options: CounterStoreOptions) {}

  consume(config: ClientConfig): Promise<Decision> {
    return Promise.resolve(this.consumeNow(config));
  }

  activeKeys(): number {
    return this.states.size;
  }

  /** Starts the periodic idle sweep; the timer never keeps the process alive. */
  startSweeping(intervalMs: number): void {
    this.timer ??= setInterval(() => {
      this.sweepStep();
    }, intervalMs).unref();
  }

  stopSweeping(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    clearImmediate(this.continuation);
    this.continuation = undefined;
    this.cursor = undefined;
  }

  /** Runs a whole sweep pass in one go; returns how many counters were evicted. */
  sweep(): number {
    this.cursor = undefined;
    let evicted = 0;
    do {
      evicted += this.sweepSlice();
    } while (this.passInProgress());
    return evicted;
  }

  /**
   * Drops counter state idle for more than 2×W, examining at most one slice of counters. Each
   * slice is synchronous, so it cannot race `consume`; a pass over a large map is spread across
   * event-loop turns so it never stalls requests. A pass resumes where the last slice stopped
   * (Map iterators tolerate inserts and deletes in between).
   */
  sweepSlice(): number {
    const now = this.options.clock.nowMs();
    const budget = Math.max(1, this.options.sweepSliceSize ?? SWEEP_SLICE_SIZE); // 0 would never advance
    this.cursor ??= this.states.entries();
    let evicted = 0;
    for (let examined = 0; examined < budget; examined++) {
      const next = this.cursor.next();
      if (next.done === true) {
        this.cursor = undefined;
        break;
      }
      const [clientId, state] = next.value;
      if (now - state.lastSeen > 2 * state.windowMs && now >= state.legacyUntil) {
        this.states.delete(clientId);
        evicted++;
      }
    }
    if (evicted > 0) this.options.onEvict?.(evicted);
    return evicted;
  }

  private passInProgress(): boolean {
    return this.cursor !== undefined;
  }

  /** One timer tick: a slice now, and further slices on later turns until the pass is done. */
  private sweepStep(): void {
    clearImmediate(this.continuation); // a tick takes over a pass still in progress
    this.sweepSlice();
    if (this.passInProgress()) {
      this.continuation = setImmediate(() => {
        this.continuation = undefined;
        this.sweepStep();
      });
    }
  }

  private consumeNow(config: ClientConfig): Decision {
    const now = this.options.clock.nowMs();
    const windowMs = config.windowSeconds * 1000;
    let state = this.states.get(config.clientId);
    if (state === undefined) {
      state = newWindowState(now, windowMs);
      state.configVersion = config.version;
      this.states.set(config.clientId, state);
    } else if (config.version >= state.configVersion) {
      if (state.windowMs !== windowMs) {
        // A new window length needs new window boundaries, but usage so far still counts, so a
        // configuration change never refunds quota (HLD §6.3).
        state = rebase(state, now, windowMs);
        this.states.set(config.clientId, state);
      }
      state.configVersion = config.version;
    }
    // Otherwise the snapshot is older than the state (a reconfigure landed after the caller read
    // it): decide with the old limit but leave the state's window and legacy usage alone.
    return consume(state, now, config.requestPerWindow);
  }
}
