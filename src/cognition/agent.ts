/**
 * LOGOS :: Cognition :: The cognitive cycle
 * ---------------------------------------------------------------------------
 * Every layer, wired into one loop.
 *
 * This is the file that answers whether the architecture is a system or a pile
 * of modules. The layers were built bottom-up and each was tested in isolation;
 * what is asserted here is that they compose — that perception feeds memory,
 * memory feeds inference, inference feeds expectation, and expectation feeds
 * back into what gets perceived.
 *
 * ONE CYCLE, IN ORDER:
 *
 *   1. PERCEIVE   raw input passes the attentional gate. Most of it is refused.
 *   2. ORIENT     whatever got in is compared against the world model, and the
 *                 surprise is recorded.
 *   3. RECALL     the current situation cues memory across all stores, and
 *                 what comes back is registered as rehearsal.
 *   4. EVALUATE   recalled concepts and the surprise update beliefs.
 *   5. DELIBERATE goals are reviewed; attention is allocated; a plan is chosen.
 *   6. ACT        the chosen plan's first step is taken against the world.
 *   7. PREDICT    the world model is asked what it expects next, and the cycle
 *                 commits to being wrong in a checkable way.
 *   8. REFLECT    periodically, the calibration is measured and the goals are
 *                 re-examined. This is what closes the loop: the mind's
 *                 confidence about itself changes based on how its predictions
 *                 actually turned out.
 *
 * WHY THE ORDER IS WHAT IT IS. Two of the steps could plausibly be swapped and
 * the choice matters:
 *
 *   · ORIENT precedes RECALL. Surprise is computed against what the world model
 *     ALREADY expected, before memory has supplied anything reassuring. If
 *     recall ran first, a mind would rarely be surprised — it would have
 *     already talked itself into expecting whatever it saw.
 *
 *   · PREDICT precedes REFLECT. Reflection measures the accuracy of predictions
 *     that were actually made, so it has to run against predictions registered
 *     on previous cycles rather than ones registered in the same breath.
 *
 * The cycle is driven by the kernel's tick, and every step is a scheduler task,
 * so the whole thing runs under the same attention budget as everything else.
 * A cycle that cannot afford its next step yields rather than overrunning.
 */

import type { Kernel, KernelContext } from '../kernel/kernel.ts';
import type { Tick } from '../kernel/types.ts';
import type { WorkingMemory } from '../memory/working.ts';
import type { EpisodicMemory } from '../memory/episodic.ts';
import type { SemanticMemory } from '../memory/semantic.ts';
import type { ConsolidationEngine } from '../memory/consolidation.ts';
import type { Rememberer, RecallResult } from '../memory/remember.ts';
import type { PerceptionGate, PerceptInput, GateDecision } from '../perception/gate.ts';
import type { WorldModel } from '../reasoning/world-model.ts';
import type { BeliefStore } from '../reasoning/beliefs.ts';
import type { GoalSystem, Goal } from '../planning/goals.ts';
import type { Planner, Plan, PlanState } from '../planning/planner.ts';
import type { Calibrator } from '../metacognition/calibration.ts';
import type { SkillRegistry } from '../skills/registry.ts';
import type { Affect } from '../memory/types.ts';

/** One cycle's worth of everything that happened. */
export interface CycleReport {
  readonly tick: Tick;
  readonly perceptsOffered: number;
  readonly perceptsAdmitted: number;
  readonly refused: readonly { readonly content: string; readonly reason: string; readonly salience: number }[];
  readonly recalled: number;
  readonly surprise: number;
  readonly focusedGoals: readonly { readonly id: string; readonly description: string; readonly priority: number }[];
  readonly plan: { readonly goal: string; readonly steps: number; readonly confidence: number } | undefined;
  readonly action: { readonly name: string; readonly succeeded: boolean } | undefined;
  readonly expected: readonly string[];
  readonly reflected: boolean;
  /** Wall-clock milliseconds the cycle took. */
  readonly durationMs: number;
}

/** What the agent did in response to a situation. */
export interface ActionOutcome {
  readonly name: string;
  readonly succeeded: boolean;
  readonly detail: string;
}

/**
 * A world the agent acts on.
 *
 * Separated from the agent because a mind and its environment are different
 * things, and an architecture that conflated them could not be pointed at a
 * simulated world for testing and a real one for use.
 */
