/**
 * LOGOS :: Planning :: Hierarchical task networks
 * ---------------------------------------------------------------------------
 * Planning as the decomposition of a task into tasks that can actually be done.
 *
 * WHY HIERARCHICAL RATHER THAN CLASSICAL. A classical planner searches over
 * primitive actions to reach a goal state. That requires enumerating every
 * action sequence, and its cost explodes with the number of actions. It also
 * throws away the one thing an experienced agent has: KNOWLEDGE OF HOW THINGS
 * ARE DONE. HTN planning inverts the problem — the agent supplies methods that
 * say "to achieve X, do A, B and C", and the planner's job is to choose among
 * methods and verify that their preconditions hold. Search happens over
 * decompositions, not over action sequences, which is both far smaller and far
 * closer to how anyone actually plans anything.
 *
 * The central object is a METHOD: a recipe for achieving a task, with
 * preconditions that must hold and a body that is either further subtasks or
 * primitive actions. The central operation is recursive decomposition with
 * BACKTRACKING: if a method's precondition fails, or its body cannot be
 * decomposed, the planner tries the next method rather than giving up.
 *
 * Three properties are worth stating because they are choices:
 *
 *   PLANS ARE BOUNDED, NOT OPTIMAL. The planner returns the first decomposition
 *   that works within its budget. Optimality would require exhaustive search,
 *   which is exactly what hierarchy exists to avoid. What it does guarantee is
 *   that the returned plan is well-formed and its preconditions held at
 *   planning time.
 *
 *   UNCERTAINTY IS CARRIED, NOT RESOLVED. Every plan node has a confidence,
 *   computed from its children, and a plan can be returned with low confidence
 *   rather than being rejected. A mind needs to be able to act on a plan it is
 *   unsure about, and to know that it is unsure.
 *
 *   FAILURE IS INFORMATIVE. When no method works, the planner reports WHY —
 *   which preconditions failed, how deep it got, whether it hit the depth limit
 *   or ran out of methods. "I cannot do this" without a reason is useless to a
 *   mind that might otherwise try something else.
 */

import type { Clock } from '../kernel/clock.ts';
import type { EventBus } from '../kernel/bus.ts';
import type { TaskId, Tick } from '../kernel/types.ts';
import { LogosError, clampCredence } from '../kernel/types.ts';

/**
 * The world a plan is checked against.
 *
 * A plain key-value state, deliberately. A richer representation would make the
 * planner's behaviour depend on the representation's subtleties, and the point
 * of this layer is that planning is transparent: you can read a plan and see
 * exactly what it assumed.
 *
 * Read-only from the planner's perspective. Effects produce a NEW state rather
 * than mutating one, so a rejected branch cannot leave residue behind for the
 * next method to trip over — which is exactly the bug that backtracking
 * without immutability produces.
 */
export interface PlanState {
  readonly [key: string]: unknown;
}

/** A state being constructed. Only `applyEffects` should ever hold one. */
type MutablePlanState = Record<string, unknown>;

/** A condition on the world. */
export interface Condition {
  readonly key: string;
  /** Required value. Omitted means "must be present and truthy". */
  readonly equals?: unknown;
  /** Required to be absent or falsy. */
  readonly absent?: boolean;
  /** Comparison against a numeric value. */
  readonly above?: number;
  readonly below?: number;
}

/** What a primitive action does to the world. */
export interface ActionEffect {
  readonly key: string;
  readonly set?: unknown;
  /** Add to a numeric value. Ignored when `set` is present. */
  readonly increment?: number;
  /** Remove the key entirely. */
  readonly remove?: boolean;
}

/**
 * A primitive action: something that can actually be done.
 *
 * `execute` is optional. A plan can be built and inspected without any of it
 * being performable, which is what lets a caller reason about a course of
 * action before committing to it — and what lets the planner be tested without
 * a world to act on.
 */
