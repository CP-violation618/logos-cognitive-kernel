/**
 * LOGOS :: Kernel :: Clock
 * ---------------------------------------------------------------------------
 * Two clocks, deliberately separated.
 *
 *   - WALL TIME is real. It is what a timeout, a log line, and a human
 *     reading a trace care about.
 *   - LOGICAL TIME (ticks) is what the mind reasons in. It is monotonic,
 *     reproducible, freezable, and can be stepped by hand.
 *
 * Why bother? Because every interesting claim about a cognitive architecture
 * is a claim about *ordering* — which memory was consolidated before which
 * plan was revised — and ordering is untestable if it is expressed in
 * milliseconds produced by a real machine under real load. Tests drive the
 * logical clock; production reads both.
 */

import type { Tick } from './types.ts';
import { tick as mkTick } from './types.ts';

export interface ClockTick {
  /** Monotonic logical instant. Never decreases, never repeats. */
  readonly tick: Tick;
  /** Milliseconds since UNIX epoch when this tick began. */
  readonly wallTime: number;
  /** Milliseconds of wall time since the previous tick (0 for the first). */
  readonly delta: number;
}

export type TickListener = (event: ClockTick) => void;

export interface ClockOptions {
  /** Logical ticks per second of wall time when running in real-time mode. */
  readonly hz?: number;
  /** Injectable wall-clock source, for deterministic tests. */
  readonly now?: () => number;
}

/**
 * The kernel's heartbeat.
 *
 * `step()` advances exactly one logical instant and notifies listeners
 * synchronously — this is what makes the whole architecture testable: a test
 * can drive a thousand simulated cycles in microseconds and assert on the
 * resulting mental state.
 *
 * `run()` drives real-time ticks until stopped. Listeners are invoked in
 * registration order, and a throwing listener is isolated (it cannot kill the
 * heartbeat) but reported through `onListenerError` so mistakes surface
 * instead of vanishing.
 */
export class Clock {
  readonly #hz: number;
  readonly #now: () => number;
  readonly #origin: number;

  #current: Tick = mkTick(0);
  #lastWall: number;
  #interval: ReturnType<typeof setInterval> | undefined;
  #listeners: TickListener[] = [];
  #totalSteps = 0;

  /** Invoked when a listener throws. Default rethrows out-of-band. */
  onListenerError: (error: unknown, listener: TickListener) => void = (error) => {
    queueMicrotask(() => {
      throw error;
    });
  };

  constructor(options: ClockOptions = {}) {
    this.#hz = Math.max(0.001, options.hz ?? 20);
    this.#now = options.now ?? (() => Date.now());
    this.#origin = this.#now();
    this.#lastWall = this.#origin;
  }

  /** Current logical instant. Starts at 0 and only ever increases. */
  get current(): Tick {
    return this.#current;
  }

  get running(): boolean {
    return this.#interval !== undefined;
  }

  get totalSteps(): number {
    return this.#totalSteps;
  }

  /** Wall-clock milliseconds since the clock was constructed. */
  elapsed(): number {
    return this.#now() - this.#origin;
  }

  /**
   * Advance logical time by exactly one instant.
   * Synchronous and total: every listener has run before this returns.
   */
  step(): ClockTick {
    const wall = this.#now();
    const delta = wall - this.#lastWall;
    this.#lastWall = wall;

    this.#current = mkTick(this.#current + 1);
    this.#totalSteps += 1;

    const event: ClockTick = {
      tick: this.#current,
      wallTime: wall,
      delta: Math.max(0, delta),
    };

    // Iterate a copy: a listener may unsubscribe during dispatch.
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error, listener);
      }
    }

    return event;
  }

  /** Advance `n` logical instants at once. Returns the final tick event. */
  advance(n: number): ClockTick {
    if (!Number.isFinite(n) || n < 1) {
      throw new RangeError(`advance(n) requires n >= 1, received ${n}`);
    }
    let last = this.#snapshot();
    for (let i = 0; i < Math.floor(n); i += 1) last = this.step();
    return last;
  }

  /** Subscribe to ticks. Returns an unsubscribe function. */
  onTick(listener: TickListener): () => void {
    this.#listeners.push(listener);
    return () => {
      const i = this.#listeners.indexOf(listener);
      if (i >= 0) this.#listeners.splice(i, 1);
    };
  }

  /** Begin real-time ticking. Idempotent. */
  start(): void {
    if (this.#interval !== undefined) return;
    const period = Math.max(1, Math.round(1000 / this.#hz));
    this.#interval = setInterval(() => this.step(), period);
    // A heartbeat must never hold the process open on its own.
    this.#interval.unref?.();
  }

  /** Stop real-time ticking. Idempotent. Logical time is preserved. */
  stop(): void {
    if (this.#interval === undefined) return;
    clearInterval(this.#interval);
    this.#interval = undefined;
  }

  /** Reset to logical zero and drop all listeners. Used between test cases. */
  reset(): void {
    this.stop();
    this.#current = mkTick(0);
    this.#totalSteps = 0;
    this.#listeners = [];
    this.#lastWall = this.#now();
  }

  #snapshot(): ClockTick {
    return { tick: this.#current, wallTime: this.#now(), delta: 0 };
  }
}