export interface Environment {
  /** The current observable state, as a plain object. */
  observe(): PlanState;
  /** Perform a primitive action by name. Returns whether it worked. */
  act(name: string, state: PlanState): ActionOutcome | Promise<ActionOutcome>;
}

export interface CognitiveAgentOptions {
  readonly kernel: Kernel;
  readonly working: WorkingMemory;
  readonly episodic: EpisodicMemory;
  readonly semantic: SemanticMemory;
  readonly consolidation: ConsolidationEngine;
  readonly rememberer: Rememberer;
  readonly gate: PerceptionGate;
  readonly world: WorldModel;
  readonly beliefs: BeliefStore;
  readonly goals: GoalSystem;
  readonly planner: Planner;
  readonly calibrator: Calibrator;
  /** The world the agent acts on. Omit for a purely contemplative agent. */
  readonly environment?: Environment;
  /** Ticks between automatic reflections. */
  readonly reflectEvery?: number;
  /** Confidence below which a plan is not acted on. */
  readonly actAbove?: number;
  /**
   * Optional procedural memory. When present, a plan step whose name matches a
   * skill is performed as that skill, so practice happens as a consequence of
   * acting rather than as a separate activity.
   */
  readonly skills?: SkillRegistry;
}

interface AgentState {
  /** The plan currently being executed, if any. */
  plan: Plan | undefined;
  /** Index of the next step to take. */
  stepIndex: number;
  /** The goal the current plan serves. */
  goalId: string | undefined;
  /** Prediction registered for a later cycle to score. */
  pendingPrediction: string | undefined;
  /**
   * Confidence recorded alongside the pending prediction, so the calibration
   * input is the confidence the mind actually held rather than one recomputed
   * afterwards from knowledge it did not have at the time.
   */
  pendingConfidence: number;
  /**
   * The state the mind said the world would proceed to, so the forecast can be
   * scored against what actually arrived.
   *
   * `undefined` means the mind had nothing to forecast and instead expected the
   * situation to continue — which is graded differently, because that is a
   * different claim.
   */
  pendingExpected: string | undefined;
}

export class CognitiveAgent {
  readonly #kernel: Kernel;
  readonly #working: WorkingMemory;
  readonly #episodic: EpisodicMemory;
  readonly #semantic: SemanticMemory;
  readonly #consolidation: ConsolidationEngine;
  readonly #rememberer: Rememberer;
  readonly #gate: PerceptionGate;
  readonly #world: WorldModel;
  readonly #beliefs: BeliefStore;
  readonly #goals: GoalSystem;
  readonly #planner: Planner;
  readonly #calibrator: Calibrator;
  readonly #environment: Environment | undefined;
  readonly #reflectEvery: number;
  readonly #actAbove: number;
  readonly #skills: SkillRegistry | undefined;