export interface PrimitiveAction {
  readonly name: string;
  readonly description?: string;
  /** Conditions that must hold before the action can be taken. */
  readonly preconditions?: readonly Condition[];
  /** What the action changes. */
  readonly effects?: readonly ActionEffect[];
  /** How much effort it costs, in abstract units. */
  readonly cost?: number;
  /** How likely it is to succeed, in [0,1]. */
  readonly reliability?: number;
  /** Perform it. Returning false means it failed despite its preconditions. */
  readonly execute?: (state: PlanState) => boolean | Promise<boolean>;
}

/**
 * A method: a way of achieving a compound task.
 *
 * Several methods may exist for one task, and the planner tries them in
 * descending priority. That is where an agent's judgement lives: the same
 * objective has a preferred route and several fallbacks, and which one is
 * appropriate depends on conditions the method itself declares.
 */
export interface Method {
  readonly name: string;
  /** The task this method achieves. */
  readonly task: string;
  /** Conditions under which this method is applicable. */
  readonly preconditions?: readonly Condition[];
  /** Higher is tried first. */
  readonly priority?: number;
  /** How likely this route is to work, in [0,1]. */
  readonly confidence?: number;
  /** Subtasks to achieve, in order. */
  readonly subtasks?: readonly string[];
  /** Primitive actions to perform, in order. */
  readonly actions?: readonly string[];
  /** Exactly one of `subtasks` or `actions` must be supplied. */
  readonly description?: string;
}

/** A node in a produced plan. */
export interface PlanNode {
  readonly kind: 'task' | 'action';
  readonly name: string;
  /** The method chosen to achieve a task node. Absent on action nodes. */
  readonly method?: string;
  readonly children: readonly PlanNode[];
  /** Combined likelihood of this node succeeding, in [0,1]. */
  readonly confidence: number;
  /** Total effort, summed over the primitive actions beneath. */
  readonly cost: number;
  readonly depth: number;
}

/** A produced plan. */
export interface Plan {
  readonly id: string;
  readonly goal: string;
  readonly root: PlanNode;
  /** Flattened primitive actions, in execution order. */
  readonly steps: readonly PlanStep[];
  readonly confidence: number;
  readonly cost: number;
  /**
   * Depth of the deepest node in the tree.
   *
   * NOT the root node's own `depth`, which is always 0 because the root is at
   * level zero. Reporting that as the plan's depth would make every plan look
   * flat.
   */
  readonly depth: number;
  readonly createdAt: Tick;
  /** Methods considered and rejected, with the reason. */
  readonly rejected: readonly Rejection[];
}

export interface PlanStep {
  readonly index: number;
  readonly action: PrimitiveAction;
  /** The task this action ultimately serves. */
  readonly forTask: string;
}

export interface Rejection {
  readonly task: string;
  readonly method: string;
  readonly reason: string;
}

/** Why planning failed, when it did. */
export interface PlanFailure {
  readonly goal: string;
  readonly reason:
    | 'no-method'
    | 'preconditions-unmet'
    | 'depth-exceeded'
    | 'budget-exceeded'
    | 'missing-action'
    | 'malformed-method';
  readonly detail: string;
  /** How many decompositions were attempted before giving up. */
  readonly attempts: number;
  /** The rejections, so the failure can be explained rather than just reported. */
  readonly rejected: readonly Rejection[];
}

export type PlanOutcome =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly failure: PlanFailure };

export interface PlannerOptions {
  readonly clock: Clock;
  readonly bus: EventBus;
  /** Maximum decomposition depth. */
  readonly maxDepth?: number;
  /** Maximum decomposition nodes explored before giving up. */
  readonly maxNodes?: number;
  /**
   * How a method's confidence combines with its children's.
   *
   *   product — every step must work; the weakest link dominates
   *   minimum — the least certain step determines the plan
   *   mean    — steps are partly independent
   */
  readonly confidenceMode?: 'product' | 'minimum' | 'mean';
}

export class Planner {
  readonly #clock: Clock;
  readonly #bus: EventBus;
  readonly #maxDepth: number;
  readonly #maxNodes: number;
  readonly #confidenceMode: 'product' | 'minimum' | 'mean';

  readonly #methods = new Map<string, Method[]>();
  readonly #actions = new Map<string, PrimitiveAction>();

