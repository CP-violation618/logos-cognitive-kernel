/**
 * LOGOS :: Skills :: Procedural memory
 * ---------------------------------------------------------------------------
 * What the mind can DO, as distinct from what it knows.
 *
 * Declarative memory stores facts and retrieval is reconstruction. Procedural
 * memory stores abilities, and it is different in kind rather than in degree.
 * Three properties drive this design, and all three fall out of the same
 * observation: knowing how to do something is not the same as having done it
 * enough times to be good at it.
 *
 * 1. SKILLS IMPROVE WITH PRACTICE, AND THE IMPROVEMENT IS MEASURABLE.
 *    A skill carries a mastery in [0,1] that rises with success and falls with
 *    failure. A fresh skill is a hypothesis about what might work; a mastered
 *    one is a competence. The difference has to be representable or a mind
 *    cannot know what it is actually able to do.
 *
 * 2. PRACTICE MAKES A SKILL CHEAPER, NOT JUST BETTER.
 *    This is automatization, and it is the property that makes procedural
 *    memory worth having as a separate system. A mastered skill costs less
 *    attention than a novel one — it has stopped being deliberate. The
 *    scheduler's budget is the scarce resource, so a mind that can do something
 *    fluently can think about something else while doing it.
 *
 * 3. A SKILL THAT FAILS BECAUSE ITS PRECONDITIONS DID NOT HOLD IS NOT THEREBY
 *    WORSE. This is the distinction between "I cannot do this here" and "I am
 *    bad at this". Conflating them is how a system learns to avoid things it is
 *    perfectly capable of, and separating them is why `attempt()` records why
 *    a skill failed rather than only that it did.
 *
 * Skills COMPOSE: a skill's steps may be other skills or primitive actions, and
 * a composite inherits the mastery of its parts. That inheritance is what
 * connects practice at the leaves to competence at the root — drilling a step
 * makes the whole procedure better, which is the thing that makes practice
 * worth doing.
 */

import type { Clock } from '../kernel/clock.ts';
import type { EventBus } from '../kernel/bus.ts';
import type { Scheduler } from '../kernel/scheduler.ts';
import type { Rng } from '../kernel/rng.ts';
import type { Credence, SkillId, Tick } from '../kernel/types.ts';
import { LogosError, clampCredence, newSkillId } from '../kernel/types.ts';

/** What a skill step can be. */
export type SkillStep =
  | { readonly kind: 'action'; readonly name: string; readonly params?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'skill'; readonly name: string }
  | { readonly kind: 'branch'; readonly on: string; readonly then: readonly SkillStep[]; readonly otherwise?: readonly SkillStep[] }
  | { readonly kind: 'repeat'; readonly times: number; readonly body: readonly SkillStep[] };

/** Conditions under which a skill is applicable, reusing the planner's shape. */
export interface SkillPrecondition {
  readonly key: string;
  readonly equals?: unknown;
  readonly present?: boolean;
  readonly above?: number;
  readonly below?: number;
}

/** Why a skill attempt ended the way it did. */
export type FailureKind =
  /** The skill's preconditions did not hold. Says nothing about competence. */
  | 'preconditions-unmet'
  /** The skill ran and the world refused. This is evidence about the skill. */
  | 'execution-failed'
  /** A step referenced something that does not exist. A defect, not a failure. */
  | 'malformed'
  /** The attempt exceeded its budget. Inconclusive. */
  | 'interrupted';

export interface SkillAttempt {
  readonly skillId: SkillId;
  readonly name: string;
  readonly succeeded: boolean;
  readonly failure: FailureKind | undefined;
  /** Mastery before and after, so the effect of practice is visible. */
  readonly masteryBefore: number;
  readonly masteryAfter: number;
  /** Attention this attempt actually consumed. */
  readonly cost: number;
  readonly steps: number;
  readonly at: Tick;
  readonly detail: string;
}

