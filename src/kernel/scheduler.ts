/**
 * LOGOS :: Kernel :: Scheduler
 * ---------------------------------------------------------------------------
 * Attention is the scarcest resource in the system, so the scheduler is not a
 * convenience wrapper around promises — it is the *model of that scarcity*.
 *
 * Every unit of thinking in LOGOS is a `CognitiveTask` that must ask for a
 * slice of a finite per-tick budget. When the budget for a tick runs out, a
 * task is asked to yield. It may refuse (short tasks finish atomically), it
 * may accept (long deliberation resumes next tick), and it must report how
 * confident it currently is.
 *
 * Three properties fall out of modelling it this way, and none of them are
 * available if you just `await` everything:
 *
 *   1. BOUNDED WORK PER TICK. The mind can never be lost to one runaway
 *      computation; a tick is a hard ceiling on effort.
 *   2. INTERRUPTIBILITY AS A FIRST-CLASS STATE. "Half-finished thought" is a
 *      real, addressable thing in memory rather than a lost stack frame.
 *   3. DETERMINISM. With an injected clock and a seeded tie-breaker, the same
 *      task set produces the same execution order every run — which is the
 *      only way to write a regression test for a cognitive architecture.
 *
 * Ordering is a three-key total order: priority (desc), deadline (asc, absent
 * last), insertion sequence (asc). The insertion key is what removes
 * `Array.prototype.sort` stability from the correctness argument.
 */

import type { Awaitable, TaskId } from './types.ts';
import { BudgetExhaustedError, LogosError, newTaskId } from './types.ts';

export type TaskState = 'pending' | 'running' | 'yielded' | 'done' | 'failed' | 'cancelled';

export type YieldReason = 'budget' | 'blocked' | 'preempted' | 'suspended';

/** Opaque handle a task uses to give the scheduler back its turn. */
export interface YieldToken {
  readonly reason: YieldReason;
  /** Free-form note stored for introspection ("waiting on retrieval"). */
  readonly detail: string | undefined;
}

/** Hands a task its slice of the tick and lets it release control early. */
export type YieldFn = (reason: YieldReason, detail?: string) => YieldToken;

/** A resumable step of thinking. Return `yielded` to come back next tick. */
export type TaskBody<R = unknown> = (signal: AbortSignal, yieldTo: YieldFn) => Awaitable<TaskResult<R>>;

export type TaskResult<R = unknown> =
  | { readonly status: 'done'; readonly value?: R }
  | { readonly status: 'yielded'; readonly detail?: string }
  | { readonly status: 'blocked'; readonly detail?: string };

export interface CognitiveTask<R = unknown> {
  readonly id?: TaskId;
  readonly name: string;
  /**
   * Higher runs first. Suggested bands:
   *   1000 reflex / safety   100 deliberation
   *    500  goal pursuit      50 consolidation & background
   */
  readonly priority?: number;
  /** Optional logical deadline; earlier deadlines win ties and break starvation. */
  readonly deadline?: number;
  /** Cost accounting tag, surfaces in `stats()`. */
  readonly resource?: string;
  /**
   * Budget units billed when this task completes rather than yields.
   * Defaults to 1. Raise it for tasks that genuinely consume more of a tick,
   * so that a cheap task and an expensive one are not billed alike.
   */
  readonly chargeOnComplete?: number;
  readonly run: TaskBody<R>;
}

interface Record_<R> {
  readonly id: TaskId;
  readonly name: string;
  priority: number;
  readonly deadline: number | undefined;
  readonly resource: string;
  readonly chargeOnComplete: number;
  readonly seq: number;
  readonly run: TaskBody<R>;
  state: TaskState;
  /** Ticks of budget consumed across all attempts. */
  work: number;
  /** Ticks on which this task was admitted to run. */
  attempts: number;
  /** Tick it was last admitted, or -1. */
  lastRunTick: number;
  /** Human-readable outcome: failure message or yield detail. */
  note: string;
  readonly controller: AbortController;
  /** Resolves for tasks that finished with `status: 'done'`. */
  readonly settled: Promise<TaskOutcome<R>>;
  resolve: (outcome: TaskOutcome<R>) => void;
  /** Steps of the current attempt still available. Reset on each admission. */
  allowance: number;
}