  /** Decomposition nodes explored during the current planning call. */
  #nodesExplored = 0;
  /** Rejections accumulated during the current planning call. */
  #rejections: Rejection[] = [];

  #plans = 0;

  constructor(options: PlannerOptions) {
    this.#clock = options.clock;
    this.#bus = options.bus;
    this.#maxDepth = Math.max(1, Math.floor(options.maxDepth ?? 8));
    this.#maxNodes = Math.max(8, Math.floor(options.maxNodes ?? 2_000));
    this.#confidenceMode = options.confidenceMode ?? 'product';
  }

  get methodCount(): number {
    return [...this.#methods.values()].reduce((a, m) => a + m.length, 0);
  }

  get actionCount(): number {
    return this.#actions.size;
  }

  get plansBuilt(): number {
    return this.#plans;
  }

  // ── knowledge ─────────────────────────────────────────────────────────────

  /** Register a primitive action. Re-registering replaces it. */
  defineAction(action: PrimitiveAction): this {
    if (typeof action?.name !== 'string' || action.name.trim().length === 0) {
      throw new LogosError('PLANNER_BAD_ACTION', 'an action needs a non-empty name', { action });
    }
    this.#actions.set(action.name, Object.freeze({ ...action }));
    return this;
  }

  /** Register a method. Several may exist for one task. */
  defineMethod(method: Method): this {
    if (typeof method?.name !== 'string' || method.name.trim().length === 0) {
      throw new LogosError('PLANNER_BAD_METHOD', 'a method needs a non-empty name', { method });
    }
    if (typeof method.task !== 'string' || method.task.trim().length === 0) {
      throw new LogosError('PLANNER_BAD_METHOD', 'a method needs a task it achieves', { method });
    }
    const hasSubtasks = Array.isArray(method.subtasks) && method.subtasks.length > 0;
    const hasActions = Array.isArray(method.actions) && method.actions.length > 0;
    if (hasSubtasks === hasActions) {
      throw new LogosError(
        'PLANNER_AMBIGUOUS_METHOD',
        `method "${method.name}" must supply exactly one of subtasks or actions`,
        { name: method.name, subtasks: method.subtasks?.length ?? 0, actions: method.actions?.length ?? 0 },
      );
    }

    const existing = this.#methods.get(method.task) ?? [];
    existing.push(Object.freeze({ ...method, priority: method.priority ?? 0.5 }));
    // Sorted once here rather than on every planning call.
    existing.sort((a, b) => (b.priority ?? 0.5) - (a.priority ?? 0.5) || a.name.localeCompare(b.name));
    this.#methods.set(method.task, existing);
    return this;
  }

  /** Register several methods at once. */
  defineMethods(methods: readonly Method[]): this {
    for (const method of methods) this.defineMethod(method);
    return this;
  }

  /** Methods registered for a task, in the order they will be tried. */
  methodsFor(task: string): readonly Method[] {
    return [...(this.#methods.get(task) ?? [])];
  }

  action(name: string): PrimitiveAction | undefined {
    return this.#actions.get(name);
  }

  /** Every task that has at least one method. */
  knownTasks(): readonly string[] {
    return [...this.#methods.keys()];
  }

  clear(): void {
    this.#methods.clear();
    this.#actions.clear();
    this.#plans = 0;
  }

  // ── planning ──────────────────────────────────────────────────────────────

  /**
   * Decompose a task into primitive actions against a world state.
   *
   * Returns a plan or a reason. Never throws for an ordinary failure to plan —
   * "this cannot be done" is a normal, informative outcome, and a planner that
   * raised an exception for it would force every caller to treat the expected
   * case as an error.
   */
  plan(goal: string, state: PlanState): PlanOutcome {
    if (typeof goal !== 'string' || goal.trim().length === 0) {
      throw new LogosError('PLANNER_EMPTY_GOAL', 'a planning goal needs a non-empty task name', { goal });
    }

    this.#nodesExplored = 0;
    this.#rejections = [];

    const root = this.#decompose(goal, state, 0, []);

    if (root === undefined) {
      const failure: PlanFailure = Object.freeze({
        goal,
        reason: this.#failureReason(goal),
        detail: this.#failureDetail(goal),
        attempts: this.#nodesExplored,
        rejected: Object.freeze([...this.#rejections]),
      });

      this.#bus.publish(
        'planning:failed',
        { goal, reason: failure.reason, detail: failure.detail, attempts: failure.attempts },
        this.#clock.current,
      );

      return { ok: false, failure };
    }

    const steps = flattenSteps(root);
    this.#plans += 1;

    const plan: Plan = Object.freeze({
      id: `plan${this.#plans}`,
      goal,
      root,
      steps: Object.freeze(steps),
      confidence: root.confidence,
      cost: root.cost,
      depth: treeDepth(root),
      createdAt: this.#clock.current,
      rejected: Object.freeze([...this.#rejections]),
    });

    this.#bus.publish(
      'planning:succeeded',
      {
        planId: plan.id,
        goal,
        steps: plan.steps.length,
        confidence: plan.confidence,
        cost: plan.cost,
        depth: plan.depth,
      },
      this.#clock.current,
    );

    return { ok: true, plan };
  }

  /**
   * Recursive decomposition with backtracking.
   *
   * `path` carries the chain of tasks currently being decomposed. It is what
   * turns unbounded recursion into a detectably hopeless one: a method that
   * leads back to a task already on the path is not a plan, it is a loop, and
   * recognising it early is much cheaper than discovering it at the depth
   * limit.
   */
  #decompose(task: string, state: PlanState, depth: number, path: readonly string[]): PlanNode | undefined {
    this.#nodesExplored += 1;

    if (depth > this.#maxDepth) {
      this.#rejections.push({ task, method: '-', reason: `depth limit ${this.#maxDepth} reached` });
      return undefined;
    }
    if (this.#nodesExplored > this.#maxNodes) {
      this.#rejections.push({ task, method: '-', reason: `node budget ${this.#maxNodes} exhausted` });
      return undefined;
    }
    if (path.includes(task)) {
      // A cycle in the method graph. Reported as a rejection of the current
      // branch rather than an error, because the methods are individually
      // valid — it is this particular route that is circular.
      this.#rejections.push({ task, method: '-', reason: `recursive decomposition: ${[...path, task].join(' -> ')}` });
      return undefined;
    }

    const candidates = this.#methods.get(task) ?? [];
    if (candidates.length === 0) {
      this.#rejections.push({ task, method: '-', reason: 'no method achieves this task' });
      return undefined;
    }

    for (const method of candidates) {
      const unmet = unmetConditions(method.preconditions ?? [], state);
      if (unmet.length > 0) {
        this.#rejections.push({
          task,
          method: method.name,
          reason: `preconditions unmet: ${unmet.join(', ')}`,
        });
        continue;
      }

      const built = this.#applyMethod(method, state, depth, [...path, task]);
      if (built !== undefined) return built;

      // `#applyMethod` pushed the specific reason; nothing more to add here.
    }

    return undefined;
  }

  /**
   * Apply one method, returning its node or undefined if its body failed.
   *
   * The state passed down is a COPY with the method's own actions applied as
   * they are sequenced. That is an approximation — later subtasks see the
   * effects of earlier ones, but sibling branches do not see each other's,
   * because a full state-space search is exactly what hierarchy exists to
   * avoid. It is the right approximation for plans whose preconditions are
   * mostly about the initial situation rather than about concurrent branches.
   */
  #applyMethod(
    method: Method,
    state: PlanState,
    depth: number,
    path: readonly string[],
  ): PlanNode | undefined {
    const baseConfidence = clampCredence(method.confidence ?? 0.8);

    // ── primitive method ──
    if (method.actions !== undefined && method.actions.length > 0) {
      const children: PlanNode[] = [];
      let working: PlanState = { ...state };
      let cost = 0;

      for (const actionName of method.actions) {
        const action = this.#actions.get(actionName);
        if (action === undefined) {
          this.#rejections.push({
            task: method.task,
            method: method.name,
            reason: `action "${actionName}" is not defined`,
          });
          return undefined;
        }

        const unmet = unmetConditions(action.preconditions ?? [], working);
        if (unmet.length > 0) {
          this.#rejections.push({
            task: method.task,
            method: method.name,
            reason: `action "${actionName}" preconditions unmet: ${unmet.join(', ')}`,
          });
          return undefined;
        }

        const reliability = clampCredence(action.reliability ?? 1);
        children.push(
          Object.freeze({
            kind: 'action' as const,
            name: action.name,
            children: Object.freeze([]),
            confidence: reliability,
            cost: action.cost ?? 1,
            depth: depth + 1,
          }),
        );

        cost += action.cost ?? 1;
        working = applyEffects(working, action.effects ?? []);
      }

