/**
 * LOGOS :: Planning :: Goals
 * ---------------------------------------------------------------------------
 * What the mind wants, and why it wants it.
 *
 * A goal is not a to-do item. Three things distinguish it, and each has
 * mechanical consequences:
 *
 * 1. A GOAL HAS A STRUCTURE. It decomposes into subgoals, which decompose
 *    further. A mind pursuing a flat list of tasks cannot pursue anything that
 *    requires more than one level of forethought, and the whole point of
 *    planning is to handle objectives you cannot reach in one move.
 *
 * 2. A GOAL HAS A PRICE. `utility` says how much achieving it is worth;
 *    `cost` accumulates what has been spent trying. Priority is not a number
 *    someone typed in — it is value weighed against expenditure and against
 *    the likelihood of success, recomputed as the situation changes.
 *
 * 3. A GOAL CAN BE ABANDONED, AND THAT IS A FEATURE. A mind that never gives
 *    up is not persistent, it is stuck. Abandonment is explicit, recorded, and
 *    reasoned: the goal is dropped when its expected value falls below what
 *    the effort could earn elsewhere, and the reason is kept so the decision
 *    can be examined later.
 *
 * Two further mechanisms make the structure behave like motivation rather than
 * like a tree data structure:
 *
 *   DEADLINES CREATE URGENCY, NOT JUST ORDERING. A goal's priority rises as its
 *   deadline approaches, which is what makes a mind stop working on the
 *   important thing and deal with the urgent one. That is a real behaviour with
 *   real costs, and an architecture that cannot exhibit it cannot explain
 *   procrastination either.
 *
 *   GOALS CAN CONFLICT. Two goals can be marked mutually exclusive, and the
 *   system then has to choose rather than pursue both at half strength.
 */

import type { Clock } from '../kernel/clock.ts';
import type { EventBus } from '../kernel/bus.ts';
import type { Credence, GoalId, Tick } from '../kernel/types.ts';
import { LogosError, clampCredence, newGoalId } from '../kernel/types.ts';
import type { BeliefStore } from '../reasoning/beliefs.ts';

/**
 * Where a goal is in its life.
 *
 * `blocked` is distinct from `suspended` on purpose: a suspended goal was set
 * aside by choice, a blocked one is waiting on something outside the mind's
 * control. Conflating them would lose the distinction between "I am not working
 * on this" and "I cannot work on this", which are the two facts a scheduler
 * most needs.
 */
export type GoalStatus =
  | 'pending' // declared, not yet started
  | 'active' // being pursued
  | 'blocked' // waiting on an unmet precondition or a failed dependency
  | 'suspended' // set aside deliberately
  | 'achieved' // succeeded
  | 'failed' // tried and could not
  | 'abandoned'; // given up on, with a reason

export const TERMINAL_STATUSES: readonly GoalStatus[] = Object.freeze([
  'achieved',
  'failed',
  'abandoned',
]);

/**
 * How a goal's subgoals combine.
 *
 *   all — every subgoal must be achieved (a conjunction)
 *   any — one suffices (a disjunction)
 *   sequence — all, in order, and the order matters
 */
export type GoalComposition = 'all' | 'any' | 'sequence';

