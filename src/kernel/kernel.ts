/**
 * LOGOS :: Kernel :: Composition root
 * ---------------------------------------------------------------------------
 * `Kernel` owns the primitives and nothing else.
 *
 * It deliberately contains no cognition. Its entire job is to hold a clock, a
 * bus, a scheduler and a random source, hand them to subsystems in a fixed
 * order, and guarantee a clean lifecycle. Every interesting behaviour lives in
 * a subsystem that registers itself here.
 *
 * The payoff of that restraint is `tick()`: because the kernel knows the
 * exact order of operations in a cognitive cycle, a test can drive the entire
 * mind one instant at a time and assert on what it was thinking.
 */

import { Clock, type ClockTick, type ClockOptions } from './clock.ts';
import { EventBus, type BusOptions } from './bus.ts';
import { Scheduler, type CognitiveTask, type SchedulerOptions, type TaskOutcome } from './scheduler.ts';
import { Rng } from './rng.ts';
import type { ConfigOverrides, KernelConfig } from './config.ts';
import { defineConfig } from './config.ts';
import {
  LifecycleError,
  LogosError,
  type HealthReport,
  type Phase,
  type TaskId,
} from './types.ts';

/** Everything a subsystem is allowed to depend on. */
export interface KernelContext {
  readonly config: KernelConfig;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly scheduler: Scheduler;
  readonly rng: Rng;
  /** Publish an event already stamped with the current tick. */
  emit(type: string, payload?: Record<string, unknown>): void;
}

/**
 * A cognitive subsystem.
 *
 * `start` and `stop` are invoked in registration order and reverse
 * registration order respectively, so dependencies shut down after their
 * dependents.
 */
export interface Subsystem {
  readonly name: string;
  start(context: KernelContext): Promise<void> | void;
  stop?(): Promise<void> | void;
  health?(): HealthReport;
}

export interface KernelOptions {
  readonly config?: ConfigOverrides;
  readonly clock?: ClockOptions;
  readonly bus?: BusOptions;
  readonly scheduler?: SchedulerOptions;
}

export interface KernelSnapshot {
  readonly name: string;
  readonly phase: Phase;
  readonly tick: number;
  readonly seed: number;
  readonly uptimeMs: number;
  readonly subsystems: readonly string[];
  readonly scheduler: ReturnType<Scheduler['snapshot']>;
  readonly bus: {
    readonly listeners: number;
    readonly published: number;
    readonly retained: number;
  };
  readonly rngState: readonly [number, number, number, number];
}

export class Kernel {
  readonly config: KernelConfig;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly scheduler: Scheduler;
  readonly rng: Rng;
  readonly context: KernelContext;

  #phase: Phase = 'created';
  #subsystems: Subsystem[] = [];
  #startedAt = 0;
  #unsubscribeTick: (() => void) | undefined;
  #tickReports = 0;

  constructor(options: KernelOptions = {}) {
    this.config = defineConfig(options.config ?? {});
    this.rng = new Rng(this.config.seed);
    this.clock = new Clock({ hz: this.config.clock.hz, ...options.clock });
    this.bus = new EventBus({ historyLimit: this.config.bus.historyLimit, ...options.bus });
    this.scheduler = new Scheduler({
      budgetPerTick: this.config.scheduler.budgetPerTick,
      maxTasksPerTick: this.config.scheduler.maxTasksPerTick,
      reportEvery: this.config.scheduler.reportEvery,
      onTickReport: (report) => {
        this.#tickReports += 1;
        this.bus.publish('scheduler:report', { ...report }, this.clock.current);
      },
      ...options.scheduler,
    });

    this.context = Object.freeze({
      config: this.config,
      clock: this.clock,
      bus: this.bus,
      scheduler: this.scheduler,
      rng: this.rng,
      emit: (type: string, payload: Record<string, unknown> = {}): void => {
        this.bus.publish(type, payload, this.clock.current);
      },
    });
  }

  get phase(): Phase {
    return this.#phase;
  }

  get subsystemNames(): readonly string[] {
    return this.#subsystems.map((s) => s.name);
  }

  get tickCount(): number {
    return this.clock.current;
  }

