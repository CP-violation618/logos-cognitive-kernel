/**
 * LOGOS :: Perception :: The attentional gate
 * ---------------------------------------------------------------------------
 * What gets in, and what is filtered out before it ever becomes a thought.
 *
 * The central claim of this module is that SALIENCE IS NOT INTENSITY. A bright
 * light is not interesting; a bright light when it is dark is. Salience is
 * surprise relative to expectation, and so perception cannot be computed
 * without reference to what the mind already expected — which is why the gate
 * accepts a prediction source rather than standing alone.
 *
 * Five contributions, each independently justifiable:
 *
 *   NOVELTY     — how unlike what is currently held this is. Measured against
 *                 working memory, not long-term memory: what makes something
 *                 newsworthy is that it is unlike what the mind is *currently
 *                 thinking about*.
 *   INTENSITY   — raw signal strength. The only term about the input itself
 *                 rather than about the mind receiving it, and deliberately
 *                 the weakest of the five.
 *   RELEVANCE   — similarity to an active goal. What you are looking for is
 *                 easier to see, and this is how a goal steers perception
 *                 without filtering anything out.
 *   SURPRISE    — violation of a prediction. The dominant term, because being
 *                 wrong is the single most informative thing that can happen.
 *   AFFECT      — emotional charge. Threat and reward cut through.
 *
 * Two further mechanisms keep the gate from being either a pass-through or a
 * wall:
 *
 *   HABITUATION. Response to a repeated stimulus declines with repetition and
 *   recovers only after the stimulus has been ABSENT for a full window. This
 *   is not an optimisation; it is the only reason a mind in a constant
 *   environment can notice a change in it.
 *
 *   ADAPTATION. The threshold moves in whichever direction the gate's own
 *   admission rate says it should. A gate that admits everything is as useless
 *   as one that admits nothing, and a bottleneck that is always saturated has
 *   stopped being a filter.
 */

import type { Clock } from '../kernel/clock.ts';
import type { EventBus } from '../kernel/bus.ts';
import type { KernelConfig } from '../kernel/config.ts';
import type { Rng } from '../kernel/rng.ts';
import type { PerceptionId, Tick } from '../kernel/types.ts';
import { LogosError, clampCredence, newPerceptionId } from '../kernel/types.ts';
import type { Affect } from '../memory/types.ts';
import { NEUTRAL_AFFECT, affectMagnitude } from '../memory/types.ts';
import type { WorkingMemory } from '../memory/working.ts';
import type { SparseVector } from '../memory/vector.ts';
import { blendedSimilarity, embed, tokenize } from '../memory/vector.ts';

/**
 * A perceptual channel.
 *
 * The list is deliberately short and generic. Modalities are not senses — a
 * "vision" modality would tell the rest of the architecture nothing useful,
 * whereas "novelty in the visual field" and "novelty in the audit log" are the
 * same problem and should be handled by the same code.
 */
export type Modality = 'text' | 'numeric' | 'event' | 'internal' | 'social' | 'symbolic';

/** A raw signal, before the gate has judged it. */
export interface PerceptInput {
  readonly content: string;
  readonly modality?: Modality;
  /** Where it came from — a sensor name, a source id, a channel. */
  readonly source?: string;
  /** Caller's estimate of raw strength, in [0,1]. */
  readonly intensity?: number;
  readonly affect?: Affect;
  /** Structured payload carried alongside the text. */
  readonly data?: Readonly<Record<string, unknown>>;
  /** Descriptions of goals this percept might bear on, for relevance scoring. */
  readonly goalText?: readonly string[];
}

/** A percept that has been scored but not yet admitted or rejected. */
export interface ScoredPercept {
  readonly id: PerceptionId;
  readonly content: string;
  readonly modality: Modality;
  readonly source: string;
  readonly at: Tick;
  readonly salience: number;
  /** Per-term breakdown. Exposed so a rejection is explainable. */
  readonly terms: {
    readonly novelty: number;
    readonly intensity: number;
    readonly relevance: number;
    readonly surprise: number;
    readonly affect: number;
    /** Multiplier from habituation, in [0,1]. */
    readonly habituation: number;
  };
  readonly affect: Affect;
  readonly data: Readonly<Record<string, unknown>>;
  /** The encoded form, reused by the gate so content is tokenised only once. */
  readonly vector: SparseVector;
  readonly tokens: readonly string[];
}