export interface Goal {
  readonly id: GoalId;
  /** What is wanted, stated as an outcome rather than an action. */
  readonly description: string;
  readonly status: GoalStatus;
  readonly composition: GoalComposition;
  readonly parent: GoalId | undefined;
  readonly children: readonly GoalId[];
  /** Intrinsic worth of achieving this, in [0,1]. */
  readonly utility: Credence;
  /**
   * Accumulated effort spent pursuing it, in abstract cost units.
   *
   * Tracked so that priority can reflect sunk effort without being dominated
   * by it — see `GoalSystem.priority()` for how the two are weighted and why.
   */
  readonly cost: number;
  /** Belief that the goal is achievable, in [0,1]. Updated by evidence. */
  readonly feasibility: Credence;
  /** Position in the pursuit order. Recomputed by `reprioritise()`. */
  readonly priority: number;
  /** Logical instant, absolute. A goal without one is never urgent. */
  readonly deadline: Tick | undefined;
  /** Earliest instant at which pursuit may begin. */
  readonly notBefore: Tick | undefined;
  /** Dependencies: goals that must be achieved first. */
  readonly requires: readonly GoalId[];
  /** Goal ids that cannot be pursued alongside this one. */
  readonly conflictsWith: readonly GoalId[];
  /** 0 = top level. Depth is what bounds decomposition. */
  readonly depth: number;
  readonly createdAt: Tick;
  readonly updatedAt: Tick;
  /** Why the goal ended, when it did. Empty while it is live. */
  readonly outcome: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface GoalSystemOptions {
  readonly clock: Clock;
  readonly bus: EventBus;
  /** Simultaneously active top-level goals. Further goals wait. */
  readonly maxActive?: number;
  /** Expected value below which an active goal is abandoned. */
  readonly abandonBelow?: number;
  /** Maximum decomposition depth. */
  readonly maxDepth?: number;
  /** Ticks without progress before a goal is treated as stalled. */
  readonly stallTicks?: number;
  /** How much accumulated cost suppresses priority. 0 ignores sunk cost. */
  readonly sunkCostWeight?: number;
  /** Optional belief store, used to read a goal's feasibility. */
  readonly beliefs?: BeliefStore;
}

interface GoalRecord {
  id: GoalId;
  description: string;
  status: GoalStatus;
  composition: GoalComposition;
  parent: GoalId | undefined;
  children: GoalId[];
  utility: number;
  cost: number;
  feasibility: number;
  priority: number;
  deadline: Tick | undefined;
  notBefore: Tick | undefined;
  requires: GoalId[];
  conflictsWith: GoalId[];
  depth: number;
  createdAt: Tick;
  updatedAt: Tick;
  /** Tick of the last progress event, for stall detection. */
  lastProgressAt: Tick;
  outcome: string;
  data: Record<string, unknown>;
  /** Priority computed at the last reprioritise, for reporting the change. */
  lastComputedPriority: number;
}

export interface GoalStats {
  readonly total: number;
  readonly active: number;
  readonly pending: number;
  readonly blocked: number;
  readonly achieved: number;
  readonly failed: number;
  readonly abandoned: number;
  readonly totalCost: number;
  readonly topPriority: number;
}

export interface AbandonmentRecord {
  readonly goalId: GoalId;
  readonly description: string;
  readonly reason: string;
  readonly expectedValue: number;
  readonly cost: number;
  readonly at: Tick;
}

export class GoalSystem {
  readonly #clock: Clock;
  readonly #bus: EventBus;
  readonly #maxActive: number;
  readonly #abandonBelow: number;
  readonly #maxDepth: number;
  readonly #stallTicks: number;
  readonly #sunkCostWeight: number;
  #beliefs: BeliefStore | undefined;

  readonly #goals = new Map<GoalId, GoalRecord>();
  #abandonments: AbandonmentRecord[] = [];
  #seq = 0;

  constructor(options: GoalSystemOptions) {
    this.#clock = options.clock;
    this.#bus = options.bus;
    this.#maxActive = Math.max(1, Math.floor(options.maxActive ?? 3));
    this.#abandonBelow = clampUnit(options.abandonBelow ?? 0.08);
    this.#maxDepth = Math.max(1, Math.floor(options.maxDepth ?? 6));
    this.#stallTicks = Math.max(1, Math.floor(options.stallTicks ?? 24));
    this.#sunkCostWeight = clampUnit(options.sunkCostWeight ?? 0.3);
    this.#beliefs = options.beliefs;
  }

  /** Attach a belief store after construction, for feasibility lookups. */
  setBeliefs(beliefs: BeliefStore | undefined): void {
    this.#beliefs = beliefs;
  }

  // ── introspection ─────────────────────────────────────────────────────────

  get size(): number {
    return this.#goals.size;
  }