  /** Register a subsystem. Only legal before `start()`. */
  use(subsystem: Subsystem): this {
    if (this.#phase !== 'created') {
      throw new LifecycleError('Kernel', `register subsystem "${subsystem.name}"`, this.#phase);
    }
    if (this.#subsystems.some((s) => s.name === subsystem.name)) {
      throw new LogosError('KERNEL_DUPLICATE_SUBSYSTEM', `subsystem already registered: ${subsystem.name}`, {
        name: subsystem.name,
      });
    }
    this.#subsystems.push(subsystem);
    return this;
  }

  /** Boot every subsystem, then start the heartbeat. Idempotent. */
  async start(): Promise<void> {
    if (this.#phase === 'running') return;
    if (this.#phase === 'stopped') {
      throw new LifecycleError('Kernel', 'start', 'stopped (construct a new kernel)');
    }
    if (this.#phase === 'paused') {
      this.#phase = 'running';
      this.clock.start();
      this.context.emit('kernel:resumed', {});
      return;
    }

    this.#phase = 'running';
    this.#startedAt = Date.now();
    this.context.emit('kernel:starting', { subsystems: this.#subsystems.length });

    try {
      for (const subsystem of this.#subsystems) {
        await subsystem.start(this.context);
        this.context.emit('kernel:subsystem-started', { name: subsystem.name });
      }
    } catch (error) {
      this.#phase = 'stopped';
      this.context.emit('kernel:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    // The heartbeat drives the scheduler. Subsystems never call `runTick`
    // themselves: there is exactly one place where time advances, and it is
    // here.
    this.#unsubscribeTick = this.clock.onTick(() => {
      void this.#onTick();
    });

    this.clock.start();
    this.context.emit('kernel:started', { seed: this.config.seed });
  }

  /** Orderly shutdown in reverse registration order. Idempotent. */
  async stop(): Promise<void> {
    if (this.#phase === 'stopped' || this.#phase === 'created') {
      this.#phase = 'stopped';
      return;
    }
    this.#phase = 'stopped';
    this.clock.stop();
    this.#unsubscribeTick?.();
    this.#unsubscribeTick = undefined;

    const cancelled = this.scheduler.cancelAll('kernel stopping');
    for (const subsystem of [...this.#subsystems].reverse()) {
      try {
        await subsystem.stop?.();
      } catch (error) {
        this.bus.publish(
          'kernel:subsystem-stop-error',
          { name: subsystem.name, error: error instanceof Error ? error.message : String(error) },
          this.clock.current,
        );
      }
    }
    // Announced last: subscribers to `kernel:stopped` must be able to rely on
    // every subsystem having already quiesced.
    this.context.emit('kernel:stopped', { cancelledTasks: cancelled });
  }

  /** Suspend the heartbeat without tearing down subsystems. */
  pause(): void {
    if (this.#phase !== 'running') throw new LifecycleError('Kernel', 'pause', this.#phase);
    this.#phase = 'paused';
    this.clock.stop();
    this.context.emit('kernel:paused', {});
  }

  async resume(): Promise<void> {
    if (this.#phase !== 'paused') throw new LifecycleError('Kernel', 'resume', this.#phase);
    this.#phase = 'running';
    this.clock.start();
    this.context.emit('kernel:resumed', {});
  }

  /**
   * Manual advance of logical time. This is the testing and simulation entry
   * point: it performs exactly what a real tick performs, with no timers.
   */
  async tick(): Promise<void> {
    this.clock.step();
    await this.#onTick();
  }

  /** Advance `n` ticks sequentially. */
  async advance(n: number): Promise<void> {
    for (let i = 0; i < Math.floor(n); i += 1) await this.tick();
  }

  /** Enqueue work and run it within the current tick. */
  async run<R>(task: CognitiveTask<R>): Promise<TaskOutcome<R>> {
    return this.scheduler.run(task);
  }

  /** The result of `run`, assuming it succeeded. Throws otherwise. */
  async runOrThrow<R>(task: CognitiveTask<R>): Promise<R> {
    const outcome = await this.scheduler.run(task);
    if (outcome.state !== 'done') {
      throw new LogosError('TASK_NOT_DONE', `task "${task.name}" ended as ${outcome.state}`, {
        state: outcome.state,
        note: outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? ''),
      });
    }
    return outcome.value as R;
  }

  cancelTask(id: TaskId, reason?: string): boolean {
    return reason === undefined ? this.scheduler.cancel(id) : this.scheduler.cancel(id, reason);
  }

  /** Aggregate health across the kernel and every subsystem that reports. */
  health(): readonly HealthReport[] {
    const reports: HealthReport[] = [
      {
        subsystem: 'kernel',
        phase: this.#phase,
        ok: this.#phase === 'running' || this.#phase === 'created' || this.#phase === 'paused',
        detail: `${this.#subsystems.length} subsystems, tick ${this.clock.current}`,
        metrics: {
          tick: this.clock.current,
          subsystems: this.#subsystems.length,
          listeners: this.bus.listenerCount,
          published: this.bus.publishedCount,
          pendingTasks: this.scheduler.pendingCount,
          ...this.scheduler.stats(),
        },
      },
    ];

    for (const subsystem of this.#subsystems) {
      try {
        const report = subsystem.health?.();
        if (report !== undefined) reports.push(report);
      } catch (error) {
        reports.push({
          subsystem: subsystem.name,
          phase: this.#phase,
          ok: false,
          detail: `health() threw: ${error instanceof Error ? error.message : String(error)}`,
          metrics: {},
        });
      }
    }

    return reports;
  }

  snapshot(): KernelSnapshot {
    return Object.freeze({
      name: this.config.name,
      phase: this.#phase,
      tick: this.clock.current,
      seed: this.config.seed,
      uptimeMs: this.#startedAt === 0 ? 0 : Date.now() - this.#startedAt,
      subsystems: Object.freeze([...this.subsystemNames]),
      scheduler: this.scheduler.snapshot(),
      bus: Object.freeze({
        listeners: this.bus.listenerCount,
        published: this.bus.publishedCount,
        retained: this.bus.history().length,
      }),
      rngState: this.rng.saveState(),
    });
  }

  /** Human-readable one-liner, handy in logs and test failure output. */
  describe(): string {
    const parts = [
      `logos[${this.#phase}]`,
      `tick=${this.clock.current}`,
      `subsystems=${this.#subsystems.length}`,
      `events=${this.bus.publishedCount}`,
      `pending=${this.scheduler.pendingCount}`,
    ];
    return parts.join(' ');
  }

  // ── internals ─────────────────────────────────────────────────────────────

  async #onTick(): Promise<void> {
    const tickEvent: ClockTick = {
      tick: this.clock.current,
      wallTime: Date.now(),
      delta: 0,
    };
    void tickEvent;
    await this.scheduler.runTick();
  }

  /** Tick-report count, for tests that assert reporting is wired up. */
  get tickReportCount(): number {
    return this.#tickReports;
  }
}

/** Build a kernel with a named preset. Sugar for the common case. */
export function createKernel(options: KernelOptions = {}): Kernel {
  return new Kernel(options);
}
