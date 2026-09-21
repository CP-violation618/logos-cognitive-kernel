/**
 * LOGOS :: Reasoning :: World model
 * ---------------------------------------------------------------------------
 * A learned model of what follows what, and the source of surprise.
 *
 * This is the module that makes "surprise" a measurable quantity rather than a
 * metaphor. It observes the sequence of states the mind passes through, learns
 * the transition statistics between them, and can therefore be *wrong* — which
 * is the only way anything downstream can be informative.
 *
 * Three commitments shape the design:
 *
 * 1. PREDICTION IS DISTRIBUTIONAL, NOT DETERMINISTIC. The model does not
 *    output "this is what happens next". It outputs a distribution over
 *    successors, because the interesting cases are the ones where several
 *    outcomes are plausible and one of them just occurred. A model that
 *    predicted a single outcome could only be right or wrong; one that predicts
 *    a distribution can be *calibrated*, and surprise becomes the negative log
 *    probability of what actually happened rather than a flag.
 *
 * 2. UNKNOWN IS NOT SURPRISING. An observation from a state the model has never
 *    seen is novel, and novelty is handled by attention. Surprise is reserved
 *    for "I expected something and got something else". Conflating them would
 *    make every first experience maximally alarming, which is the opposite of
 *    informative.
 *
 * 3. THE MODEL KNOWS HOW MUCH IT KNOWS. Every state carries an observation
 *    count and every prediction a support count. A transition seen once is a
 *    guess; one seen a hundred times is a regularity. Downstream reasoning
 *    needs that distinction, so it is reported rather than hidden.
 *
 * The transition table is a first-order Markov chain over observed states,
 * with Laplace smoothing so that a single observation cannot make an outcome
 * certain. That is a deliberate ceiling on the model's sophistication: the
 * point of this layer is to make surprise and expectation *available*, and a
 * simple model that can be reasoned about beats a complex one that cannot.
 */

import type { Clock } from '../kernel/clock.ts';
import type { EventBus } from '../kernel/bus.ts';
import type { Rng } from '../kernel/rng.ts';
import type { Tick } from '../kernel/types.ts';
import { LogosError } from '../kernel/types.ts';
import type { SparseVector } from '../memory/vector.ts';
import { blendedSimilarity, embed, tokenize } from '../memory/vector.ts';
import type { Modality, PredictionSource } from '../perception/gate.ts';

/** One observation of the world, as the model records it. */
export interface Observation {
  readonly content: string;
  readonly source?: string;
  readonly modality?: Modality;
  /** Structured features. Numeric features are tracked for drift detection. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** A possible successor state, with how often it was seen. */
export interface Prediction {
  readonly content: string;
  /** Probability mass, in [0,1]. Sums to 1 across a prediction set. */
  readonly probability: number;
  /** Times this transition was observed. */
  readonly support: number;
  /** Mean surprise this transition has historically carried, in [0,1]. */
  readonly historicalSurprise: number;
}

/** What the model expects next, from a matched state. */
export interface Expectation {
  /** The known state the observation was matched to, if any. */
  readonly stateKey: string | undefined;
  /** How well the observation matched that state, in [0,1]. */
  readonly match: number;
  /** Ranked successors, most likely first. Empty for a terminal state. */
  readonly successors: readonly Prediction[];
  /** Observations of the matched state. Zero support means a first sighting. */
  readonly support: number;
  /** How predictable this state is: 1 = one outcome always, → 0 = uniform. */
  readonly determinism: number;
}

/** The result of showing the model something new. */
export interface PredictionOutcome {
  readonly expectation: Expectation;
  /** Surprise in [0,1]: how unlikely the observation was given its predecessor. */
  readonly surprise: number;
  /** True when the predecessor state was previously unknown. */
  readonly novel: boolean;
  /** True when the observation itself was previously unknown. */
  readonly novelObservation: boolean;
}

export interface WorldModelOptions {
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly rng: Rng;
  /** Similarity above which an observation is treated as a known state. */
  readonly matchThreshold?: number;
  /** Maximum distinct states retained. Least-observed are shed first. */
  readonly maxStates?: number;
  /** Laplace prior mass. Higher means more observations before certainty. */
  readonly smoothing?: number;
  /** Surprise above which a revision is announced on the bus. */
  readonly surpriseThreshold?: number;
}

interface StateRecord {
  readonly key: string;
  readonly content: string;
  readonly tokens: readonly string[];
  readonly vector: SparseVector;
  /** Successor key -> observation count. */
  readonly transitions: Map<string, number>;
  /** Successor key -> running mean surprise, for reporting. */
  readonly transitionSurprise: Map<string, number>;
  observations: number;
  firstSeenAt: Tick;
  lastSeenAt: Tick;
  /** Numeric feature -> running mean, for drift detection. */
  readonly numericMeans: Map<string, number>;
  readonly numericSamples: Map<string, number>;
}

export interface WorldModelStats {
  readonly states: number;
  readonly transitions: number;
  readonly observations: number;
  readonly novelObservations: number;
  readonly totalSurprise: number;
  readonly meanSurprise: number;
  readonly maxSurprise: number;
  readonly revisions: number;
  readonly meanSupport: number;
  readonly maxStates: number;
}

export class WorldModel implements PredictionSource {
  readonly #clock: Clock;
  readonly #bus: EventBus;
  readonly #rng: Rng;
  readonly #matchThreshold: number;
  readonly #maxStates: number;
  readonly #smoothing: number;
  readonly #surpriseThreshold: number;