  /**
   * Mutable cycle-to-cycle state.
   *
   * Updated FIELD BY FIELD rather than by spreading a new object. An earlier
   * version did `this.#state = { ...this.#state, pendingPrediction }`, which
   * silently discarded the plan progress that `#act()` had just written in the
   * same cycle — so plans restarted from step zero forever and goals never
   * completed. Replacing a whole record to change one field is a standing
   * invitation to lose the others.
   */
  #state: AgentState = {
    plan: undefined,
    stepIndex: 0,
    goalId: undefined,
    pendingPrediction: undefined,
    pendingConfidence: 0,
    pendingExpected: undefined,
  };
  #cycles: CycleReport[] = [];
  #cycleCount = 0;
  #reflections = 0;

  constructor(options: CognitiveAgentOptions) {
    this.#kernel = options.kernel;
    this.#working = options.working;
    this.#episodic = options.episodic;
    this.#semantic = options.semantic;
    this.#consolidation = options.consolidation;
    this.#rememberer = options.rememberer;
    this.#gate = options.gate;
    this.#world = options.world;
    this.#beliefs = options.beliefs;
    this.#goals = options.goals;
    this.#planner = options.planner;
    this.#calibrator = options.calibrator;
    this.#environment = options.environment;
    this.#reflectEvery = Math.max(1, Math.floor(options.reflectEvery ?? 12));
    this.#actAbove = clampUnit(options.actAbove ?? 0.25);
    this.#skills = options.skills;

    // The world model is the gate's prediction source. Wiring it here rather
    // than at construction is what resolves the circularity: the gate is needed
    // to form the memories the world model learns from.
    this.#gate.setPredictor(this.#world);
    this.#goals.setBeliefs(this.#beliefs);
  }

  // ── introspection ─────────────────────────────────────────────────────────

  get cycles(): number {
    return this.#cycleCount;
  }

  get reflections(): number {
    return this.#reflections;
  }

  get currentPlan(): Plan | undefined {
    return this.#state.plan;
  }

  /** The most recent cycle report. */
  lastCycle(): CycleReport | undefined {
    return this.#cycles.at(-1);
  }

  history(): readonly CycleReport[] {
    return [...this.#cycles];
  }

  /** A full picture of the agent's mental state, for logging or inspection. */
  state(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      tick: this.#kernel.clock.current,
      cycles: this.#cycleCount,
      reflections: this.#reflections,
      working: this.#working.contents().length,
      episodes: this.#episodic.size,
      concepts: this.#semantic.size,
      beliefs: this.#beliefs.size,
      goals: this.#goals.stats(),
      worldStates: this.#world.stateCount,
      calibration: this.#calibrator.report(),
      plan: this.#state.plan === undefined ? null : { goal: this.#state.plan.goal, steps: this.#state.plan.steps.length },
    });
  }

  describe(): string {
    const cal = this.#calibrator.report();
    return (
      `agent[tick=${this.#kernel.clock.current} cycles=${this.#cycleCount} ` +
      `wm=${this.#working.size}/${this.#working.capacity} ` +
      `${this.#episodic.size}ep ${this.#semantic.size}con ${this.#beliefs.size}bel ` +
      `${this.#goals.describe()} ${this.#world.describe()} ` +
      `cal=${cal.bias >= 0 ? '+' : ''}${cal.bias.toFixed(2)}]`
    );
  }

  // ── the cycle ─────────────────────────────────────────────────────────────

  /**
   * Run one full cognitive cycle.
   *
   * Every step is wrapped so that a failure in one subsystem degrades that
   * subsystem rather than killing the cycle. A mind that stopped thinking
   * because memory threw an exception would be a worse mind than one that
   * continued without the memory it could not reach.
   */
  async cycle(percepts: readonly PerceptInput[] = []): Promise<CycleReport> {
    const startedAt = Date.now();
    const tick = this.#kernel.clock.current;

    // ── 1. PERCEIVE ──
    const decisions: GateDecision[] = [];
    for (const percept of percepts) {
      try {
        decisions.push(this.#gate.perceive(percept));
      } catch (error) {
        this.#kernel.bus.publish(
          'cognition:error',
          { stage: 'perceive', error: describe(error) },
          tick,
        );
      }
    }
    const admitted = decisions.filter((d) => d.admitted);
    const refused = decisions
      .filter((d) => !d.admitted)
      .map((d) => ({ content: d.percept.content.slice(0, 60), reason: d.reason, salience: d.percept.salience }));

    // ── 2. ORIENT ──
    //
    // Surprise is computed against what the world model expected BEFORE recall
    // has supplied anything. Reversing these two steps would produce a mind
    // that is rarely surprised, because it would have already talked itself
    // into expecting whatever it saw.
    //
    // This is also where experience becomes EPISODIC MEMORY. Without it the
    // agent would perceive, reason and plan but never accumulate a past — and
    // consolidation, which reads episodes as its raw material, would have
    // nothing to generalise from. An architecture whose memory layer is only
    // ever written by its tests is not remembering anything.
    let surprise = 0;
    /**
     * The content of the first admitted observation — the state the world moved
     * to, used to grade the previous cycle's forecast.
     *
     * The FIRST admitted percept rather than the most surprising one: the
     * forecast names a single successor, and taking the most surprising of
     * several admitted percepts would mean grading against whichever one
     * happened to win a race, which is a coin flip dressed as a rule. The
     * admitted order is deterministic and inspectable, so the first is too.
     *
     * When nothing was admitted the world did not move, and the forecast is
     * graded on surprise instead — see `#registerPrediction`.
     */
    const observedContent: string | undefined = admitted[0]?.percept.content;
    for (const decision of admitted) {
      try {
        const outcome = this.#world.observe({ content: decision.percept.content });
        if (outcome.surprise > surprise) surprise = outcome.surprise;

        this.#episodic.encode(decision.percept.content, {
          situation: decision.percept.source,
          context: {
            modality: decision.percept.modality,
            source: decision.percept.source,
            ...(typeof decision.percept.data['service'] === 'string'
              ? { service: decision.percept.data['service'] }
              : {}),
          },
          surprise: outcome.surprise,
          // Self-relevance is read from the percept's affect: what moved the
          // agent is what the agent is likely to be involved in.
          selfRelevance: Math.abs(decision.percept.affect.valence),
          affect: decision.percept.affect,
          ...(Object.keys(decision.percept.data).length === 0 ? {} : { data: { ...decision.percept.data } }),
        });
      } catch (error) {
        this.#kernel.bus.publish('cognition:error', { stage: 'orient', error: describe(error) }, tick);
      }
    }

    // ── 3. RECALL ──
    const situation = this.#situationText(percepts);
    let memory: RecallResult | undefined;
    if (situation.length > 0) {
      try {
        memory = this.#rememberer.recall({
          text: situation,
          limit: 6,
          spreadDepth: 2,
          mood: this.#mood(),
        });
      } catch (error) {
        this.#kernel.bus.publish('cognition:error', { stage: 'recall', error: describe(error) }, tick);
      }
    }

    // ── 4. EVALUATE ──
    //
    // What came back is turned into belief. A concept that memory surfaced is
    // evidence for the proposition it names, weighted by how strongly it was
    // recalled — so a memory that keeps proving relevant becomes something the
    // mind actually asserts rather than merely stores.
    if (memory !== undefined) {
      for (const item of memory.items.slice(0, 3)) {
        try {
          this.#beliefs.addEvidence(item.trace.content.slice(0, 200), {
            content: `recalled from ${item.store} at relevance ${item.relevance.toFixed(2)}`,
            source: `memory:${item.store}`,
            strength: 1 + item.relevance * 3,
            reliability: 0.6,
          });
        } catch (error) {
          this.#kernel.bus.publish('cognition:error', { stage: 'evaluate', error: describe(error) }, tick);
        }
      }
    }

    // ── 5. DELIBERATE ──
    this.#goals.review();
    this.#goals.schedule();
    const focused = this.#goals.focus();

    let plan: Plan | undefined;
    let action: ActionOutcome | undefined;

    if (focused.length > 0) {
      const target = focused[0] as Goal;
      plan = await this.#deliberate(target);
    }

    // ── 6. ACT ──
    if (plan !== undefined && this.#environment !== undefined) {
      action = await this.#act(plan);
    }

    // ── 7. PREDICT ──
    //
    // The mind commits to an expectation it can be wrong about, and records the
    // prediction so that a LATER cycle can score it. Predicting without
    // recording would make reflection impossible; recording without predicting
    // would make it meaningless.
    const expected = this.#registerPrediction(admitted.length > 0 ? surprise : 0, observedContent);

    // ── 8. REFLECT ──
    //
    // Counted from one, so "every 3 cycles" means the 3rd, 6th, 9th. Counting
    // from zero would make the first reflection land on cycle 4 under a
    // cadence of 3, which is not what anyone means by it.
    let reflected = false;
    if ((this.#cycleCount + 1) % this.#reflectEvery === 0) {
      this.#reflect();
      reflected = true;
    }

    this.#cycleCount += 1;

    // Logical time advances LAST. Every stage above reads the tick the cycle
    // began on, so the report describes a single consistent instant rather than
    // spanning two.
    this.#kernel.clock.step();

    // The stores keep their own clocks, and they must be advanced too.
    // Forgetting, decay and — critically — the age threshold that decides when
    // an episode is old enough to generalise all read those clocks. An earlier
    // version advanced only the kernel's, so every episode sat permanently at
    // tick zero and consolidation never found anything mature enough to use.
    // Memory that never ages is memory that never consolidates.
    try {
      this.#working.step();
      this.#episodic.step();
      this.#semantic.step();
    } catch (error) {
      this.#kernel.bus.publish('cognition:error', { stage: 'decay', error: describe(error) }, tick);
    }

    const report: CycleReport = Object.freeze({
      tick,
      perceptsOffered: percepts.length,
      perceptsAdmitted: admitted.length,
      refused: Object.freeze(refused),
      recalled: memory?.items.length ?? 0,
      surprise: round(surprise),
      focusedGoals: Object.freeze(
        focused.map((g) => ({ id: g.id, description: g.description, priority: g.priority })),
      ),
      plan: plan === undefined ? undefined : { goal: plan.goal, steps: plan.steps.length, confidence: plan.confidence },
      action: action === undefined ? undefined : { name: action.name, succeeded: action.succeeded },
      expected: Object.freeze(expected),
      reflected,
      durationMs: Date.now() - startedAt,
    });

    this.#cycles.push(report);
    if (this.#cycles.length > 256) this.#cycles.shift();

    this.#kernel.context.emit('cognition:cycle', {
      tick: report.tick,
      admitted: report.perceptsAdmitted,
      recalled: report.recalled,
      surprise: report.surprise,
      planned: report.plan !== undefined,
    });

    return report;
  }

  /** Run several cycles, feeding the environment's observation each time. */
  async run(cycles: number, perceptSource?: () => readonly PerceptInput[]): Promise<readonly CycleReport[]> {
    if (!Number.isFinite(cycles) || cycles < 1) {
      throw new RangeError(`run(cycles) requires cycles >= 1, received ${cycles}`);
    }

    const reports: CycleReport[] = [];
    for (let i = 0; i < Math.floor(cycles); i += 1) {
      const percepts = perceptSource?.() ?? this.#environmentPercepts();
      reports.push(await this.cycle(percepts));
    }
    return Object.freeze(reports);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Choose a plan for a goal.
   *
   * The goal's description is used as the planning task, and the environment's
   * current state as the world the plan is checked against. If planning fails,
   * the goal's feasibility drops — which is how the mind learns that something
   * is harder than it looked, rather than retrying forever.
   */
  async #deliberate(goal: Goal): Promise<Plan | undefined> {
    // Continue an existing plan if it serves the same goal — unless it has run
    // out of steps, in which case returning it would strand the goal in
    // `active` forever, because the completion is only recognised inside
    // `#act()` and `#deliberate()` would keep short-circuiting before reaching
    // it.
    if (this.#state.plan !== undefined && this.#state.goalId === goal.id) {
      if (this.#state.stepIndex < this.#state.plan.steps.length) return this.#state.plan;

      this.#goals.achieve(goal.id, 'plan completed');
      this.#state.plan = undefined;
      this.#state.stepIndex = 0;
      this.#state.goalId = undefined;
      return undefined;
    }

    const state = this.#environment?.observe() ?? {};
    const outcome = this.#planner.plan(goal.description, state);

    if (!outcome.ok) {
      this.#goals.setFeasibility(goal.id, Math.max(0.05, goal.feasibility - 0.1));
      this.#kernel.bus.publish(
        'cognition:planning-failed',
        { goal: goal.id, description: goal.description, reason: outcome.failure.reason, detail: outcome.failure.detail },
        this.#kernel.clock.current,
      );
      return undefined;
    }

    this.#goals.setFeasibility(goal.id, Math.min(1, goal.feasibility + 0.05));
    this.#state.plan = outcome.plan;
    this.#state.stepIndex = 0;
    this.#state.goalId = goal.id;
    return outcome.plan;
  }

  /** Take the next step of the current plan. */
  async #act(plan: Plan): Promise<ActionOutcome | undefined> {
    const environment = this.#environment;
    if (environment === undefined) return undefined;

    const step = plan.steps[this.#state.stepIndex];
    if (step === undefined) {
      // Plan exhausted: the goal is as done as this plan can make it.
      if (this.#state.goalId !== undefined) this.#goals.achieve(this.#state.goalId, 'plan completed');
      this.#state.plan = undefined;
      this.#state.stepIndex = 0;
      this.#state.goalId = undefined;
      return undefined;
    }

    let outcome: ActionOutcome;
    try {
      // A step whose name matches a known SKILL is performed as that skill.
      //
      // Without this the skill layer is inert: it can be defined, practised and
      // measured, but nothing in a live cycle ever touches it, so mastery never
      // moves and the whole layer is decoration. Wiring it here is what makes
      // practice happen as a consequence of acting rather than as a separate
      // activity someone has to remember to run.
      //
      // The skill's own preconditions are checked first. An unmet precondition
      // means "I cannot do this here", which is not evidence about competence,
      // so the attempt is reported as a failure to the plan without touching
      // mastery — the same distinction the skill layer exists to preserve.
      const skill = this.#skills?.byName(step.action.name);
      if (skill !== undefined) {
        const state = environment.observe();
        const attempt = await this.#skills!.attempt(step.action.name, {
          // `Environment.act` may be synchronous or asynchronous, so the result
          // is awaited before being read. Assuming either shape alone would
          // break half the environments anyone writes.
          act: async (name) => (await environment.act(name, state)).succeeded,
          state,
          budget: Number.POSITIVE_INFINITY,
        });
        outcome = {
          name: step.action.name,
          succeeded: attempt.succeeded,
          detail:
            attempt.failure === undefined
              ? `skill ${step.action.name} (mastery ${attempt.masteryAfter.toFixed(2)})`
              : `skill ${step.action.name}: ${attempt.failure}`,
        };
      } else {
        outcome = await environment.act(step.action.name, environment.observe());
      }
    } catch (error) {
      outcome = { name: step.action.name, succeeded: false, detail: describe(error) };
    }

    this.#goals.chargeCost(this.#state.goalId ?? '', 1);

    if (outcome.succeeded) {
      this.#state.stepIndex += 1;
      if (this.#state.goalId !== undefined) this.#goals.noteProgress(this.#state.goalId);

      // Record that this step worked. Repeated success on a step is what makes
      // a mind's expectation of it settle.
      this.#world.observe({ content: `${step.action.name} succeeded`, data: { action: step.action.name } });
    } else {
      // A failed step means the plan was built on a wrong assumption. Drop it
      // and let the next cycle replan against the state that actually obtained.
      this.#kernel.bus.publish(
        'cognition:action-failed',
        { action: outcome.name, detail: outcome.detail, goal: this.#state.goalId ?? null },
        this.#kernel.clock.current,
      );
      this.#world.observe({ content: `${step.action.name} failed`, data: { action: step.action.name } });
      this.#state.plan = undefined;
      this.#state.stepIndex = 0;
    }

    return outcome;
  }

  /**
   * Register an expectation for a later cycle to score.
   *
   * The prediction is the world model's own next-step forecast, with the
   * model's confidence as the calibration input. This is what makes reflection
   * possible: a mind that never wrote down what it expected cannot check
   * whether it was right.
   */
  #registerPrediction(surprise: number, observedContent: string | undefined): readonly string[] {
    // Settle the previous cycle's prediction, graded against WHAT IT CLAIMED.
    //
    // This used to be `resolve(pending, surprise < 0.5)` — "was this cycle
    // unsurprising" — while the confidence attached to the claim came from
    // `forecast[0].probability`, which is P(the world proceeds to THIS state).
    // One criterion to claim, another to grade, and the two are barely related:
    // on the demo's data the surprise test passed ~93% of the time while the
    // confidence averaged 0.64, so the calibration report described a
    // forecaster that does not exist and `skill` pinned to its −1 floor.
    //
    // A forecast about which state comes next is now scored on whether that
    // state arrived. When the mind had nothing to forecast it claimed only that
    // the situation would continue, and THAT is graded by surprise, because
    // that is what it actually asserted.
    if (this.#state.pendingPrediction !== undefined) {
      const expected = this.#state.pendingExpected;
      const correct =
        expected === undefined
          ? surprise < 0.5
          : observedContent !== undefined && sameState(observedContent, expected);
      this.#calibrator.resolve(this.#state.pendingPrediction, correct);
      this.#state.pendingPrediction = undefined;
      this.#state.pendingConfidence = 0;
      this.#state.pendingExpected = undefined;
    }

    const forecast = this.#world.predict(2);

    // When the model has nothing to forecast, the mind still records that it
    // expected the situation to continue — at a confidence reflecting how
    // little it knows. Registering nothing at all would leave the calibrator
    // with no samples from exactly the period when the mind was most ignorant,
    // and a self-assessment built only from the occasions it felt confident is
    // worse than none.
    const confidence = forecast.length === 0 ? 0.5 : clampUnit(forecast[0]?.probability ?? 0.5);
    const claim =
      forecast.length === 0
        ? 'the situation continues as it is'
        : `the world proceeds to: ${forecast[0]?.content.slice(0, 100) ?? 'unknown'}`;

    const prediction = this.#calibrator.predict(claim, confidence, {
      domain: 'world-model',
      source: 'cognition',
    });
    this.#state.pendingPrediction = prediction.id;
    this.#state.pendingConfidence = confidence;
    this.#state.pendingExpected = forecast.length === 0 ? undefined : forecast[0]?.content;

    return forecast.map((p) => p.content.slice(0, 80));
  }

  /**
   * Measure the mind against itself.
   *
   * Three things happen, and all three change future behaviour rather than
   * merely being reported:
   *
   *   · calibration is recomputed, and a badly calibrated mind's future
   *     confidences are adjusted by `adjustedConfidence`;
   *   · goals are reviewed, so a commitment that has stopped being worth it is
   *     dropped rather than carried;
   *   · consolidation runs, turning recent experience into concepts.
   */
  #reflect(): void {
    this.#reflections += 1;

    const report = this.#calibrator.report();
    let consolidation: { formed: number; reinforced: number } | undefined;

    try {
      // Episodes must be old enough to be worth generalising, which is what
      // `consolidationAgeTicks` controls. Asking immediately after an
      // experience would generalise from a single vivid moment.
      const outcome = this.#consolidation.consolidateNow();
      consolidation = { formed: outcome.conceptsFormed, reinforced: outcome.conceptsReinforced };
    } catch (error) {
      this.#kernel.bus.publish(
        'cognition:error',
        { stage: 'reflect:consolidate', error: describe(error) },
        this.#kernel.clock.current,
      );
    }

    const abandoned = this.#goals.review();

    this.#kernel.bus.publish(
      'cognition:reflection',
      {
        reflection: this.#reflections,
        calibration: {
          verdict: report.verdict,
          bias: report.bias,
          reliability: report.reliability,
          resolved: report.resolved,
        },
        consolidation: consolidation ?? null,
        abandoned: abandoned.length,
        episodes: this.#episodic.size,
        concepts: this.#semantic.size,
      },
      this.#kernel.clock.current,
    );
  }

  /** Text describing the current situation, for use as a memory cue. */
  #situationText(percepts: readonly PerceptInput[]): string {
    const parts = percepts.map((p) => p.content);
    const environment = this.#environment?.observe();
    if (environment !== undefined) {
      for (const [key, value] of Object.entries(environment)) {
        if (typeof value === 'string' || typeof value === 'number') parts.push(`${key} ${value}`);
      }
    }
    return parts.join(' ').trim();
  }

  /** The current mood, derived from what is in working memory. */
  #mood(): Affect {
    const focused = this.#working.focused();
    if (focused.length === 0) return { valence: 0, arousal: 0 };

    // No affect is stored on working-memory contents directly, so mood is read
    // from the affective colouring of recent episodes instead — which is what
    // makes it a mood rather than a reaction.
    const recent = this.#episodic.all().slice(-5);
    if (recent.length === 0) return { valence: 0, arousal: 0 };

    let valence = 0;
    let arousal = 0;
    for (const episode of recent) {
      valence += episode.affect.valence;
      arousal += episode.affect.arousal;
    }
    return { valence: valence / recent.length, arousal: arousal / recent.length };
  }

  #environmentPercepts(): readonly PerceptInput[] {
    const environment = this.#environment?.observe();
    if (environment === undefined) return [];

    const percepts: PerceptInput[] = [];
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        percepts.push({
          content: `${key} is ${String(value)}`,
          source: 'environment',
          modality: typeof value === 'number' ? 'numeric' : 'text',
          data: { [key]: value },
        });
      }
    }
    return percepts;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

const clampUnit = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Did the world arrive where the forecast said it would?
 *
 * Exact on normalised text, because the world model already groups observations
 * by similarity — a state's `content` IS the label it decided on, so the
 * forecast names the same string the observation will. Re-matching here with a
 * second, looser rule would mean two matchers that could disagree, and a
 * calibration score is only as trustworthy as the agreement it is computed
 * from.
 */
const sameState = (observed: string, expected: string): boolean =>
  observed.trim().toLowerCase() === expected.trim().toLowerCase();

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