  get activeCount(): number {
    let n = 0;
    for (const goal of this.#goals.values()) if (goal.status === 'active') n += 1;
    return n;
  }

  get abandonments(): readonly AbandonmentRecord[] {
    return [...this.#abandonments];
  }

  get(id: string): Goal | undefined {
    const record = this.#goals.get(id as GoalId);
    return record === undefined ? undefined : this.#view(record);
  }

  /** Every goal, deepest-last, in insertion order. */
  all(): readonly Goal[] {
    return [...this.#goals.values()].map((r) => this.#view(r));
  }

  byStatus(...statuses: readonly GoalStatus[]): readonly Goal[] {
    const wanted = new Set(statuses);
    return this.all().filter((g) => wanted.has(g.status));
  }

  /** Children of a goal, in declaration order. */
  childrenOf(id: string): readonly Goal[] {
    const record = this.#goals.get(id as GoalId);
    if (record === undefined) return [];
    return record.children
      .map((childId) => this.#goals.get(childId))
      .filter((c): c is GoalRecord => c !== undefined)
      .map((c) => this.#view(c));
  }

  /** The chain from the root goal down to this one, inclusive. */
  ancestry(id: string): readonly Goal[] {
    const chain: Goal[] = [];
    const seen = new Set<string>();
    let cursor: GoalId | undefined = id as GoalId;

    while (cursor !== undefined) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const record = this.#goals.get(cursor);
      if (record === undefined) break;
      chain.push(this.#view(record));
      cursor = record.parent;
    }
    return chain.reverse();
  }

  stats(): GoalStats {
    const goals = [...this.#goals.values()];
    const count = (status: GoalStatus): number => goals.filter((g) => g.status === status).length;
    return Object.freeze({
      total: goals.length,
      active: count('active'),
      pending: count('pending'),
      blocked: count('blocked'),
      achieved: count('achieved'),
      failed: count('failed'),
      abandoned: count('abandoned'),
      totalCost: round(goals.reduce((a, g) => a + g.cost, 0)),
      topPriority: round(goals.reduce((a, g) => Math.max(a, g.priority), 0)),
    });
  }

  describe(): string {
    const s = this.stats();
    return (
      `goals[n=${s.total} active=${s.active} pending=${s.pending} ` +
      `blocked=${s.blocked} done=${s.achieved} abandoned=${s.abandoned}]`
    );
  }

  // ── declaration ───────────────────────────────────────────────────────────

  /**
   * Declare a goal.
   *
   * A goal is an OUTCOME, not an action: "the report is delivered", not "send
   * the report". The difference matters because only an outcome can be checked
   * after the fact, and a mind that cannot tell whether it succeeded cannot
   * learn from either case.
   */
  declare(
    description: string,
    options: {
      readonly parent?: string;
      readonly utility?: number;
      readonly deadline?: Tick;
      readonly notBefore?: Tick;
      readonly requires?: readonly string[];
      readonly conflictsWith?: readonly string[];
      readonly composition?: GoalComposition;
      readonly feasibility?: number;
      readonly data?: Record<string, unknown>;
    } = {},
  ): Goal {
    const text = normalise(description);

    const parentRecord = options.parent === undefined ? undefined : this.#goals.get(options.parent as GoalId);
    if (options.parent !== undefined && parentRecord === undefined) {
      throw new LogosError('GOAL_MISSING_PARENT', `parent goal not found: ${options.parent}`, {
        parent: options.parent,
      });
    }

    const depth = parentRecord === undefined ? 0 : parentRecord.depth + 1;
    if (depth > this.#maxDepth) {
      throw new LogosError('GOAL_TOO_DEEP', `decomposition depth ${depth} exceeds the limit of ${this.#maxDepth}`, {
        depth,
        maxDepth: this.#maxDepth,
      });
    }

    const requires = (options.requires ?? []).map((id) => id as GoalId);
    for (const required of requires) {
      if (!this.#goals.has(required)) {
        throw new LogosError('GOAL_MISSING_REQUIREMENT', `required goal not found: ${required}`, { required });
      }
      if (required === (options.parent as GoalId | undefined)) {
        throw new LogosError('GOAL_CIRCULAR_REQUIREMENT', 'a goal cannot require its own parent', { required });
      }
    }

    this.#seq += 1;
    const record: GoalRecord = {
      id: newGoalId(),
      description: text,
      status: 'pending',
      composition: options.composition ?? 'all',
      parent: parentRecord?.id,
      children: [],
      utility: clampUnit(options.utility ?? 0.5),
      cost: 0,
      feasibility: clampCredence(options.feasibility ?? 0.5),
      priority: 0,
      deadline: options.deadline,
      notBefore: options.notBefore,
      requires,
      conflictsWith: (options.conflictsWith ?? []).map((id) => id as GoalId),
      depth,
      createdAt: this.#clock.current,
      updatedAt: this.#clock.current,
      lastProgressAt: this.#clock.current,
      outcome: '',
      data: { ...(options.data ?? {}) },
      lastComputedPriority: 0,
    };

    this.#goals.set(record.id, record);
    if (parentRecord !== undefined) parentRecord.children.push(record.id);

    this.#reprioritise();

    this.#bus.publish(
      'goal:declared',
      {
        id: record.id,
        description: text,
        parent: parentRecord?.id ?? null,
        utility: record.utility,
        depth,
      },
      this.#clock.current,
    );

    return this.#view(record);
  }

  // ── life cycle ────────────────────────────────────────────────────────────

  /**
   * Signal that a goal is achieved.
   *
   * Propagates upward: a parent whose composition is `all` or `sequence` and
   * whose children are now all terminal becomes achieved itself, recursively.
   * That propagation is what lets a mind work on subgoals without losing track
   * of the objective they serve.
   */
  achieve(id: string, note = ''): Goal | undefined {
    const record = this.#goals.get(id as GoalId);
    if (record === undefined) return undefined;
    if (TERMINAL_STATUSES.includes(record.status)) return this.#view(record);

    this.#transition(record, 'achieved', note.length > 0 ? note : 'achieved');
    this.#propagateCompletion(record.parent);
    return this.#view(record);
  }

  /** Signal that a goal was attempted and could not be achieved. */
  fail(id: string, reason = ''): Goal | undefined {
    const record = this.#goals.get(id as GoalId);
    if (record === undefined) return undefined;
    if (TERMINAL_STATUSES.includes(record.status)) return this.#view(record);

    this.#transition(record, 'failed', reason.length > 0 ? reason : 'failed');
    this.#propagateFailure(record.parent);
    return this.#view(record);
  }

  /**
   * Give up on a goal, recording why.
   *
   * Explicit and reason-bearing because abandonment is a decision the mind
   * should be able to examine later. "I stopped wanting this" and "I decided it
   * was not worth the cost" are different facts about an agent, and the second
   * is the one that shows judgement.
   */
  abandon(id: string, reason: string): Goal | undefined {
    const record = this.#goals.get(id as GoalId);
    if (record === undefined) return undefined;
    if (TERMINAL_STATUSES.includes(record.status)) return this.#view(record);

    const expected = this.#expectedValue(record);
    this.#abandonments.push(
      Object.freeze({
        goalId: record.id,
        description: record.description,
        reason,
        expectedValue: round(expected),
        cost: round(record.cost),
        at: this.#clock.current,
      }),
    );
    if (this.#abandonments.length > 128) this.#abandonments.shift();

    this.#transition(record, 'abandoned', reason);
    this.#bus.publish(
      'goal:abandoned',
      { id: record.id, description: record.description, reason, expectedValue: round(expected) },
      this.#clock.current,
    );

    return this.#view(record);
  }

  /** Begin or resume pursuit. */
  activate(id: string): Goal | undefined {
    const record = this.#goals.get(id as GoalId);
    if (record === undefined) return undefined;
    if (TERMINAL_STATUSES.includes(record.status)) return this.#view(record);

    // Dependencies must be satisfied before pursuit can begin, and an unmet
    // one is a block rather than a failure — the goal is still wanted, it just
    // cannot be started yet.
    const unmet = record.requires.filter((required) => {
      const dependency = this.#goals.get(required);
      return dependency === undefined || dependency.status !== 'achieved';
    });
    if (unmet.length > 0) {
      this.#transition(record, 'blocked', `${unmet.length} unmet prerequisite(s)`);
      return this.#view(record);
    }

    if (record.notBefore !== undefined && this.#clock.current < record.notBefore) {
      this.#transition(record, 'blocked', `not before tick ${record.notBefore}`);
      return this.#view(record);
    }

    if (this.activeCount >= this.#maxActive && record.status !== 'active') {
      // Attention is finite; the goal waits its turn rather than being
      // half-pursued.
      this.#transition(record, 'pending', 'waiting for attention');
      return this.#view(record);
    }

    this.#transition(record, 'active', '');
    return this.#view(record);
  }

  /** Set aside deliberately, without abandoning. */
  suspend(id: string, reason = 'suspended'): Goal | undefined {
    const record = this.#goals.get(id as GoalId);
    if (record === undefined) return undefined;
    if (TERMINAL_STATUSES.includes(record.status)) return this.#view(record);
    this.#transition(record, 'suspended', reason);
    return this.#view(record);
  }

  /** Record a belief about whether the goal can be achieved. */
  setFeasibility(id: string, feasibility: Credence): Goal | undefined {
    const record = this.#goals.get(id as GoalId);
    if (record === undefined) return undefined;
    record.feasibility = clampCredence(feasibility);
    record.updatedAt = this.#clock.current;
    this.#reprioritise();
    return this.#view(record);
  }

  /** Charge effort against a goal. */
  chargeCost(id: string, cost: number): Goal | undefined {
    const record = this.#goals.get(id as GoalId);
    if (record === undefined) return undefined;
    if (!Number.isFinite(cost) || cost < 0) {
      throw new LogosError('GOAL_BAD_COST', `cost must be a non-negative finite number, got ${cost}`, { cost });
    }
    record.cost += cost;
    record.lastProgressAt = this.#clock.current;
    record.updatedAt = this.#clock.current;
    this.#reprioritise();
    return this.#view(record);
  }

  /** Note that progress happened, resetting the stall clock. */
  noteProgress(id: string): void {
    const record = this.#goals.get(id as GoalId);
    if (record === undefined) return;
    record.lastProgressAt = this.#clock.current;
    record.updatedAt = this.#clock.current;
  }

  forget(id: string): boolean {
    const record = this.#goals.get(id as GoalId);
    if (record === undefined) return false;

    // Children are orphaned to the root rather than deleted: forgetting a
    // parent is not a reason to forget what it was for.
    for (const childId of record.children) {
      const child = this.#goals.get(childId);
      if (child !== undefined) child.parent = undefined;
    }
    if (record.parent !== undefined) {
      const parent = this.#goals.get(record.parent);
      if (parent !== undefined) parent.children = parent.children.filter((c) => c !== record.id);
    }
    for (const other of this.#goals.values()) {
      other.requires = other.requires.filter((r) => r !== record.id);
      other.conflictsWith = other.conflictsWith.filter((c) => c !== record.id);
    }

    this.#goals.delete(record.id);
    return true;
  }

  clear(): void {
    this.#goals.clear();
    this.#abandonments = [];
    this.#seq = 0;
  }

  check(): readonly string[] {
    const problems: string[] = [];
    for (const record of this.#goals.values()) {
      if (record.parent !== undefined && !this.#goals.has(record.parent)) {
        problems.push(`goal "${record.description}" has a missing parent ${record.parent}`);
      }
      for (const childId of record.children) {
        const child = this.#goals.get(childId);
        if (child === undefined) problems.push(`goal "${record.description}" has a missing child ${childId}`);
        else if (child.parent !== record.id) {
          problems.push(`goal "${record.description}" lists ${childId} as a child but the child disagrees`);
        }
      }
      for (const required of record.requires) {
        if (!this.#goals.has(required)) {
          problems.push(`goal "${record.description}" requires missing goal ${required}`);
        }
      }
      if (record.cost < 0) problems.push(`goal "${record.description}" has negative cost`);
      if (record.depth > this.#maxDepth) problems.push(`goal "${record.description}" exceeds max depth`);
    }
    return problems;
  }

  // ── priority ──────────────────────────────────────────────────────────────

  /**
   * Recompute every goal's priority.
   *
   * Priority is not a stored preference; it is a judgement recomputed from the
   * current situation, and the terms encode an argument about what motivation
   * is:
   *
   *   utility      — what achieving it is worth.
   *   feasibility  — how likely achieving it is. A worthwhile goal that cannot
   *                  be reached should not monopolise attention.
   *   urgency      — how close the deadline is. This is the term that makes a
   *                  mind drop the important thing for the urgent one, and it
   *                  is deliberately capable of overriding a large utility
   *                  difference, because that is what deadlines actually do.
   *   sunk cost    — effort already spent, weighted BELOW the other terms and
   *                  configurable to zero. The sunk-cost fallacy is real, and
   *                  an architecture that ignored expenditure entirely would
   *                  thrash between goals; one that obeyed it fully would
   *                  persist at hopeless ones. The weight is the dial between.
   *   failure debt — a goal already failed or abandoned by an ancestor is
   *                  suppressed, because pursuing a subgoal of a dead objective
   *                  is wasted effort however attractive the subgoal looks.
   */
  #reprioritise(): void {
    const now = this.#clock.current;

    for (const record of this.#goals.values()) {
      const urgency = this.#urgencyOf(record, now);
      const sunk = this.#sunkCostWeight * (record.cost / (1 + record.cost));
      const deadAncestor = this.#hasDeadAncestor(record) ? 0 : 1;

      const raw =
        deadAncestor *
        (0.45 * record.utility + 0.25 * record.feasibility + 0.3 * urgency + sunk);

      record.lastComputedPriority = record.priority;
      record.priority = round(clampUnit(raw));
    }
  }

  /**
   * Urgency in [0,1].
   *
   * Zero with no deadline. Otherwise it rises as the deadline approaches, with
   * the last stretch climbing steeply — a mind that treated a deadline an hour
   * away and one a week away as proportionally different would never
   * prioritise correctly, because the cost of missing a deadline is not linear
   * in its distance.
   */
  #urgencyOf(record: GoalRecord, now: Tick): number {
    if (record.deadline === undefined || record.deadline <= 0) return 0;
    const remaining = record.deadline - now;
    if (remaining <= 0) return 1; // overdue counts as maximally urgent

    // Scale is relative to the goal's own age: a deadline ten ticks away means
    // something different to a goal that has existed for a hundred ticks than
    // to one declared a moment ago.
    const scale = Math.max(8, record.deadline - record.createdAt);
    const fraction = clampUnit(1 - remaining / scale);
    // Squared so urgency is low until the deadline is genuinely near.
    return clampUnit(fraction * fraction);
  }

  #hasDeadAncestor(record: GoalRecord): boolean {
    const seen = new Set<string>();
    let cursor = record.parent;
    while (cursor !== undefined) {
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      const ancestor = this.#goals.get(cursor);
      if (ancestor === undefined) return false;
      if (ancestor.status === 'failed' || ancestor.status === 'abandoned') return true;
      cursor = ancestor.parent;
    }
    return false;
  }

  /**
   * Expected value of continuing: what it is worth times the chance of getting
   * it, less what has already been spent.
   */
  #expectedValue(record: GoalRecord): number {
    return clampUnit(record.utility * record.feasibility - record.cost / (1 + record.cost) * this.#sunkCostWeight);
  }

  /**
   * Review every live goal and abandon the ones no longer worth pursuing.
   *
   * Run on a tick rather than continuously, because abandonment should be a
   * considered act. A mind that re-evaluated its commitments every instant
   * would never finish anything — the same reason real deliberation has a
   * cadence.
   */
  review(): readonly AbandonmentRecord[] {
    const abandoned: AbandonmentRecord[] = [];
    const now = this.#clock.current;

    for (const record of [...this.#goals.values()]) {
      if (TERMINAL_STATUSES.includes(record.status)) continue;

      // A goal whose parent has been abandoned is itself pointless.
      if (this.#hasDeadAncestor(record) && record.status !== 'abandoned') {
        const result = this.abandon(record.id, 'its parent objective was abandoned');
        if (result !== undefined) {
          const latest = this.#abandonments.at(-1);
          if (latest !== undefined) abandoned.push(latest);
        }
        continue;
      }

      const expected = this.#expectedValue(record);
      if (expected < this.#abandonBelow && record.status === 'active') {
        const result = this.abandon(
          record.id,
          `expected value ${expected.toFixed(3)} fell below the threshold ${this.#abandonBelow}`,
        );
        if (result !== undefined) {
          const latest = this.#abandonments.at(-1);
          if (latest !== undefined) abandoned.push(latest);
        }
        continue;
      }

      // Stall detection. A goal making no progress for many ticks is either
      // blocked in a way nobody reported or not worth continuing.
      if (record.status === 'active' && now - record.lastProgressAt > this.#stallTicks) {
        this.#transition(record, 'blocked', `no progress for ${now - record.lastProgressAt} ticks`);
      }
    }

    return Object.freeze(abandoned);
  }

  /**
   * The goals worth working on right now, best first.
   *
   * Only `active` goals are returned, and only as many as attention allows.
   * Everything else is a goal the mind holds without currently pursuing, which
   * is exactly the distinction a planner needs.
   */
  focus(limit = this.#maxActive): readonly Goal[] {
    return this.all()
      .filter((g) => g.status === 'active')
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
      .slice(0, Math.max(0, limit));
  }

  /**
   * Promote pending goals to active until attention is full.
   *
   * Called after any change that might free capacity. Without it a mind would
   * declare goals and never start them.
   */
  schedule(): readonly Goal[] {
    const promoted: Goal[] = [];
    if (this.activeCount >= this.#maxActive) return promoted;

    const candidates = this.all()
      .filter((g) => g.status === 'pending' || g.status === 'blocked' || g.status === 'suspended')
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

    for (const candidate of candidates) {
      if (this.activeCount >= this.#maxActive) break;
      const activated = this.activate(candidate.id);
      if (activated?.status === 'active') promoted.push(activated);
    }

    return Object.freeze(promoted);
  }

  /**
   * Goals that cannot both be pursued.
   *
   * Reported rather than resolved, because which one to drop is a judgement
   * that needs context the goal system does not have. What it can do is notice
   * the conflict, which is the part a machine is better at than a person.
   */
  conflicts(): readonly { readonly a: Goal; readonly b: Goal }[] {
    const found: { a: Goal; b: Goal }[] = [];
    const live = this.all().filter((g) => !TERMINAL_STATUSES.includes(g.status));

    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const a = live[i];
        const b = live[j];
        if (a === undefined || b === undefined) continue;
        if (a.conflictsWith.includes(b.id) || b.conflictsWith.includes(a.id)) found.push({ a, b });
      }
    }
    return Object.freeze(found);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #transition(record: GoalRecord, status: GoalStatus, outcome: string): void {
    const before = record.status;
    if (before === status && (status !== 'active' || outcome.length === 0)) return;

    record.status = status;
    record.outcome = outcome;
    record.updatedAt = this.#clock.current;
    if (status === 'active' || status === 'achieved') record.lastProgressAt = this.#clock.current;

    this.#reprioritise();

    this.#bus.publish(
      'goal:transition',
      {
        id: record.id,
        description: record.description,
        before,
        after: status,
        outcome,
        priority: record.priority,
      },
      this.#clock.current,
    );
  }

  /** Roll success upward through `all` and `sequence` parents. */
  #propagateCompletion(parentId: GoalId | undefined): void {
    if (parentId === undefined) return;
    const parent = this.#goals.get(parentId);
    if (parent === undefined || TERMINAL_STATUSES.includes(parent.status)) return;

    const children = parent.children
      .map((id) => this.#goals.get(id))
      .filter((c): c is GoalRecord => c !== undefined);
    if (children.length === 0) return;

    const satisfied =
      parent.composition === 'any'
        ? children.some((c) => c.status === 'achieved')
        : children.every((c) => c.status === 'achieved');

    if (satisfied) {
      this.#transition(parent, 'achieved', 'all subgoals satisfied');
      this.#propagateCompletion(parent.parent);
      return;
    }

    // A conjunction with any irrecoverably failed part cannot succeed.
    if (parent.composition !== 'any' && children.some((c) => c.status === 'failed' || c.status === 'abandoned')) {
      this.#transition(parent, 'failed', 'a required subgoal cannot be achieved');
      this.#propagateFailure(parent.parent);
    }
  }

  /** Roll failure upward through `all` and `sequence` parents. */
  #propagateFailure(parentId: GoalId | undefined): void {
    if (parentId === undefined) return;
    const parent = this.#goals.get(parentId);
    if (parent === undefined || TERMINAL_STATUSES.includes(parent.status)) return;
    if (parent.composition === 'any') return; // other routes may still work

    this.#transition(parent, 'failed', 'a required subgoal failed');
    this.#propagateFailure(parent.parent);
  }

  #view(record: GoalRecord): Goal {
    return Object.freeze({
      id: record.id,
      description: record.description,
      status: record.status,
      composition: record.composition,
      parent: record.parent,
      children: Object.freeze([...record.children]),
      utility: record.utility,
      cost: round(record.cost),
      feasibility: record.feasibility,
      priority: record.priority,
      deadline: record.deadline,
      notBefore: record.notBefore,
      requires: Object.freeze([...record.requires]),
      conflictsWith: Object.freeze([...record.conflictsWith]),
      depth: record.depth,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      outcome: record.outcome,
      data: Object.freeze({ ...record.data }),
    });
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

const normalise = (description: string): string => {
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new LogosError('GOAL_EMPTY_DESCRIPTION', 'a goal needs a non-empty description', { description });
  }
  return description.trim();
};

const clampUnit = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