      return Object.freeze({
        kind: 'task' as const,
        name: method.task,
        method: method.name,
        children: Object.freeze(children),
        confidence: combine(baseConfidence, children.map((c) => c.confidence), this.#confidenceMode),
        cost,
        depth,
      });
    }

    // ── compound method ──
    const subtasks = method.subtasks ?? [];
    const children: PlanNode[] = [];
    let working: PlanState = { ...state };

    for (const subtask of subtasks) {
      const child = this.#decompose(subtask, working, depth + 1, path);
      if (child === undefined) {
        this.#rejections.push({
          task: method.task,
          method: method.name,
          reason: `subtask "${subtask}" could not be decomposed`,
        });
        return undefined;
      }
      children.push(child);
      // The best a compound step can be assumed to achieve is its own goal;
      // rather than guess which keys a whole subtask sets, later subtasks see
      // only the effects of primitive actions at this level, which is the
      // conservative choice.
    }

    return Object.freeze({
      kind: 'task' as const,
      name: method.task,
      method: method.name,
      children: Object.freeze(children),
      confidence: combine(baseConfidence, children.map((c) => c.confidence), this.#confidenceMode),
      cost: children.reduce((a, c) => a + c.cost, 0),
      depth,
    });
  }

  #failureReason(goal: string): PlanFailure['reason'] {
    const reasons = this.#rejections.map((r) => r.reason);
    if (reasons.some((r) => r.startsWith('depth limit'))) return 'depth-exceeded';
    if (reasons.some((r) => r.startsWith('node budget'))) return 'budget-exceeded';
    if (this.#methods.has(goal) === false) return 'no-method';
    if (reasons.some((r) => r.includes('is not defined'))) return 'missing-action';
    if (reasons.every((r) => r.startsWith('preconditions unmet') || r.includes('preconditions unmet'))) {
      return 'preconditions-unmet';
    }
    return 'no-method';
  }

  #failureDetail(goal: string): string {
    const distinct = [...new Set(this.#rejections.map((r) => r.reason))];
    if (distinct.length === 0) return `no methods are registered for "${goal}"`;
    const shown = distinct.slice(0, 4).join('; ');
    const more = distinct.length > 4 ? ` (and ${distinct.length - 4} more)` : '';
    return `${distinct.length} route(s) rejected: ${shown}${more}`;
  }
}