export interface TaskOutcome<R = unknown> {
  readonly id: TaskId;
  readonly name: string;
  readonly state: 'done' | 'failed' | 'cancelled';
  readonly value: R | undefined;
  readonly error: unknown;
  readonly work: number;
  readonly attempts: number;
  /** Tick on which the terminal transition happened. */
  readonly finishedAtTick: number;
}

export interface SchedulerOptions {
  /** Hard ceiling on effort per tick, in work units. */
  readonly budgetPerTick?: number;
  /** Maximum tasks admitted within a single tick. */
  readonly maxTasksPerTick?: number;
  /** Reporting cadence: emit `scheduler:tick` every N ticks. */
  readonly reportEvery?: number;
  readonly onTickReport?: (report: TickReport) => void;
}

export interface TickReport {
  readonly tick: number;
  readonly budgetUsed: number;
  readonly budgetTotal: number;
  readonly admitted: number;
  readonly completed: number;
  readonly yielded: number;
  readonly pending: number;
  readonly running: number;
  readonly byResource: Readonly<Record<string, number>>;
}

export interface SchedulerSnapshot {
  readonly tick: number;
  readonly pending: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly yielded: number;
  readonly cancelled: number;
  readonly budgetPerTick: number;
  readonly utilization: number;
  readonly queue: readonly {
    readonly id: TaskId;
    readonly name: string;
    readonly priority: number;
    readonly state: TaskState;
  }[];
}

export class Scheduler {
  readonly #budgetPerTick: number;
  readonly #maxTasksPerTick: number;
  readonly #reportEvery: number;
  readonly #onTickReport: ((r: TickReport) => void) | undefined;

  /** Live and recently-terminal records, keyed by id. */
  readonly #records = new Map<TaskId, Record_<unknown>>();
  /** Admission order key. Monotonic, never reused. */
  #seq = 0;
  #tick = 0;
  /**
   * Tasks already given a slice during the CURRENT tick.
   *
   * This is the invariant that makes "yield" mean something. Without it a
   * task that yields is immediately the highest-priority candidate again, so
   * a single tick would run it to completion and yielding would be a no-op
   * that merely disguised an unbounded loop.
   */
  #attemptedThisTick = new Set<TaskId>();
  /** Admission slots still available in the current tick. */
  #admissionsLeft = 0;
  /** Budget units still available in the current tick. */
  #budgetLeft = 0;

  #completed = 0;
  #failed = 0;
  #yieldCount = 0;
  #cancelled = 0;
  #totalWork = 0;
  #totalCapacity = 0;

  constructor(options: SchedulerOptions = {}) {
    this.#budgetPerTick = Math.max(1, options.budgetPerTick ?? 8);
    this.#maxTasksPerTick = Math.max(1, options.maxTasksPerTick ?? 4);
    this.#reportEvery = Math.max(1, options.reportEvery ?? 0) || 0;
    this.#onTickReport = options.onTickReport;
    this.#admissionsLeft = this.#maxTasksPerTick;
    this.#budgetLeft = this.#budgetPerTick;
  }

  get tick(): number {
    return this.#tick;
  }