/** Someone who can say how wrong a percept is. Implemented by the world model. */
export interface PredictionSource {
  /**
   * Expected surprise in [0,1] for a percept, or undefined when nothing is
   * predicted. Not predicted is NOT the same as predicted-and-wrong: an
   * unpredicted event is novel, not surprising, and conflating the two would
   * make every first experience maximally alarming.
   */
  surpriseOf(percept: { content: string; source: string; modality: Modality }): number | undefined;
}

export interface GateDecision {
  readonly percept: ScoredPercept;
  readonly admitted: boolean;
  /** Why it was turned away. Empty when admitted. */
  readonly reason: '' | 'below-threshold' | 'habituated' | 'saturated';
}

export interface AttentionSnapshot {
  readonly tick: number;
  readonly threshold: number;
  readonly baseThreshold: number;
  readonly habituated: number;
  readonly admitted: number;
  readonly rejected: number;
  readonly saturated: number;
  readonly admissionRate: number;
  /** Recent decisions, newest last. Bounded. */
  readonly recent: readonly { readonly content: string; readonly salience: number; readonly admitted: boolean }[];
}

export interface PerceptionOptions {
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly config: KernelConfig;
  readonly rng: Rng;
  readonly working: WorkingMemory;
  /** Optional. Without it, the surprise term is simply absent. */
  readonly predictor?: PredictionSource;
  /** Term weights. Normalised on construction; must not all be zero. */
  readonly weights?: {
    readonly novelty?: number;
    readonly intensity?: number;
    readonly relevance?: number;
    readonly surprise?: number;
    readonly affect?: number;
  };
  /** Base admission threshold before adaptation. */
  readonly threshold?: number;
  /** Ticks of absence after which a stimulus is fully novel again. */
  readonly habituationRecoveryTicks?: number;
  /** Floor of the habituation factor. Never zero: nothing becomes invisible. */
  readonly habituationFloor?: number;
}

const DEFAULT_WEIGHTS = Object.freeze({
  novelty: 0.25,
  intensity: 0.1,
  relevance: 0.2,
  surprise: 0.35,
  affect: 0.1,
});

/** How far the threshold may deviate from its base under load, either way. */
const MAX_ADAPTATION = 0.3;
/** Adaptation increment once the running admission rate is out of band. */
const ADAPTATION_STEP = 0.03;
/** Ticks over which adaptation decays back to the base threshold. */
const ADAPTATION_DECAY = 0.9;
/** Presentations that take the habituation factor all the way to its floor. */
const HABITUATION_SATURATION = 8;

interface HabituationRecord {
  /** Times this exact stimulus has been presented. */
  count: number;
  lastAt: Tick;
  /** Instant after which the record can be pruned. */
  expiresAt: Tick;
}

export class PerceptionGate {
  readonly #clock: Clock;
  readonly #bus: EventBus;
  readonly #rng: Rng;
  readonly #working: WorkingMemory;
  readonly #config: KernelConfig;