// ── plan inspection ─────────────────────────────────────────────────────────

/** Flatten a plan tree into its primitive steps, in execution order. */
export function flattenSteps(root: PlanNode): PlanStep[] {
  const steps: PlanStep[] = [];

  const walk = (node: PlanNode, forTask: string): void => {
    const task = node.name.length > 0 ? node.name : forTask;
    for (const child of node.children) {
      if (child.kind === 'action') {
        steps.push(
          Object.freeze({
            index: steps.length,
            action: { name: child.name, cost: child.cost, reliability: child.confidence },
            forTask: task,
          }),
        );
      } else {
        walk(child, task);
      }
    }
  };

  walk(root, root.name);
  return steps;
}

/** Depth of the deepest node beneath (and including) this one. */
export function treeDepth(node: PlanNode): number {
  if (node.children.length === 0) return 0;
  let deepest = 0;
  for (const child of node.children) {
    const d = treeDepth(child);
    if (d > deepest) deepest = d;
  }
  return deepest + 1;
}

/** Render a plan as an indented tree, for logs and traces. */
export function describePlan(plan: Plan, maxDepth = 6): string {
  const lines: string[] = [`plan ${plan.id} for "${plan.goal}" (confidence ${plan.confidence.toFixed(2)}, cost ${plan.cost})`];

  const walk = (node: PlanNode, indent: number): void => {
    if (indent > maxDepth) {
      lines.push(`${'  '.repeat(indent)}...`);
      return;
    }
    const marker = node.kind === 'action' ? '·' : '▸';
    const via = node.method === undefined ? '' : ` via ${node.method}`;
    lines.push(
      `${'  '.repeat(indent)}${marker} ${node.name}${via} [c=${node.confidence.toFixed(2)} cost=${node.cost}]`,
    );
    for (const child of node.children) walk(child, indent + 1);
  };

  walk(plan.root, 0);
  return lines.join('\n');
}