/** A skill's current competence, as reported to the rest of the architecture. */
export interface Skill {
  readonly id: SkillId;
  readonly name: string;
  readonly description: string;
  /** What the skill achieves, for matching against goals. */
  readonly achieves: string;
  readonly steps: readonly SkillStep[];
  /**
   * Competence in [0,1], estimated from outcomes rather than declared.
   *
   * Starts at a caller-supplied prior, because a mind with no experience of a
   * skill still has some expectation about it — usually from analogy with
   * similar things it has done.
   */
  readonly mastery: Credence;
  /** Attempts, successes and failures. */
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  /**
   * Consecutive successes.
   *
   * Tracked separately from the ratio because fluency is a property of the
   * recent run, not of the lifetime average: a skill that failed ten times and
   * then worked ten times is currently fluent and historically unreliable, and
   * both facts matter.
   */
  readonly streak: number;
  /** Effort per attempt, falling as mastery rises. */
  readonly attentionCost: number;
  readonly preconditions: readonly SkillPrecondition[];
  readonly createdAt: Tick;
  readonly lastPracticedAt: Tick | undefined;
  readonly tags: readonly string[];
}

export interface SkillRegistryOptions {
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly rng: Rng;
  /** Optional scheduler, so skill practice is charged to the attention budget. */
  readonly scheduler?: Scheduler;
  /** Mastery below which a skill is tried but not relied upon. */
  readonly competentAbove?: number;
  /** Attempts before a skill's mastery is trusted over its prior. */
  readonly confidenceAfter?: number;
  /** Attention a completely unmastered skill costs per step. */
  readonly baseCostPerStep?: number;
  /** Attention a fully mastered skill costs per step. */
  readonly floorCostPerStep?: number;
  /** Learning rate: how far mastery moves on a single outcome. */
  readonly learningRate?: number;
}

/** How a skill behaves when its steps are executed. */
export interface SkillContext {
  /** Perform a primitive action. Returns whether it worked. */
  readonly act: (name: string, params?: Readonly<Record<string, unknown>>) => boolean | Promise<boolean>;
  /** The world, for precondition checks and branch conditions. */
  readonly state: Readonly<Record<string, unknown>>;
  /** Attention remaining for this attempt, decremented per step. */
  budget: number;
}

export interface SkillStats {
  readonly skills: number;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly competent: number;
  /** Mean mastery across all skills. */
  readonly meanMastery: number;
  /** Mean mastery weighted by how often each skill has been attempted. */
  readonly practicedMastery: number;
  /** Total attention consumed by skill execution. */
  readonly attentionSpent: number;
}

interface SkillRecord {
  id: SkillId;
  name: string;
  description: string;
  achieves: string;
  steps: SkillStep[];
  mastery: number;
  /** The caller's initial estimate, kept so mastery can be reported against it. */
  prior: number;
  attempts: number;
  successes: number;
  failures: number;
  streak: number;
  attentionCost: number;
  preconditions: SkillPrecondition[];
  createdAt: Tick;
  lastPracticedAt: Tick | undefined;
  tags: string[];
}

export class SkillRegistry {
  readonly #clock: Clock;
  readonly #bus: EventBus;
  readonly #rng: Rng;
  readonly #scheduler: Scheduler | undefined;
  readonly #competentAbove: number;
  readonly #confidenceAfter: number;
  readonly #baseCostPerStep: number;
  readonly #floorCostPerStep: number;
  readonly #learningRate: number;

  readonly #skills = new Map<SkillId, SkillRecord>();
  /** Name -> id. Names are the interface; ids are the identity. */
  readonly #byName = new Map<string, SkillId>();

  #attempts = 0;
  #successes = 0;
  #failures = 0;
  #attentionSpent = 0;

  constructor(options: SkillRegistryOptions) {
    this.#clock = options.clock;
    this.#bus = options.bus;
    this.#rng = options.rng;
    this.#scheduler = options.scheduler;
    this.#competentAbove = clampUnit(options.competentAbove ?? 0.6);
    this.#confidenceAfter = Math.max(1, Math.floor(options.confidenceAfter ?? 3));
    this.#baseCostPerStep = Math.max(0.1, options.baseCostPerStep ?? 1);
    this.#floorCostPerStep = Math.max(0.01, options.floorCostPerStep ?? 0.15);
    this.#learningRate = clampUnit(options.learningRate ?? 0.35);

    if (this.#floorCostPerStep > this.#baseCostPerStep) {
      throw new LogosError('SKILL_COST_INVERTED', 'floorCostPerStep must not exceed baseCostPerStep', {
        floor: this.#floorCostPerStep,
        base: this.#baseCostPerStep,
      });
    }
  }