  readonly #weights: {
    novelty: number;
    intensity: number;
    relevance: number;
    surprise: number;
    affect: number;
  };
  readonly #baseThreshold: number;
  readonly #habituationRecoveryTicks: number;
  readonly #habituationFloor: number;

  #predictor: PredictionSource | undefined;

  /** Stimulus key -> habituation. Keyed by content AND source, never by id. */
  readonly #habituation = new Map<string, HabituationRecord>();

  /** Current admission threshold, which adapts to load. */
  #threshold: number;
  /**
   * Signed adaptation pressure.
   *
   * Positive means the gate has been admitting too much and should become more
   * selective; negative means it has been turning everything away and should
   * relax. A single signed quantity because the two pressures are opposites on
   * one axis, and tracking them separately would let them both grow and cancel
   * in a way nobody could reason about.
   */
  #adaptation = 0;

  #admitted = 0;
  #rejected = 0;
  /**
   * Rejections caused by working memory being full, tracked separately.
   *
   * These are NOT decisions of the gate. Folding them into the admission rate
   * makes the gate read a capacity problem as a policy problem: when working
   * memory fills up, every further percept is refused by memory, the measured
   * rate collapses, and the gate "helpfully" lowers its bar — admitting more
   * into a memory that is already full. The gate's selectivity must be judged
   * only on the decisions the gate actually made.
   */
  #saturated = 0;
  #recent: GateDecision[] = [];
  #lastTick: Tick = 0 as Tick;

  constructor(options: PerceptionOptions) {
    this.#clock = options.clock;
    this.#bus = options.bus;
    this.#rng = options.rng;
    this.#working = options.working;
    this.#config = options.config;
    this.#predictor = options.predictor;

    const raw = { ...DEFAULT_WEIGHTS, ...withoutUndefined(options.weights ?? {}) };
    const total = raw.novelty + raw.intensity + raw.relevance + raw.surprise + raw.affect;
    if (total <= 0) {
      throw new LogosError('PERCEPTION_NO_WEIGHTS', 'perceptual term weights must not all be zero', { raw });
    }
    // Normalised so the five terms can never sum past 1, which would let
    // salience exceed its own range and make the threshold meaningless.
    this.#weights = {
      novelty: raw.novelty / total,
      intensity: raw.intensity / total,
      relevance: raw.relevance / total,
      surprise: raw.surprise / total,
      affect: raw.affect / total,
    };

    this.#baseThreshold = clampUnit(options.threshold ?? options.config.memory.attentionThreshold);
    this.#threshold = this.#baseThreshold;
    this.#habituationRecoveryTicks = Math.max(1, options.habituationRecoveryTicks ?? 30);
    this.#habituationFloor = clampUnit(options.habituationFloor ?? 0.15);

    // A revised world model invalidates the gate's accumulated stance toward
    // load, so adaptation restarts from the base policy.
    this.#bus.on('world:revised', () => {
      this.#adaptation = 0;
    });
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  /**
   * Attach or replace the prediction source.
   *
   * Kept settable because the world model is built AFTER the gate in the
   * kernel's assembly order — the gate is needed to form memories, and the
   * world model is built from memories. A constructor parameter would force a
   * circular dependency into the assembly, a worse cost than a setter.
   */
  setPredictor(predictor: PredictionSource | undefined): void {
    this.#predictor = predictor;
  }

  get threshold(): number {
    return this.#threshold;
  }

  /** Signed adaptation pressure: positive means more selective than base. */
  get adaptation(): number {
    return this.#adaptation;
  }

  get stats(): Readonly<Record<string, number>> {
    // Admission rate is over the gate's OWN decisions only — see `#saturated`.
    const decided = this.#admitted + this.#rejected;
    return Object.freeze({
      admitted: this.#admitted,
      rejected: this.#rejected,
      saturated: this.#saturated,
      admissionRate: decided === 0 ? 0 : this.#admitted / decided,
      threshold: this.#threshold,
      baseThreshold: this.#baseThreshold,
      adaptation: this.#adaptation,
      habituated: this.#habituation.size,
    });
  }

  // ── scoring ───────────────────────────────────────────────────────────────

  /**
   * Score a percept without admitting it.
   *
   * Separate from `perceive` so a caller can inspect what the gate would do —
   * useful for tuning, and for tests that need the score without the side
   * effect of a stimulus being learned.
   */
  score(input: PerceptInput): ScoredPercept {
    if (typeof input?.content !== 'string' || input.content.trim().length === 0) {
      throw new LogosError('PERCEPTION_EMPTY', 'a percept needs non-empty content', { input });
    }

    const modality = input.modality ?? 'text';
    const source = input.source ?? 'unknown';
    const affect = input.affect ?? NEUTRAL_AFFECT;
    const vector = embed(input.content);
    const tokens = tokenize(input.content);

    const novelty = this.#novelty(vector, tokens);
    const relevance = this.#relevance(input.goalText ?? [], vector, tokens);

    const predicted = this.#predictor?.surpriseOf({ content: input.content, source, modality });
    const surprise = predicted === undefined ? 0 : clampUnit(predicted);

    const habituation = this.#habituationFactor(input.content, source);
    const intensity = clampUnit(input.intensity ?? 0.5);
    const affectTerm = affectMagnitude(affect);

    const salience = clampUnit(
      habituation *
        (this.#weights.novelty * novelty +
          this.#weights.intensity * intensity +
          this.#weights.relevance * relevance +
          this.#weights.surprise * surprise +
          this.#weights.affect * affectTerm),
    );

    return Object.freeze({
      id: newPerceptionId(),
      content: input.content,
      modality,
      source,
      at: this.#clock.current,
      salience,
      terms: Object.freeze({
        novelty: round(novelty),
        intensity: round(intensity),
        relevance: round(relevance),
        surprise: round(surprise),
        affect: round(affectTerm),
        habituation: round(habituation),
      }),
      affect,
      data: Object.freeze({ ...(input.data ?? {}) }),
      vector,
      tokens: Object.freeze(tokens),
    });
  }

  /**
   * Score, decide, and — if admitted — encode into working memory.
   *
   * Admission is the only path by which outside information enters the mind,
   * so the decision is recorded on the bus whether it succeeds or fails: a
   * rejected percept is suppressed, not silently discarded.
   *
   * The ordering is load-bearing in two places:
   *
   *   · Habituation is recorded on EVERY presentation, admitted or not. A
   *     repeated stimulus that keeps being refused is exactly the case
   *     habituation exists for; learning only from admitted presentations
   *     makes the mechanism inert for the input it was built to handle.
   *
   *   · Memory's opinion is taken BEFORE encoding, through a read-only probe.
   *     A saturated working memory is then reported as saturated rather than
   *     mistaken for a decision of the gate — the two demand opposite
   *     responses, and collapsing them makes the gate read a capacity problem
   *     as a policy problem.
   */
  perceive(input: PerceptInput): GateDecision {
    const scored = this.score(input);
    const tick = this.#clock.current;

    // Learn from the presentation regardless of what happens next.
    this.#notePresentation(scored.content, scored.source, tick);

    if (scored.salience < this.#threshold) {
      const habituated = scored.terms.habituation < 0.5;
      return this.#record(scored, false, habituated ? 'habituated' : 'below-threshold');
    }

    const confidence = clampCredence(0.5 + 0.5 * scored.terms.intensity);
    const verdict = this.#working.probe(scored.content, {
      salience: scored.salience,
      confidence,
      affect: scored.affect,
    });

    if (!verdict.admitted) {
      return this.#record(scored, false, 'saturated');
    }

    this.#working.encode(scored.content, {
      kind: 'working',
      intent: 'observed',
      confidence,
      affect: scored.affect,
      salience: scored.salience,
      data: {
        modality: scored.modality,
        source: scored.source,
        surprise: scored.terms.surprise,
        novelty: scored.terms.novelty,
        ...scored.data,
      },
    });

    return this.#record(scored, true, '');
  }

  /** Score and admit in bulk, returning every decision including refusals. */
  perceiveAll(inputs: readonly PerceptInput[]): readonly GateDecision[] {
    return inputs.map((input) => this.perceive(input));
  }

  /**
   * Advance the gate by one instant: recover habituation and relax adaptation.
   *
   * Adaptation always relaxes toward the base threshold. The base is the
   * mind's considered policy; adaptation is a temporary response to conditions,
   * so it must never become the new normal. A gate that stayed permanently
   * more selective after one busy period would have quietly changed what its
   * owner is able to perceive.
   */
  step(): void {
    this.#lastTick = this.#clock.current;

    for (const [key, record] of [...this.#habituation]) {
      if (this.#lastTick >= record.expiresAt) this.#habituation.delete(key);
      void key;
    }

    this.#adaptation *= ADAPTATION_DECAY;
    if (Math.abs(this.#adaptation) < 1e-4) this.#adaptation = 0;
    this.#threshold = clampUnit(this.#baseThreshold + this.#adaptation);
  }

  /**
   * Reset habituation for one stimulus, or for everything.
   *
   * Exposed because a change in context should make the familiar novel again:
   * the same reading in a new situation is information, and a gate that stayed
   * habituated across contexts would miss it.
   */
  dishabituate(content?: string, source = 'unknown'): number {
    if (content === undefined) {
      const n = this.#habituation.size;
      this.#habituation.clear();
      return n;
    }
    return this.#habituation.delete(stimulusKey(content, source)) ? 1 : 0;
  }

  snapshot(): AttentionSnapshot {
    const decided = this.#admitted + this.#rejected;
    return Object.freeze({
      tick: this.#clock.current,
      threshold: round(this.#threshold),
      baseThreshold: round(this.#baseThreshold),
      habituated: this.#habituation.size,
      admitted: this.#admitted,
      rejected: this.#rejected,
      saturated: this.#saturated,
      admissionRate: decided === 0 ? 0 : round(this.#admitted / decided),
      recent: Object.freeze(
        this.#recent.slice(-8).map((d) => ({
          content: d.percept.content.slice(0, 40),
          salience: round(d.percept.salience),
          admitted: d.admitted,
        })),
      ),
    });
  }

  describe(): string {
    const s = this.stats;
    return (
      `gate[threshold=${(s.threshold ?? 0).toFixed(2)} ` +
      `admitted=${s.admitted} rejected=${s.rejected} saturated=${s.saturated} ` +
      `rate=${((s.admissionRate ?? 0) * 100).toFixed(0)}% ` +
      `habituated=${s.habituated}]`
    );
  }

  reset(): void {
    this.#habituation.clear();
    this.#threshold = this.#baseThreshold;
    this.#adaptation = 0;
    this.#admitted = 0;
    this.#rejected = 0;
    this.#saturated = 0;
    this.#recent = [];
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Novelty as distance from the nearest thing currently held, in [0,1].
   *
   * The raw blended similarity has a floor of `NO_OVERLAP_SIMILARITY` for text
   * sharing no vocabulary at all, so `1 - similarity` can never exceed
   * `1 - NO_OVERLAP_SIMILARITY`. Left unrescaled, genuinely unprecedented input
   * would score 0.8 for novelty and the term could never reach its own
   * maximum. Dividing by `1 - NO_OVERLAP_SIMILARITY` maps
   *
   *     similarity = 1.0  (nothing new)      -> novelty 0
   *     similarity = 0.2  (no overlap)       -> novelty 1
   *
   * which is the full range the term is supposed to span.
   */
  #novelty(vector: SparseVector, tokens: readonly string[]): number {
    const held = this.#working.contents();
    if (held.length === 0) return 1;

    let mostSimilar = 0;
    for (const item of held) {
      const score = blendedSimilarity(vector, tokens, embed(item.content), tokenize(item.content));
      if (score > mostSimilar) mostSimilar = score;
    }
    const span = Math.max(1e-6, 1 - NO_OVERLAP_SIMILARITY);
    return clampUnit((1 - mostSimilar) / span);
  }

  /** How much this percept bears on what the caller says it is pursuing. */
  #relevance(goalTexts: readonly string[], vector: SparseVector, tokens: readonly string[]): number {
    if (goalTexts.length === 0) return 0;
    let best = 0;
    for (const goal of goalTexts) {
      const score = blendedSimilarity(vector, tokens, embed(goal), tokenize(goal));
      if (score > best) best = score;
    }
    return clampUnit(best);
  }

  /**
   * Habituation factor in [floor, 1].
   *
   * A stimulus never presented scores 1. Beyond that the factor falls
   * monotonically toward the floor with the logarithm of repetition count,
   * because the first few repetitions carry almost all of the effect: the
   * second sighting of something is far less interesting than the first, and
   * the twentieth is barely different from the nineteenth.
   *
   * It recovers with ABSENCE, and only with absence. A partial recovery that
   * grew with every passing instant would mean a stimulus repeated every
   * twenty ticks never habituated at all — which is precisely the case
   * habituation exists to handle.
   */
  #habituationFactor(content: string, source: string): number {
    const record = this.#habituation.get(stimulusKey(content, source));
    if (record === undefined) return 1;

    const elapsed = this.#clock.current - record.lastAt;
    if (elapsed >= this.#habituationRecoveryTicks) return 1;

    const depth = clampUnit(Math.log1p(record.count) / Math.log(HABITUATION_SATURATION));
    return clampUnit(1 - (1 - this.#habituationFloor) * depth);
  }

  #notePresentation(content: string, source: string, tick: Tick): void {
    const key = stimulusKey(content, source);
    // A brand does not survive arithmetic, so the cast is explicit.
    const expiresAt = (tick + this.#habituationRecoveryTicks) as Tick;

    const record = this.#habituation.get(key);
    if (record === undefined) {
      this.#habituation.set(key, { count: 1, lastAt: tick, expiresAt });
      return;
    }
    record.count += 1;
    record.lastAt = tick;
    record.expiresAt = expiresAt;
  }

  #record(percept: ScoredPercept, admitted: boolean, reason: GateDecision['reason']): GateDecision {
    const decision: GateDecision = Object.freeze({ percept, admitted, reason });

    if (admitted) {
      this.#admitted += 1;
    } else if (reason === 'saturated') {
      // Memory's refusal, not the gate's. It must not influence the gate's
      // opinion of its own selectivity.
      this.#saturated += 1;
    } else {
      this.#rejected += 1;
    }

    // ── load adaptation ──
    //
    //   · MEMORY PRESSURE means the bar is too low. Working memory is the
    //     bottleneck, and filling it with marginal percepts costs the mind the
    //     capacity it needs for what matters, so the gate gets more selective.
    //   · SUSTAINED GATE REJECTION means the bar is too high. A gate that never
    //     opens is indistinguishable from blindness, so it relaxes.
    //
    // Both are needed and neither is sufficient. Responding only to memory
    // pressure would leave the gate permanently open when nothing is getting
    // through; responding only to its own admission rate leaves it helpless
    // when memory is the thing under strain. Memory pressure dominates because
    // it is the constraint that actually exists.
    //
    // Note the sign: saturation pushes the threshold UP. Folding memory's
    // refusals into the admission rate instead would do the opposite — memory
    // fills, the measured rate collapses, and the gate lowers its bar into a
    // memory that is already full.
    const pressure = this.#working.pressure;
    if (pressure >= 0.75) {
      this.#adaptation = Math.min(MAX_ADAPTATION, this.#adaptation + ADAPTATION_STEP * pressure);
    } else {
      const decided = this.#admitted + this.#rejected;
      if (decided >= 8) {
        const rate = this.#admitted / decided;
        // Only relax when memory has room. Being selective is not a fault when
        // there is nowhere to put anything.
        if (rate < 0.15) this.#adaptation = Math.max(-MAX_ADAPTATION, this.#adaptation - ADAPTATION_STEP);
        else if (rate > 0.9) this.#adaptation = Math.min(MAX_ADAPTATION, this.#adaptation + ADAPTATION_STEP * 0.5);
      }
    }
    this.#threshold = clampUnit(this.#baseThreshold + this.#adaptation);

    this.#bus.publish(
      admitted ? 'perception:admitted' : 'perception:suppressed',
      {
        id: percept.id,
        content: percept.content.slice(0, 120),
        modality: percept.modality,
        source: percept.source,
        salience: percept.salience,
        reason,
        terms: percept.terms,
      },
      percept.at,
    );

    this.#recent.push(decision);
    if (this.#recent.length > 64) this.#recent.shift();

    return decision;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * The blended-similarity floor for text with no shared vocabulary whatsoever.
 *
 * Comes from the vector channel being an average of a lexical term (which is
 * zero) and a vector term (which is 1.0 for identical zero vectors). Recorded
 * here as a named constant because the novelty transform depends on it, and a
 * magic 0.2 in the middle of a scoring function is a bug waiting to happen.
 */
const NO_OVERLAP_SIMILARITY = 0.2;

/**
 * Stimulus identity.
 *
 * Keyed by content AND source, so the same words from two different places are
 * two stimuli. A repeated alert from one sensor is habituation; the identical
 * alert arriving from a second sensor is corroboration and must not be damped.
 */
const stimulusKey = (content: string, source: string): string =>
  `${source}\u0000${content.trim().toLowerCase()}`;

const clampUnit = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Strip undefined entries so a partial override does not zero a default. */
function withoutUndefined<T extends Record<string, number | undefined>>(source: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key as keyof T] = value as T[keyof T];
  }
  return out;
}