// ── state evaluation ────────────────────────────────────────────────────────

/** Which of these conditions the state fails to satisfy. */
export function unmetConditions(conditions: readonly Condition[], state: PlanState): string[] {
  const unmet: string[] = [];
  for (const condition of conditions) {
    if (!conditionHolds(condition, state)) unmet.push(describeCondition(condition));
  }
  return unmet;
}

export function conditionHolds(condition: Condition, state: PlanState): boolean {
  const present = Object.prototype.hasOwnProperty.call(state, condition.key);
  const value = state[condition.key];

  if (condition.absent === true) {
    // "Absent" covers both missing and explicitly falsy, so a caller does not
    // have to know which convention the world uses.
    return !present || value === null || value === undefined || value === false;
  }

  if (condition.equals !== undefined) return present && deepEqual(value, condition.equals);
  if (condition.above !== undefined) {
    return typeof value === 'number' && value > condition.above;
  }
  if (condition.below !== undefined) {
    return typeof value === 'number' && value < condition.below;
  }
  // No operator: treat as a truthiness test.
  return present && Boolean(value);
}

function describeCondition(condition: Condition): string {
  if (condition.absent === true) return `${condition.key} absent`;
  if (condition.equals !== undefined) return `${condition.key} == ${JSON.stringify(condition.equals)}`;
  if (condition.above !== undefined) return `${condition.key} > ${condition.above}`;
  if (condition.below !== undefined) return `${condition.key} < ${condition.below}`;
  return `${condition.key} truthy`;
}

/** Apply a list of effects, returning a new state. The input is not modified. */
export function applyEffects(state: PlanState, effects: readonly ActionEffect[]): PlanState {
  const next: MutablePlanState = { ...state };
  for (const effect of effects) {
    if (effect.remove === true) {
      delete next[effect.key];
      continue;
    }
    if (effect.set !== undefined) {
      next[effect.key] = effect.set;
      continue;
    }
    if (effect.increment !== undefined) {
      const current = next[effect.key];
      next[effect.key] = (typeof current === 'number' ? current : 0) + effect.increment;
    }
  }
  return next;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Combine a method's own confidence with its children's.
 *
 * The mode is a claim about how steps relate, and the default is the strict
 * one: a plan is a chain, so its reliability is the product of its links, and
 * a fifty-step plan of 0.99-reliable actions is only 60% likely to work end to
 * end. Reporting that honestly is more useful than reporting the average,
 * which would hide the way length erodes reliability.
 */
function combine(
  own: number,
  children: readonly number[],
  mode: 'product' | 'minimum' | 'mean',
): number {
  if (children.length === 0) return own;
  let combined: number;
  switch (mode) {
    case 'minimum':
      combined = Math.min(...children);
      break;
    case 'mean':
      combined = children.reduce((a, b) => a + b, 0) / children.length;
      break;
    case 'product':
    default:
      combined = children.reduce((a, b) => a * b, 1);
      break;
  }
  return clampCredence(own * combined);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** Exported for callers that need a TaskId-typed value from a plan step. */
export type PlanStepId = TaskId;