  get pendingCount(): number {
    let n = 0;
    for (const r of this.#records.values()) if (r.state === 'pending' || r.state === 'yielded') n += 1;
    return n;
  }

  get runningCount(): number {
    let n = 0;
    for (const r of this.#records.values()) if (r.state === 'running') n += 1;
    return n;
  }

  /** Mean budget utilisation across all elapsed ticks, in [0, 1]. */
  get utilization(): number {
    return this.#totalCapacity === 0 ? 0 : this.#totalWork / this.#totalCapacity;
  }

  /**
   * Admit a task. It is not executed until the next `run`/`drain`.
   * Returns a promise that settles on the task's terminal state.
   */
  enqueue<R>(task: CognitiveTask<R>): { id: TaskId; settled: Promise<TaskOutcome<R>> } {
    if (typeof task?.run !== 'function') {
      throw new LogosError('SCHED_BAD_TASK', 'task.run must be a function', { name: task?.name });
    }
    const id = task.id ?? newTaskId();

    let resolve!: (o: TaskOutcome<R>) => void;
    const settled = new Promise<TaskOutcome<R>>((res) => {
      resolve = res;
    });

    this.#seq += 1;
    const record: Record_<R> = {
      id,
      name: task.name,
      priority: task.priority ?? 100,
      deadline: task.deadline,
      resource: task.resource ?? 'default',
      chargeOnComplete: Math.max(1, task.chargeOnComplete ?? 1),
      seq: this.#seq,
      run: task.run,
      state: 'pending',
      work: 0,
      attempts: 0,
      lastRunTick: -1,
      note: '',
      controller: new AbortController(),
      settled,
      resolve,
      allowance: 0,
    };

    this.#records.set(id, record as Record_<unknown>);
    return { id, settled };
  }

  /** Enqueue and immediately attempt within the current tick. */
  async run<R>(task: CognitiveTask<R>): Promise<TaskOutcome<R>> {
    const { settled } = this.enqueue(task);
    await this.#drainSlices(1);
    return settled;
  }

  /**
   * Advance one logical tick: admit as many distinct tasks as the tick's
   * admission allowance and budget permit, then report.
   *
   * The loop terminates because `#attemptedThisTick` grows by one on every
   * iteration and is bounded by the number of tracked tasks — so a task that
   * yields every time it runs costs one admission per tick and can never
   * monopolise the cycle. Work it did not need is returned to the tick and
   * spent on lower-priority tasks instead.
   */
  async runTick(): Promise<TickReport> {
    this.#tick += 1;
    this.#admissionsLeft = this.#maxTasksPerTick;
    this.#budgetLeft = this.#budgetPerTick;
    this.#attemptedThisTick.clear();

    let admitted = 0;
    let completed = 0;
    let yielded = 0;
    const byResource: Record<string, number> = {};

    while (this.#admissionsLeft > 0 && this.#budgetLeft > 0) {
      const next = this.#selectNext();
      if (next === undefined) break;

      this.#attemptedThisTick.add(next.id);
      this.#admissionsLeft -= 1;
      admitted += 1;

      const spent = await this.#attempt(next);
      byResource[next.resource] = (byResource[next.resource] ?? 0) + spent;
      if (next.state === 'done' || next.state === 'failed') completed += 1;
      if (next.state === 'yielded') yielded += 1;
    }

    this.#totalCapacity += this.#budgetPerTick;

    const report: TickReport = Object.freeze({
      tick: this.#tick,
      budgetUsed: this.#budgetPerTick - this.#budgetLeft,
      budgetTotal: this.#budgetPerTick,
      admitted,
      completed,
      yielded,
      pending: this.pendingCount,
      running: this.runningCount,
      byResource: Object.freeze({ ...byResource }),
    });

    if (this.#reportEvery > 0 && this.#tick % this.#reportEvery === 0) {
      this.#onTickReport?.(report);
    }

    return report;
  }

  /** Advance up to `ticks` logical ticks, stopping early when the queue empties. */
  async drain(ticks: number): Promise<TickReport[]> {
    if (!Number.isFinite(ticks) || ticks < 1) {
      throw new RangeError(`drain(ticks) requires ticks >= 1, received ${ticks}`);
    }
    const reports: TickReport[] = [];
    for (let i = 0; i < Math.floor(ticks); i += 1) {
      if (this.pendingCount === 0 && this.runningCount === 0) break;
      reports.push(await this.runTick());
    }
    return reports;
  }

  /** Await a specific task's terminal outcome. */
  async outcome<R>(id: TaskId): Promise<TaskOutcome<R> | undefined> {
    const record = this.#records.get(id) as Record_<R> | undefined;
    if (record === undefined) return undefined;
    return record.settled;
  }

  getState(id: TaskId): TaskState | undefined {
    return this.#records.get(id)?.state;
  }

  /**
   * Request cancellation. A task that is mid-attempt observes its AbortSignal;
   * a queued task is cancelled immediately.
   */
  cancel(id: TaskId, reason = 'cancelled by caller'): boolean {
    const record = this.#records.get(id);
    if (record === undefined) return false;
    if (record.state === 'done' || record.state === 'failed' || record.state === 'cancelled') {
      return false;
    }
    record.note = reason;
    record.controller.abort(reason);
    if (record.state !== 'running') this.#settle(record, 'cancelled', undefined, undefined);
    return true;
  }

  /** Cancel everything queued or running. Used on shutdown. */
  cancelAll(reason = 'scheduler stopped'): number {
    let n = 0;
    for (const id of [...this.#records.keys()]) {
      if (this.cancel(id, reason)) n += 1;
    }
    return n;
  }

  /** Forget records in terminal states, reclaiming memory. */
  prune(): number {
    let n = 0;
    for (const [id, record] of [...this.#records]) {
      if (record.state === 'done' || record.state === 'failed' || record.state === 'cancelled') {
        this.#records.delete(id);
        n += 1;
      }
    }
    return n;
  }

  /** Raise the budget available in the current tick (e.g. idle capacity). */
  grantBudget(units: number): void {
    if (units > 0) this.#budgetLeft += units;
  }

  stats(): Readonly<Record<string, number>> {
    return Object.freeze({
      tick: this.#tick,
      completed: this.#completed,
      failed: this.#failed,
      yielded: this.#yieldCount,
      cancelled: this.#cancelled,
      pending: this.pendingCount,
      running: this.runningCount,
      budgetPerTick: this.#budgetPerTick,
      utilization: Number(this.utilization.toFixed(4)),
      tracked: this.#records.size,
    });
  }

  snapshot(): SchedulerSnapshot {
    const queue = [...this.#records.values()]
      .filter((r) => r.state !== 'done' && r.state !== 'failed' && r.state !== 'cancelled')
      .sort(this.#compare.bind(this))
      .map((r) => ({ id: r.id, name: r.name, priority: r.priority, state: r.state }));

    return Object.freeze({
      tick: this.#tick,
      pending: this.pendingCount,
      running: this.runningCount,
      completed: this.#completed,
      failed: this.#failed,
      yielded: this.#yieldCount,
      cancelled: this.#cancelled,
      budgetPerTick: this.#budgetPerTick,
      utilization: Number(this.utilization.toFixed(4)),
      queue: Object.freeze(queue),
    });
  }

  reset(): void {
    this.cancelAll('scheduler reset');
    this.#records.clear();
    this.#attemptedThisTick.clear();
    this.#seq = 0;
    this.#tick = 0;
    this.#admissionsLeft = this.#maxTasksPerTick;
    this.#budgetLeft = this.#budgetPerTick;
    this.#completed = 0;
    this.#failed = 0;
    this.#yieldCount = 0;
    this.#cancelled = 0;
    this.#totalWork = 0;
    this.#totalCapacity = 0;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** The three-key total order described in the file header. */
  #compare(a: Record_<unknown>, b: Record_<unknown>): number {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const da = a.deadline ?? Number.POSITIVE_INFINITY;
    const db = b.deadline ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    return a.seq - b.seq;
  }

  /** Pick the highest-ranked task admissible in this tick and not yet tried. */
  #selectNext(): Record_<unknown> | undefined {
    let best: Record_<unknown> | undefined;
    for (const record of this.#records.values()) {
      if (record.state !== 'pending' && record.state !== 'yielded') continue;
      if (this.#attemptedThisTick.has(record.id)) continue;
      if (best === undefined || this.#compare(record, best) < 0) best = record;
    }
    return best;
  }

  /**
   * Run one attempt for a record.
   *
   * The slice is capped at half the tick's capacity so that a single greedy
   * task cannot monopolise an entire tick and starve the rest of the queue —
   * an agent that can only ever think one thought per cycle is not thinking.
   * Whatever the task leaves unused is returned to the tick.
   */
  async #attempt(record: Record_<unknown>): Promise<number> {
    const perTaskCeiling = Math.max(1, Math.ceil(this.#budgetPerTick / 2));
    const allowance = Math.max(1, Math.min(this.#budgetLeft, perTaskCeiling));

    record.allowance = allowance;
    record.state = 'running';
    record.attempts += 1;
    record.lastRunTick = this.#tick;

    // Slice accounting. `record.allowance` is what remains unspent of the
    // grant; `unspent` is read before anything zeroes it.
    //
    // Charging rule, stated once and applied uniformly:
    //
    //   · A task that FINISHES is charged exactly `chargeOnComplete` (default
    //     1). Thinking that reaches a conclusion is billed for the conclusion,
    //     not for the time it was allowed to take. This is what lets three
    //     cheap tasks all run inside one tick instead of the first one
    //     absorbing the whole budget.
    //
    //   · A task that YIELDS is charged its entire slice, however much wall
    //     effort it appeared to use. Interrupting a thought has a real cost —
    //     the state must be parked and restored — and this is what makes the
    //     tick budget an honest ceiling rather than a suggestion. It also
    //     means a task that yields never gets a second slice in the same tick,
    //     so deliberation is forced to spread across cycles.
    //
    const granted = allowance;
    const effort = record.chargeOnComplete;

    const step = (reason: YieldReason, detail?: string): YieldToken => {
      // Yielding consumes the rest of this attempt's slice. A task that calls
      // `yieldTo()` and then keeps working is charged the same as one that
      // simply returns `yielded` — there is no cheaper way to interrupt.
      record.allowance = 0;
      return { reason, detail };
    };

    /** Charge the tick for work actually done. Never exceeds the grant. */
    const charge = (units: number): number => {
      const spent = Math.max(0, Math.min(granted, units));
      record.work += spent;
      this.#totalWork += spent;
      this.#budgetLeft -= spent;
      record.allowance = 0;
      return spent;
    };

    const chargeFor = (status: TaskResult<unknown>['status']): number =>
      // Completion is billed at its declared effort. Anything else — explicit
      // `yieldTo()`, an implicit `yielded`, or `blocked` — consumed the whole
      // slice by definition. Reading this off the status rather than off
      // `record.allowance` keeps the rule a function of what the task
      // *reported* instead of which callback it happened to call.
      charge(status === 'done' ? effort : granted);

    let result: TaskResult<unknown>;
    try {
      result = await record.run(record.controller.signal, step);
    } catch (error) {
      // A body that threw consumed whatever remains unspent; charge it and
      // settle. Charging the full grant would be wrong (it may have failed
      // instantly) but the remainder is genuinely gone.
      const spent = charge(granted - record.allowance);
      if (record.controller.signal.aborted) {
        record.note = String(record.controller.signal.reason ?? 'aborted');
        this.#settle(record, 'cancelled', undefined, undefined);
      } else {
        record.note = error instanceof Error ? error.message : String(error);
        this.#settle(record, 'failed', undefined, error);
      }
      return spent;
    }

    const spent = chargeFor(result.status);

    switch (result.status) {
      case 'done':
        this.#settle(record, 'done', result.value, undefined);
        break;
      case 'yielded':
        record.state = 'yielded';
        record.note = result.detail ?? 'yielded';
        this.#yieldCount += 1;
        break;
      case 'blocked':
        record.state = 'yielded';
        record.note = result.detail ?? 'blocked';
        this.#yieldCount += 1;
        break;
    }

    if (record.controller.signal.aborted && record.state !== 'running') {
      this.#settle(record, 'cancelled', undefined, undefined);
    }

    return spent;
  }

  #settle(
    record: Record_<unknown>,
    state: 'done' | 'failed' | 'cancelled',
    value: unknown,
    error: unknown,
  ): void {
    if (record.state === 'done' || record.state === 'failed' || record.state === 'cancelled') return;
    record.state = state;
    if (state === 'done') this.#completed += 1;
    if (state === 'failed') this.#failed += 1;
    if (state === 'cancelled') this.#cancelled += 1;

    record.resolve({
      id: record.id,
      name: record.name,
      state,
      value,
      error,
      work: record.work,
      attempts: record.attempts,
      finishedAtTick: this.#tick,
    });
  }

  /** Internal helper: run `n` sequential drains of one slice each. */
  async #drainSlices(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) await this.runTick();
  }
}

// Re-export so budget errors raised by callers share one class identity.
export { BudgetExhaustedError };