  readonly #states = new Map<string, StateRecord>();

  #lastStateKey: string | undefined;
  #seq = 0;

  #observations = 0;
  #novelObservations = 0;
  #totalSurprise = 0;
  #maxSurprise = 0;
  #revisions = 0;

  constructor(options: WorldModelOptions) {
    this.#clock = options.clock;
    this.#bus = options.bus;
    this.#rng = options.rng;
    this.#matchThreshold = clampUnit(options.matchThreshold ?? 0.55);
    this.#maxStates = Math.max(4, Math.floor(options.maxStates ?? 2_000));
    // 0.25 is a chosen point on the confidence curve, not a default pulled from
    // the air. It makes a state observed once report its single successor at
    // probability 0.83 and determinism 0.35, while ten consistent observations
    // reach 0.98 and 0.84. Lower and the model is near-certain after one
    // sighting; higher and a well-observed regularity still looks uncertain.
    this.#smoothing = Math.max(1e-6, options.smoothing ?? 0.25);
    this.#surpriseThreshold = clampUnit(options.surpriseThreshold ?? 0.5);
  }

  // ── introspection ─────────────────────────────────────────────────────────

  get stateCount(): number {
    return this.#states.size;
  }

  get transitionCount(): number {
    let n = 0;
    for (const state of this.#states.values()) n += state.transitions.size;
    return n;
  }

  stats(): WorldModelStats {
    const states = [...this.#states.values()];
    const total = states.reduce((a, s) => a + s.observations, 0);
    return Object.freeze({
      states: states.length,
      transitions: this.transitionCount,
      observations: this.#observations,
      novelObservations: this.#novelObservations,
      totalSurprise: round(this.#totalSurprise),
      meanSurprise: this.#observations === 0 ? 0 : round(this.#totalSurprise / this.#observations),
      maxSurprise: round(this.#maxSurprise),
      revisions: this.#revisions,
      meanSupport: states.length === 0 ? 0 : round(states.reduce((a, s) => a + s.observations, 0) / states.length),
      maxStates: this.#maxStates,
    });
  }

  describe(): string {
    const s = this.stats();
    return (
      `world[states=${s.states} transitions=${s.transitions} ` +
      `obs=${s.observations} surprise=${s.meanSurprise.toFixed(3)} ` +
      `revisions=${s.revisions}]`
    );
  }

  /** The state the model currently believes the world is in. */
  currentState(): { content: string; support: number } | undefined {
    if (this.#lastStateKey === undefined) return undefined;
    const record = this.#states.get(this.#lastStateKey);
    if (record === undefined) return undefined;
    return { content: record.content, support: record.observations };
  }

  /** Every known state, most-observed first. */
  knownStates(limit = 20): readonly { readonly content: string; readonly observations: number; readonly transitions: number }[] {
    return [...this.#states.values()]
      .sort((a, b) => b.observations - a.observations)
      .slice(0, Math.max(0, limit))
      .map((s) => ({ content: s.content, observations: s.observations, transitions: s.transitions.size }));
  }

  // ── learning ──────────────────────────────────────────────────────────────

  /**
   * Show the model an observation and learn from it.
   *
   * The surprise returned is the surprise of THIS observation given the
   * previous one — computed before the transition is recorded, because
   * recording it first would make every event less surprising than it was when
   * it happened. That ordering is not a detail; getting it backwards produces
   * a model that never reports surprise above the smoothing floor.
   */
  observe(observation: Observation): PredictionOutcome {
    if (typeof observation?.content !== 'string' || observation.content.trim().length === 0) {
      throw new LogosError('WORLD_EMPTY_OBSERVATION', 'an observation needs non-empty content', { observation });
    }

    const expectation = this.expect(observation);
    const tick = this.#clock.current;

    // Compute surprise BEFORE learning, using the pre-update statistics.
    const surprise = this.#surpriseOf(expectation, observation.content);

    // ── resolve or create the state ──
    let record = expectation.stateKey === undefined ? undefined : this.#states.get(expectation.stateKey);
    const novelObservation = record === undefined;
    if (record === undefined) {
      record = this.#createState(observation.content, tick);
      this.#novelObservations += 1;
    } else {
      record.observations += 1;
      record.lastSeenAt = tick;
    }

    // ── record the transition from the previous state ──
    if (this.#lastStateKey !== undefined && this.#lastStateKey !== record.key) {
      const previous = this.#states.get(this.#lastStateKey);
      if (previous !== undefined) {
        previous.transitions.set(record.key, (previous.transitions.get(record.key) ?? 0) + 1);
        const prior = previous.transitionSurprise.get(record.key) ?? 0;
        // Running mean, so an unusual transition does not permanently label
        // the edge as surprising once it becomes common.
        const count = previous.transitions.get(record.key) ?? 1;
        previous.transitionSurprise.set(record.key, prior + (surprise - prior) / count);
      }
    }

    // ── numeric drift ──
    this.#trackNumerics(record, observation.data);

    this.#observations += 1;
    this.#totalSurprise += surprise;
    if (surprise > this.#maxSurprise) this.#maxSurprise = surprise;
    this.#lastStateKey = record.key;

    const outcome: PredictionOutcome = Object.freeze({
      expectation,
      surprise: round(surprise),
      novel: expectation.stateKey === undefined && this.#observations > 1,
      novelObservation,
    });

    this.#bus.publish(
      'world:observed',
      {
        content: observation.content.slice(0, 120),
        stateKey: record.key,
        surprise: outcome.surprise,
        novel: outcome.novelObservation,
        support: record.observations,
      },
      tick,
    );

    // ── revision ──
    //
    // Surprise above the threshold means the model's expectations are wrong in
    // a way that matters, so it announces a revision. Downstream systems use
    // that to invalidate cached assumptions — the perceptual gate resets its
    // adaptation, and planning re-plans.
    if (surprise >= this.#surpriseThreshold) {
      this.#revisions += 1;
      this.#bus.publish(
        'world:revised',
        {
          reason: 'unexpected-transition',
          surprise: outcome.surprise,
          expected: expectation.successors[0]?.content.slice(0, 80) ?? '(nothing)',
          observed: observation.content.slice(0, 80),
          stateKey: record.key,
        },
        tick,
      );
    }

    this.#enforceCapacity();
    return outcome;
  }

  /**
   * What does the model expect to follow this observation?
   *
   * Does not learn. Read-only so that a caller — the perceptual gate, a
   * planner — can consult the model's expectations without changing them.
   *
   * `successorLimit` defaults to 5, which is enough to see a branching state
   * as branching. Asking for 1 is legitimate when only the leading candidate
   * matters, but note that determinism is computed over whatever is returned,
   * so a limit of 1 reports a misleadingly predictable world.
   */
  expect(observation: Observation | string, successorLimit = 5): Expectation {
    const content = typeof observation === 'string' ? observation : observation.content;
    const match = this.#match(content);

    if (match === undefined) {
      return Object.freeze({
        stateKey: undefined,
        match: 0,
        successors: Object.freeze([]),
        support: 0,
        determinism: 0,
      });
    }

    const successors = this.#successorsOf(match.record, successorLimit);
    return Object.freeze({
      stateKey: match.record.key,
      match: round(match.score),
      successors,
      support: match.record.observations,
      determinism: determinismOf(successors),
    });
  }

  /**
   * Surprise for a percept, in the form the perceptual gate consumes.
   *
   * Returns undefined when the predecessor state is unknown, because an
   * unpredicted event is NOVEL, not surprising. Reporting a number here for an
   * unknown state would make every first experience maximally alarming and
   * destroy the gate's ability to distinguish the two.
   */
  surpriseOf(percept: { content: string; source: string; modality: Modality }): number | undefined {
    if (this.#lastStateKey === undefined) return undefined;

    const previous = this.#states.get(this.#lastStateKey);
    if (previous === undefined) return undefined;

    // Only the state the world is ACTUALLY in can generate an expectation. A
    // state with no observed successors constrains nothing, so nothing can
    // violate it — the observation is novel, not surprising, and reporting a
    // number here would manufacture surprise out of an absence of knowledge.
    if (previous.transitions.size === 0) return undefined;

    const match = this.#match(percept.content);
    if (match === undefined) {
      // The current state had expectations and this is like nothing the model
      // knows. That is a genuine violation — the world produced something
      // outside the expected set — so it is maximally surprising rather than
      // unpredicted.
      return 1;
    }

    const total = [...previous.transitions.values()].reduce((a, b) => a + b, 0);
    if (total === 0) return undefined;
    const count = previous.transitions.get(match.record.key) ?? 0;
    const probability = (count + this.#smoothing) / (total + this.#smoothing * (previous.transitions.size + 1));
    return round(clampUnit(1 - probability));
  }

  /**
   * Roll the model forward `steps` without observing anything.
   *
   * Predictions compound uncertainty: at each step the branch with the highest
   * probability is taken and its likelihood multiplied into the running
   * confidence. The result is a single imagined trajectory, not a full
   * distribution over futures — enough for planning to reason about
   * consequences, and honest about being one path rather than all of them.
   */
  predict(steps = 1): readonly Prediction[] {
    if (!Number.isFinite(steps) || steps < 1) {
      throw new RangeError(`predict(steps) requires steps >= 1, received ${steps}`);
    }

    const trajectory: Prediction[] = [];
    let cursor = this.#lastStateKey;
    let confidence = 1;

    for (let i = 0; i < Math.floor(steps); i += 1) {
      if (cursor === undefined) break;
      const record = this.#states.get(cursor);
      if (record === undefined) break;

      const best = this.#successorsOf(record, 1)[0];
      if (best === undefined) break;

      confidence *= best.probability;
      trajectory.push(
        Object.freeze({
          content: best.content,
          probability: round(confidence),
          support: best.support,
          historicalSurprise: best.historicalSurprise,
        }),
      );

      cursor = this.#keyOfContent(best.content);
    }

    return Object.freeze(trajectory);
  }

  /** Forget a state and every transition into or out of it. */
  forget(content: string): boolean {
    const match = this.#match(content);
    if (match === undefined) return false;

    const key = match.record.key;
    this.#states.delete(key);
    for (const state of this.#states.values()) {
      state.transitions.delete(key);
      state.transitionSurprise.delete(key);
    }
    if (this.#lastStateKey === key) this.#lastStateKey = undefined;
    return true;
  }

  clear(): void {
    this.#states.clear();
    this.#lastStateKey = undefined;
    this.#seq = 0;
    this.#observations = 0;
    this.#novelObservations = 0;
    this.#totalSurprise = 0;
    this.#maxSurprise = 0;
    this.#revisions = 0;
  }

  /** Detect internal inconsistency. */
  check(): readonly string[] {
    const problems: string[] = [];
    if (this.#states.size > this.#maxStates) {
      problems.push(`over capacity: ${this.#states.size} > ${this.#maxStates}`);
    }
    for (const state of this.#states.values()) {
      if (state.observations < 1) problems.push(`state ${state.key} has ${state.observations} observations`);
      for (const [target, count] of state.transitions) {
        if (!this.#states.has(target)) {
          problems.push(`state ${state.key} has a transition to unknown state ${target}`);
        }
        if (count < 1) problems.push(`state ${state.key} has a transition with count ${count}`);
      }
      if (state.transitions.size === 0 && state.observations > 1) {
        // Not an error: a state can be terminal, or only ever observed last.
        continue;
      }
    }
    if (this.#lastStateKey !== undefined && !this.#states.has(this.#lastStateKey)) {
      problems.push(`last state ${this.#lastStateKey} is not in the table`);
    }
    return problems;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Find the known state closest to an observation.
   *
   * Matching is by blended similarity rather than equality because a state is
   * a *situation*, not a string. "The pump is running at 40 Hz" and "the pump
   * is running at 41 Hz" are the same state of the world, and a model that
   * treated them as distinct would never accumulate enough support to predict
   * anything.
   */
  #match(
    content: string,
    source?: string,
    modality?: Modality,
  ): { record: StateRecord; score: number } | undefined {
    const vector = embed(content);
    const tokens = tokenize(content);
    void source;
    void modality;

    let best: { record: StateRecord; score: number } | undefined;
    for (const record of this.#states.values()) {
      const score = blendedSimilarity(vector, tokens, record.vector, record.tokens);
      if (best === undefined || score > best.score) best = { record, score };
    }
    if (best === undefined || best.score < this.#matchThreshold) return undefined;
    return best;
  }

  #keyOfContent(content: string): string | undefined {
    const match = this.#match(content);
    return match?.record.key;
  }

  #createState(content: string, tick: Tick): StateRecord {
    this.#seq += 1;
    const record: StateRecord = {
      key: `ws${this.#seq}`,
      content,
      tokens: tokenize(content),
      vector: embed(content),
      transitions: new Map(),
      transitionSurprise: new Map(),
      observations: 1,
      firstSeenAt: tick,
      lastSeenAt: tick,
      numericMeans: new Map(),
      numericSamples: new Map(),
    };
    this.#states.set(record.key, record);
    return record;
  }

  /**
   * Ranked successors of a state, with Laplace smoothing.
   *
   * Smoothing is what stops a single observation from making an outcome
   * certain. It works by reserving probability mass for ONE UNOBSERVED
   * OUTCOME, which is why the returned probabilities deliberately do not sum to
   * 1: the missing mass is the model's admission that it has not seen
   * everything. An earlier version renormalised the returned slice and thereby
   * handed that mass straight back, so a state seen once reported its single
   * successor at probability 1.0 and determinism 1.0 — maximally confident
   * after one data point, which is worse than no model at all.
   *
   * A model that is honestly unsure is more useful than one that is
   * spuriously certain, because the rest of the architecture acts on
   * `determinism` and on `surprise`.
   */
  #successorsOf(record: StateRecord, limit = 5): readonly Prediction[] {
    const total = [...record.transitions.values()].reduce((a, b) => a + b, 0);
    if (total === 0) return [];

    // Denominator includes the prior for the unobserved-outcome slot, so the
    // observed outcomes can never consume the whole distribution.
    const denominator = total + this.#smoothing * (record.transitions.size + 1);

    return Object.freeze(
      [...record.transitions.entries()]
        .map(([target, count]) => {
          const targetRecord = this.#states.get(target);
          if (targetRecord === undefined) return undefined;
          return Object.freeze({
            content: targetRecord.content,
            probability: round((count + this.#smoothing) / denominator),
            support: count,
            historicalSurprise: round(record.transitionSurprise.get(target) ?? 0),
          });
        })
        .filter((p): p is Prediction => p !== undefined)
        .sort((a, b) => b.probability - a.probability || a.content.localeCompare(b.content))
        .slice(0, Math.max(1, limit)),
    );
  }

  #surpriseOf(expectation: Expectation, observed: string): number {
    // No predecessor means nothing was expected. That is novelty, not surprise.
    if (this.#lastStateKey === undefined) return 0;
    const previous = this.#states.get(this.#lastStateKey);
    if (previous === undefined || previous.transitions.size === 0) return 0;

    // A state the model has never seen, while the previous state had
    // expectations, is a genuine violation and maximally surprising.
    if (expectation.stateKey === undefined) return 1;

    const total = [...previous.transitions.values()].reduce((a, b) => a + b, 0);
    if (total === 0) return 0;

    const count = previous.transitions.get(expectation.stateKey) ?? 0;
    const denominator = total + this.#smoothing * (previous.transitions.size + 1);
    const probability = (count + this.#smoothing) / denominator;

    // Surprise is the improbability of what actually happened, NOT 1 minus the
    // probability of the most likely thing. The difference matters: when a
    // second-placed outcome occurs the former reports a small surprise, while
    // the latter would report the same surprise as if a never-seen event had
    // occurred.
    void observed;
    return clampUnit(1 - probability);
  }

  /** Running means of numeric features, so drift is detectable. */
  #trackNumerics(record: StateRecord, data: Readonly<Record<string, unknown>> | undefined): void {
    if (data === undefined) return;
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const n = (record.numericSamples.get(key) ?? 0) + 1;
      const mean = record.numericMeans.get(key) ?? 0;
      record.numericMeans.set(key, mean + (value - mean) / n);
      record.numericSamples.set(key, n);
    }
  }

  /**
   * Shed the least-observed states when over capacity.
   *
   * Least observed rather than least recent, for the same reason consolidation
   * prefers significance over age: what the mind has seen once is a rumour, and
   * a world model built from rumours predicts nothing.
   */
  #enforceCapacity(): void {
    if (this.#states.size <= this.#maxStates) return;

    const ranked = [...this.#states.values()].sort((a, b) => a.observations - b.observations);
    const excess = this.#states.size - this.#maxStates;
    for (const victim of ranked.slice(0, excess)) {
      this.#states.delete(victim.key);
      for (const state of this.#states.values()) {
        state.transitions.delete(victim.key);
        state.transitionSurprise.delete(victim.key);
      }
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * How predictable a set of successors is, in [0,1].
 *
 * 1 means one outcome always follows; 0 means the future is maximally
 * uncertain. Reported as normalised Shannon entropy, because "the future is
 * uncertain here" is a fact the rest of the architecture should be able to act
 * on — planning should not commit to a path through a state whose successors
 * are a coin flip.
 *
 * The probability mass NOT accounted for by the observed successors is
 * included as an extra virtual outcome. That mass is the model's reservation
 * for something it has never seen, and excluding it would let a state observed
 * once report determinism 1.0 — certain about the future on the strength of a
 * single data point.
 */
function determinismOf(successors: readonly Prediction[]): number {
  if (successors.length === 0) return 0;

  const observed = successors.reduce((a, p) => a + p.probability, 0);
  const probabilities = successors.map((p) => p.probability);
  const unobserved = Math.max(0, 1 - observed);
  if (unobserved > 1e-9) probabilities.push(unobserved);

  let entropy = 0;
  for (const p of probabilities) {
    if (p > 0) entropy -= p * Math.log(p);
  }

  const maxEntropy = Math.log(probabilities.length);
  return maxEntropy === 0 ? 1 : round(clampUnit(1 - entropy / maxEntropy));
}

const clampUnit = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