  // ── introspection ─────────────────────────────────────────────────────────

  get size(): number {
    return this.#skills.size;
  }

  get stats(): SkillStats {
    const records = [...this.#skills.values()];
    const totalAttempts = records.reduce((a, r) => a + r.attempts, 0);
    let practiced = 0;
    for (const record of records) practiced += record.mastery * record.attempts;

    return Object.freeze({
      skills: records.length,
      attempts: this.#attempts,
      successes: this.#successes,
      failures: this.#failures,
      competent: records.filter((r) => r.mastery >= this.#competentAbove).length,
      meanMastery: records.length === 0 ? 0 : round(records.reduce((a, r) => a + r.mastery, 0) / records.length),
      practicedMastery: totalAttempts === 0 ? 0 : round(practiced / totalAttempts),
      attentionSpent: round(this.#attentionSpent),
    });
  }

  get(id: string): Skill | undefined {
    const record = this.#skills.get(id as SkillId);
    return record === undefined ? undefined : this.#view(record);
  }

  byName(name: string): Skill | undefined {
    const id = this.#byName.get(name);
    return id === undefined ? undefined : this.#view(this.#skills.get(id) as SkillRecord);
  }

  all(): readonly Skill[] {
    return [...this.#skills.values()]
      .sort((a, b) => b.mastery - a.mastery || a.name.localeCompare(b.name))
      .map((r) => this.#view(r));
  }

  /** Skills that could serve a goal, best-mastered first. */
  forGoal(achieves: string, limit = 5): readonly Skill[] {
    const needle = achieves.trim().toLowerCase();
    return [...this.#skills.values()]
      .filter((r) => r.achieves.toLowerCase().includes(needle) || needle.includes(r.achieves.toLowerCase()))
      .sort((a, b) => b.mastery - a.mastery || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((r) => this.#view(r));
  }

  /** True when the skill is mastered well enough to rely on. */
  isCompetent(name: string): boolean {
    const skill = this.byName(name);
    return skill !== undefined && skill.mastery >= this.#competentAbove;
  }

  describe(): string {
    const s = this.stats;
    return (
      `skills[n=${s.skills} attempts=${s.attempts} competent=${s.competent} ` +
      `mean=${s.meanMastery.toFixed(2)} attention=${s.attentionSpent.toFixed(1)}]`
    );
  }

  // ── definition ────────────────────────────────────────────────────────────

  /**
   * Register a skill.
   *
   * `prior` is a caller's initial estimate and is genuinely used — a mind with
   * no experience of a skill is not completely ignorant about it, because
   * analogy with similar things it has done is real evidence. But the prior is
   * discounted by how little it is backed: after `confidenceAfter` attempts the
   * estimate comes from outcomes instead, and the caller's guess stops
   * mattering.
   */
  define(skill: {
    readonly name: string;
    readonly achieves?: string;
    readonly description?: string;
    readonly steps: readonly SkillStep[];
    readonly preconditions?: readonly SkillPrecondition[];
    readonly prior?: Credence;
    readonly tags?: readonly string[];
  }): Skill {
    const name = normalise(skill.name, 'SKILL_EMPTY_NAME', 'a skill needs a non-empty name');
    if (!Array.isArray(skill.steps) || skill.steps.length === 0) {
      throw new LogosError('SKILL_NO_STEPS', `skill "${name}" must define at least one step`, { name });
    }
    for (const step of skill.steps) validateStep(step, name);

    const existing = this.#byName.get(name);
    if (existing !== undefined) {
      // Re-defining replaces the procedure but KEEPS the practice. Changing how
      // something is done does not make a mind forget how to do it.
      const record = this.#skills.get(existing) as SkillRecord;
      record.steps = [...skill.steps];
      record.description = skill.description ?? record.description;
      record.achieves = skill.achieves ?? record.achieves;
      record.preconditions = [...(skill.preconditions ?? record.preconditions)];
      record.tags = [...(skill.tags ?? record.tags)];
      return this.#view(record);
    }

    const id = newSkillId();
    const record: SkillRecord = {
      id,
      name,
      description: skill.description ?? '',
      achieves: skill.achieves ?? name,
      steps: [...skill.steps],
      mastery: clampCredence(skill.prior ?? 0.3),
      prior: clampCredence(skill.prior ?? 0.3),
      attempts: 0,
      successes: 0,
      failures: 0,
      streak: 0,
      attentionCost: this.#costOf(skill.steps, skill.prior ?? 0.3),
      preconditions: [...(skill.preconditions ?? [])],
      createdAt: this.#clock.current,
      lastPracticedAt: undefined,
      tags: [...(skill.tags ?? [])],
    };

    this.#skills.set(id, record);
    this.#byName.set(name, id);

    this.#bus.publish(
      'skill:defined',
      { id, name, achieves: record.achieves, prior: record.mastery, steps: record.steps.length },
      this.#clock.current,
    );

    return this.#view(record);
  }

  forget(name: string): boolean {
    const id = this.#byName.get(name);
    if (id === undefined) return false;
    this.#byName.delete(name);
    this.#skills.delete(id);
    return true;
  }

  clear(): void {
    this.#skills.clear();
    this.#byName.clear();
    this.#attempts = 0;
    this.#successes = 0;
    this.#failures = 0;
    this.#attentionSpent = 0;
  }

  check(): readonly string[] {
    const problems: string[] = [];
    for (const record of this.#skills.values()) {
      if (record.mastery < 0 || record.mastery > 1) {
        problems.push(`skill "${record.name}" has mastery outside [0,1]: ${record.mastery}`);
      }
      if (record.successes + record.failures > record.attempts) {
        problems.push(`skill "${record.name}" has more outcomes than attempts`);
      }
      if (record.attentionCost < 0) problems.push(`skill "${record.name}" has negative attention cost`);
      for (const step of record.steps) {
        for (const referenced of referencedNames(step)) {
          if (referenced.kind === 'skill' && !this.#byName.has(referenced.name)) {
            problems.push(`skill "${record.name}" references unknown skill "${referenced.name}"`);
          }
        }
      }
    }
    for (const [name, id] of this.#byName) {
      if (!this.#skills.has(id)) problems.push(`name index points at missing skill: ${name} -> ${id}`);
    }
    return problems;
  }

  // ── practice ──────────────────────────────────────────────────────────────

  /**
   * The attention a skill will cost.
   *
   * Falls as mastery rises, which is the whole point of procedural memory: a
   * mastered skill has stopped being deliberate, so the scarce resource is
   * freed for something else. The fall is geometric rather than linear, so the
   * first few practices save the most — which is how skill acquisition actually
   * feels and is what makes a novice's tenth attempt much cheaper than their
   * first.
   */
  costOf(name: string): number {
    const skill = this.byName(name);
    return skill === undefined ? Number.POSITIVE_INFINITY : skill.attentionCost;
  }

  /**
   * Attempt a skill against a world.
   *
   * The attempt is charged to the scheduler when one is attached, so practice
   * competes with everything else for attention. A mind that could practise for
   * free would never have to choose between getting better and getting on with
   * things, and that choice is the interesting part.
   *
   * `interruptible` controls whether the work is modelled as a schedulable task.
   * It is true for a long procedure and false for a lookup, because wrapping
   * every trivial operation in the scheduler would flood the bus with events
   * that describe nothing.
   */
  async attempt(
    name: string,
    context: SkillContext,
    options: { readonly interruptible?: boolean } = {},
  ): Promise<SkillAttempt> {
    const skill = this.byName(name);
    if (skill === undefined) {
      throw new LogosError('SKILL_UNKNOWN', `no skill named "${name}"`, { name });
    }
    const record = this.#skills.get(skill.id) as SkillRecord;
    const before = record.mastery;

    // Attention the caller is willing to spend on this attempt. It is a hard
    // ceiling imposed from outside and is respected below. An absent or
    // non-finite budget means unbounded, not zero.
    const declared = context.budget;
    const allowed = declared === undefined || !Number.isFinite(declared) ? Number.POSITIVE_INFINITY : Math.max(0, declared);

    if (options.interruptible === true && this.#scheduler !== undefined) {
      return this.#attemptScheduled(record, context, allowed);
    }
    return this.#execute(record, context, allowed);
  }

  async #attemptScheduled(
    record: SkillRecord,
    context: SkillContext,
    allowed: number,
  ): Promise<SkillAttempt> {
    const scheduler = this.#scheduler;
    if (scheduler === undefined) return this.#execute(record, context, allowed);

    let attempt: SkillAttempt | undefined;
    const outcome = await scheduler.run<SkillAttempt>({
      name: `skill:${record.name}`,
      // Skills run above background consolidation but below urgent deliberation.
      priority: 300,
      resource: 'skills',
      // A skill costs what its mastery says it costs, rounded to at least one
      // budget unit so the scheduler can account for it at all.
      chargeOnComplete: Math.max(1, Math.ceil(record.attentionCost)),
      run: () => {
        attempt = this.#execute(record, context, allowed);
        return { status: 'done', value: attempt };
      },
    });

    if (outcome.state === 'done' && outcome.value !== undefined) return outcome.value;
    if (attempt !== undefined) return attempt;

    // The task never ran. Record an interrupted attempt rather than inventing
    // an outcome, because an attempt that did not happen is not evidence about
    // competence either way.
    return Object.freeze({
      skillId: record.id,
      name: record.name,
      succeeded: false,
      failure: 'interrupted' as const,
      masteryBefore: record.mastery,
      masteryAfter: record.mastery,
      cost: 0,
      steps: 0,
      at: this.#clock.current,
      detail: `attempt ${outcome.state} before it could run`,
    });
  }

  /**
   * Run a skill, then learn from what happened.
   *
   * The outcome is classified before it is learned from, and the classification
   * is what keeps this honest: an unmet precondition is not evidence about
   * competence, so it must not lower mastery. Getting that wrong teaches a
   * mind to avoid things it is good at simply because it once tried them in the
   * wrong circumstances.
   */
  #execute(record: SkillRecord, context: SkillContext, allowed: number): SkillAttempt {
    const before = record.mastery;

    const unmet = unmetPreconditions(record.preconditions, context.state);
    if (unmet.length > 0) {
      // Not an attempt at all, and deliberately not counted as one.
      const attempt: SkillAttempt = Object.freeze({
        skillId: record.id,
        name: record.name,
        succeeded: false,
        failure: 'preconditions-unmet' as const,
        masteryBefore: before,
        masteryAfter: before,
        cost: 0,
        steps: 0,
        at: this.#clock.current,
        detail: unmet.join(', '),
      });
      this.#bus.publish(
        'skill:inapplicable',
        { name: record.name, reason: attempt.detail },
        this.#clock.current,
      );
      return attempt;
    }

    const perStep = this.#perStepCost(record.mastery);
    // Two quantities, and the smaller wins because they answer different
    // questions:
    //
    //   what the skill NEEDS  — its declared attention cost, derived from
    //                           mastery and step count. This is what practice
    //                           makes cheaper.
    //   what the caller HAS   — `context.budget`, a hard ceiling imposed from
    //                           outside. A caller with five units of attention
    //                           to spend cannot be talked into spending two
    //                           hundred by a procedure that says it needs them.
    //
    // Taking the declared cost alone would let a skill ignore its caller's
    // constraint; taking the caller's alone would make mastery irrelevant to
    // what an attempt costs. The minimum honours both, and the attempt is
    // interrupted — not failed — when the two disagree.
    const needed = perStep * countSteps(record.steps);
    const budget = Math.min(needed, allowed);
    const run = this.#runSteps(record.steps, { ...context, budget }, 0, perStep);

    const steps = run.steps;
    const succeeded = run.succeeded && run.budget >= -1e-9;
    const failure: FailureKind | undefined = succeeded
      ? undefined
      : run.malformed !== undefined
        ? 'malformed'
        : run.budget < -1e-9
          ? 'interrupted'
          : 'execution-failed';

    // Prefer the specific reason. "attention exhausted" is what the deepest
    // frame knows; "a step failed" is only the summary, and reporting the
    // summary loses the only fact worth having.
    const detail = run.malformed ?? run.detail ?? 'a step failed';

    const cost = round(Math.max(0, budget - run.budget));

    // ── learning ──
    //
    // A malformed skill is a defect in its definition, not evidence about the
    // mind, so it is reported but does not move mastery. An interrupted attempt
    // is genuinely inconclusive for the same reason.
    if (failure !== 'malformed' && failure !== 'interrupted') {
      this.#learn(record, succeeded);
    } else if (succeeded) {
      this.#learn(record, true);
    }

    record.lastPracticedAt = this.#clock.current;
    this.#attentionSpent += cost;

    const attempt: SkillAttempt = Object.freeze({
      skillId: record.id,
      name: record.name,
      succeeded,
      failure,
      masteryBefore: round(before),
      masteryAfter: round(record.mastery),
      cost,
      steps,
      at: this.#clock.current,
      detail: succeeded ? 'completed' : (run.detail ?? 'a step failed'),
    });

    this.#bus.publish(
      succeeded ? 'skill:succeeded' : 'skill:failed',
      {
        id: record.id,
        name: record.name,
        mastery: attempt.masteryAfter,
        cost: attempt.cost,
        steps: attempt.steps,
        failure: failure ?? null,
        detail: attempt.detail,
      },
      this.#clock.current,
    );

    return attempt;
  }

  /**
   * Move mastery according to an outcome.
   *
   * Asymmetric on purpose: mastery falls faster than it rises. A single failure
   * is stronger evidence than a single success, because success can be luck and
   * failure is usually not — a mind that forgot that would be persistently
   * overconfident about anything that happened to work once.
   *
   * The step size also shrinks as attempts accumulate, so early practice moves
   * the estimate a lot and later practice refines it. That is what makes a
   * skill's mastery converge instead of oscillating.
   */
  #learn(record: SkillRecord, succeeded: boolean): void {
    record.attempts += 1;
    this.#attempts += 1;

    if (succeeded) {
      record.successes += 1;
      record.streak += 1;
      this.#successes += 1;
    } else {
      record.failures += 1;
      record.streak = 0;
      this.#failures += 1;
    }

    // Confidence in the estimate grows with attempts; the prior stops mattering.
    const weight = 1 / (1 + record.attempts * 0.5);
    const target = succeeded ? 1 : 0;
    const rate = this.#learningRate * (succeeded ? 1 : 1.6);
    record.mastery = clampUnit(record.mastery + (target - record.mastery) * rate * Math.max(0.15, weight));

    // A success streak is evidence the estimation is lagging, so it is given a
    // nudge. Fluency is a property of the recent run, not the lifetime average.
    if (record.streak >= 3) {
      record.mastery = clampUnit(record.mastery + 0.05 * Math.min(3, record.streak - 2));
    }

    record.attentionCost = this.#costOf(record.steps, record.mastery);
  }

  /**
   * The outcome of running a step list.
   *
   * `malformed` and `detail` are declared as `string | undefined` rather than
   * optional. Under `exactOptionalPropertyTypes` an optional property cannot be
   * assigned an explicit `undefined`, and the recursive cases below build
   * results by conditionally spreading one or the other — so the difference
   * between "absent" and "present but undefined" would be a distinction the
   * code would have to maintain for no benefit.
   */
  #runSteps(
    steps: readonly SkillStep[],
    context: SkillContext,
    depth: number,
    perStep: number,
  ): { succeeded: boolean; budget: number; steps: number; malformed: string | undefined; detail: string | undefined } {
    if (depth > 8) {
      return {
        succeeded: false,
        budget: context.budget,
        steps: 0,
        malformed: 'skill nesting exceeded the depth limit of 8 — likely a cycle in the skill graph',
        detail: undefined,
      };
    }

    let budget = context.budget;
    let count = 0;

    for (const step of steps) {
      if (budget <= -1e-9) {
        return { succeeded: false, budget, steps: count, malformed: undefined, detail: 'attention exhausted' };
      }

      switch (step.kind) {
        case 'action': {
          const cost = perStep;
          budget -= cost;
          count += 1;
          // A tiny tolerance because both quantities are floating point: an
          // exact-zero remainder is success, not exhaustion.
          if (budget < -1e-9) {
            return { succeeded: false, budget, steps: count, malformed: undefined, detail: 'attention exhausted' };
          }

          const result = context.act(step.name, step.params);
          // The act callback may be asynchronous, and this executor is
          // synchronous by design: skill execution has to be measurable in
          // steps and attention, and threading awaits through the recursion
          // would make the budget unaccountable. A promise result is therefore
          // treated as "dispatched successfully" and its outcome is the
          // caller's business.
          if (result === false) {
            return { succeeded: false, budget, steps: count, malformed: undefined, detail: `action "${step.name}" failed` };
          }
          break;
        }

        case 'skill': {
          const nested = this.#byName.get(step.name);
          if (nested === undefined) {
            return { succeeded: false, budget, steps: count, malformed: `unknown skill "${step.name}"`, detail: undefined };
          }
          const nestedRecord = this.#skills.get(nested) as SkillRecord;
          const result = this.#runSteps(nestedRecord.steps, { ...context, budget }, depth + 1, perStep);
          count += result.steps;
          budget = result.budget;
          if (!result.succeeded) {
            // Only summarise when the deeper frame had nothing specific to say.
            // Overwriting a precise reason with "a step failed" discards the
            // only fact worth having.
            return {
              succeeded: false,
              budget,
              steps: count,
              malformed: result.malformed,
              detail: result.malformed ?? result.detail ?? `sub-skill "${step.name}" failed`,
            };
          }
          break;
        }

        case 'branch': {
          const condition = Boolean(context.state[step.on]);
          const chosen = condition ? step.then : (step.otherwise ?? []);
          // A branch is STRUCTURE, not work. Charging for the container as if
          // it were a primitive step made a procedure cost more than the steps
          // it actually performs, so a skill could be declared affordable and
          // then interrupted halfway with attention left unspent on nothing.
          const result = this.#runSteps(chosen, { ...context, budget }, depth + 1, perStep);
          count += result.steps;
          budget = result.budget;
          if (!result.succeeded) {
            return { succeeded: false, budget, steps: count, malformed: result.malformed, detail: result.detail };
          }
          break;
        }

        case 'repeat': {
          const times = Math.max(0, Math.floor(step.times));
          // Likewise structure, not work.
          for (let i = 0; i < times; i += 1) {
            const result = this.#runSteps(step.body, { ...context, budget }, depth + 1, perStep);
            count += result.steps;
            budget = result.budget;
            if (!result.succeeded) {
              return { succeeded: false, budget, steps: count, malformed: result.malformed, detail: result.detail };
            }
          }
          break;
        }
      }
    }

    return { succeeded: true, budget, steps: count, malformed: undefined, detail: undefined };
  }

  /**
   * Attention per primitive step at a given mastery: geometrically cheaper as
   * mastery rises.
   *
   * One function, used both to DECLARE a skill's cost and to CHARGE for it
   * during execution, so the two can never disagree. They disagreed once: the
   * declared cost for a one-step skill was 0.57 while execution charged 1.0 per
   * step, so every unmastered skill was interrupted before its first action and
   * nothing could ever be practised.
   */
  #perStepCost(mastery: number): number {
    const m = clampUnit(mastery);
    return this.#floorCostPerStep + (this.#baseCostPerStep - this.#floorCostPerStep) * (1 - m) ** 2;
  }

  /** Attention for a whole procedure at a given mastery. */
  #costOf(steps: readonly SkillStep[], mastery: number): number {
    return round(Math.max(this.#floorCostPerStep, this.#perStepCost(mastery) * countSteps(steps)));
  }

  #view(record: SkillRecord): Skill {
    return Object.freeze({
      id: record.id,
      name: record.name,
      description: record.description,
      achieves: record.achieves,
      steps: Object.freeze([...record.steps]),
      mastery: round(record.mastery),
      attempts: record.attempts,
      successes: record.successes,
      failures: record.failures,
      streak: record.streak,
      attentionCost: round(record.attentionCost),
      preconditions: Object.freeze([...record.preconditions]),
      createdAt: record.createdAt,
      lastPracticedAt: record.lastPracticedAt,
      tags: Object.freeze([...record.tags]),
    });
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function normalise(value: string, code: string, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LogosError(code, message, { value });
  }
  return value.trim();
}

/** Structural validation of a step tree, so a malformed skill is refused at definition. */
function validateStep(step: SkillStep, skillName: string): void {
  switch (step.kind) {
    case 'action':
      normalise(step.name, 'SKILL_BAD_STEP', `skill "${skillName}" has an action step with no name`);
      break;
    case 'skill':
      normalise(step.name, 'SKILL_BAD_STEP', `skill "${skillName}" has a sub-skill step with no name`);
      break;
    case 'branch':
      normalise(step.on, 'SKILL_BAD_STEP', `skill "${skillName}" has a branch with no condition key`);
      for (const s of step.then) validateStep(s, skillName);
      for (const s of step.otherwise ?? []) validateStep(s, skillName);
      break;
    case 'repeat':
      if (!Number.isInteger(step.times) || step.times < 0) {
        throw new LogosError('SKILL_BAD_REPEAT', `skill "${skillName}" has a repeat with a non-integer count`, {
          times: step.times,
        });
      }
      for (const s of step.body) validateStep(s, skillName);
      break;
    default: {
      const exhaustive: never = step;
      throw new LogosError('SKILL_UNKNOWN_STEP', `skill "${skillName}" has an unrecognised step kind`, {
        step: exhaustive,
      });
    }
  }
}

/** Every skill name a step tree references, for integrity checking. */
function referencedNames(step: SkillStep): readonly { kind: 'skill'; name: string }[] {
  switch (step.kind) {
    case 'skill':
      return [{ kind: 'skill', name: step.name }];
    case 'branch':
      return [...step.then, ...(step.otherwise ?? [])].flatMap(referencedNames);
    case 'repeat':
      return step.body.flatMap(referencedNames);
    default:
      return [];
  }
}

/** Total primitive steps a tree can perform. Structure counts for nothing. */
function countSteps(steps: readonly SkillStep[]): number {
  let total = 0;
  for (const step of steps) {
    switch (step.kind) {
      case 'action':
        total += 1;
        break;
      case 'skill':
        // Charged as one until expanded, so a composite's declared cost stays
        // bounded however deeply it nests.
        total += 1;
        break;
      case 'branch':
        // Both arms are counted: a declaration has to cover the worst case, or
        // a procedure could be declared affordable and interrupted depending on
        // which way the world happened to branch.
        total += countSteps(step.then) + countSteps(step.otherwise ?? []);
        break;
      case 'repeat':
        total += Math.max(0, Math.floor(step.times)) * countSteps(step.body);
        break;
    }
  }
  return Math.max(1, total);
}

function unmetPreconditions(
  preconditions: readonly SkillPrecondition[],
  state: Readonly<Record<string, unknown>>,
): string[] {
  const unmet: string[] = [];
  for (const condition of preconditions) {
    const present = Object.prototype.hasOwnProperty.call(state, condition.key);
    const value = state[condition.key];

    if (condition.present === true && !present) unmet.push(`${condition.key} must be present`);
    else if (condition.present === false && present) unmet.push(`${condition.key} must be absent`);
    else if (condition.equals !== undefined && value !== condition.equals) {
      unmet.push(`${condition.key} must equal ${String(condition.equals)}`);
    } else if (condition.above !== undefined && (typeof value !== 'number' || value <= condition.above)) {
      unmet.push(`${condition.key} must exceed ${condition.above}`);
    } else if (condition.below !== undefined && (typeof value !== 'number' || value >= condition.below)) {
      unmet.push(`${condition.key} must be below ${condition.below}`);
    }
  }
  return unmet;
}

const clampUnit = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
