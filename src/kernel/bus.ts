/**
 * LOGOS :: Kernel :: Event Bus
 * ---------------------------------------------------------------------------
 * The kernel's only cross-layer communication channel.
 *
 * Layers may not import each other sideways (memory may not call planning).
 * They announce facts on the bus and subscribe to facts they care about. That
 * single rule is what keeps a ten-module cognitive architecture from becoming
 * a ten-way tangle, and it is what makes replay possible: an agent's entire
 * mental history is just the ordered sequence of events that crossed this bus.
 *
 * Design notes
 *   - Delivery is SYNCHRONOUS by default. Cognitive ordering must be exact;
 *     a microtask boundary would make "consolidate before revise" a race.
 *   - A listener that throws cannot break dispatch. The error is routed to
 *     `onListenerError` and the remaining listeners still run. One broken
 *     module must not blind the mind.
 *   - Every event is stamped with the tick it occurred on, so a trace is
 *     self-describing.
 */

import type { Tick } from './types.ts';
import { LogosError } from './types.ts';

export interface LogosEvent {
  /** Stable event name, conventionally `namespace:verb` (e.g. `memory:encoded`). */
  readonly type: string;
  /** Logical instant the event was published on. */
  readonly tick: Tick;
  /** Wall-clock publish time. */
  readonly at: number;
  /** Monotonic publish sequence, unique within a bus instance. */
  readonly seq: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type EventListener = (event: LogosEvent) => void;

export interface Subscription {
  readonly pattern: string;
  unsubscribe(): void;
}

interface Entry {
  readonly pattern: string;
  readonly listener: EventListener;
  readonly once: boolean;
  /** Pre-compiled matcher; avoids re-parsing the pattern on every publish. */
  readonly match: (type: string) => boolean;
}

export interface BusOptions {
  /** Retain the last N events for introspection. 0 disables history. */
  readonly historyLimit?: number;
}

/**
 * Compile a subscription pattern into a matcher.
 *
 * Supported forms:
 *   `memory:encoded`   exact
 *   `memory:*`         one trailing segment wildcard
 *   `*`                everything
 *
 * Deliberately not a general glob: a cognitive bus whose subscribers use
 * regexes is a bus nobody can reason about.
 */
export const compilePattern = (pattern: string): ((type: string) => boolean) => {
  if (pattern === '*') return () => true;

  const starIndex = pattern.indexOf('*');
  if (starIndex === -1) return (type) => type === pattern;

  if (!pattern.endsWith('*') || pattern.indexOf('*') !== pattern.length - 1) {
    throw new LogosError('BUS_BAD_PATTERN', `unsupported subscription pattern: ${pattern}`, {
      pattern,
      hint: 'use "ns:verb", "ns:*", or "*"',
    });
  }

  const prefix = pattern.slice(0, -1);
  return (type) => type.startsWith(prefix);
};

export class EventBus {
  readonly #entries: Entry[] = [];
  readonly #historyLimit: number;
  #history: LogosEvent[] = [];
  #seq = 0;
  #dispatchDepth = 0;

  /** Highest recursion depth reached, for diagnosing event storms. */
  maxDispatchDepth = 0;

  /** Invoked when a listener throws. Default rethrows out-of-band. */
  onListenerError: (error: unknown, event: LogosEvent, listener: EventListener) => void = (
    error,
  ) => {
    queueMicrotask(() => {
      throw error;
    });
  };

  constructor(options: BusOptions = {}) {
    this.#historyLimit = Math.max(0, options.historyLimit ?? 256);
  }

  get listenerCount(): number {
    return this.#entries.length;
  }

  get publishedCount(): number {
    return this.#seq;
  }

  /** True while a publish is being dispatched (i.e. we are inside a handler). */
  get dispatching(): boolean {
    return this.#dispatchDepth > 0;
  }

  on(pattern: string, listener: EventListener): Subscription {
    return this.#add(pattern, listener, false);
  }

  once(pattern: string, listener: EventListener): Subscription {
    return this.#add(pattern, listener, true);
  }

  /** Publish an event. Returns the fully stamped event that was delivered. */
  publish(type: string, payload: Record<string, unknown> = {}, tickValue: Tick = 0 as Tick): LogosEvent {
    if (typeof type !== 'string' || type.length === 0) {
      throw new LogosError('BUS_BAD_EVENT', 'event type must be a non-empty string', { type });
    }

    this.#seq += 1;
    const event: LogosEvent = Object.freeze({
      type,
      tick: tickValue,
      at: Date.now(),
      seq: this.#seq,
      payload: Object.freeze({ ...payload }),
    });

    if (this.#historyLimit > 0) {
      this.#history.push(event);
      if (this.#history.length > this.#historyLimit) this.#history.shift();
    }

    this.#dispatchDepth += 1;
    if (this.#dispatchDepth > this.maxDispatchDepth) {
      this.maxDispatchDepth = this.#dispatchDepth;
    }
    try {
      // Snapshot: handlers routinely subscribe/unsubscribe while running.
      for (const entry of [...this.#entries]) {
        if (!entry.match(type)) continue;
        try {
          entry.listener(event);
        } catch (error) {
          this.onListenerError(error, event, entry.listener);
        }
        if (entry.once) this.#remove(entry);
      }
    } finally {
      this.#dispatchDepth -= 1;
    }

    return event;
  }

  /** Recent events, oldest first. Optionally filtered by pattern. */
  history(pattern = '*'): readonly LogosEvent[] {
    if (pattern === '*') return [...this.#history];
    const match = compilePattern(pattern);
    return this.#history.filter((e) => match(e.type));
  }

  /** Count events by type since construction (or the last `resetStats`). */
  stats(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const event of this.#history) {
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    }
    return counts;
  }

  /** Drop all subscriptions and history. */
  clear(): void {
    this.#entries.length = 0;
    this.#history = [];
  }

  #add(pattern: string, listener: EventListener, once: boolean): Subscription {
    if (typeof listener !== 'function') {
      throw new LogosError('BUS_BAD_LISTENER', 'listener must be a function', { pattern });
    }
    const entry: Entry = { pattern, listener, once, match: compilePattern(pattern) };
    this.#entries.push(entry);
    return {
      pattern,
      unsubscribe: () => this.#remove(entry),
    };
  }

  #remove(entry: Entry): void {
    const i = this.#entries.indexOf(entry);
    if (i >= 0) this.#entries.splice(i, 1);
  }
}
