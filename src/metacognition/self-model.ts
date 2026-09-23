/**
 * LOGOS :: Metacognition :: Self-model and strategy selection
 * ---------------------------------------------------------------------------
 * Knowing what kind of thinker you are, and choosing how to think accordingly.
 *
 * Calibration answers "how much should I trust this confidence". This layer
 * answers a different and harder question: "given what I know about myself,
 * HOW should I go about this?"
 *
 * The premise is that the answer is EMPIRICAL rather than declared. An
 * architecture that says "use deliberate reasoning for hard problems" has
 * encoded an assumption. One that measures which strategies have actually
 * worked, on which kinds of problem, and then chooses accordingly, has learned
 * something. That difference is the whole point of this file.
 *
 * THREE THINGS ARE TRACKED, because they are the three things a mind can
 * usefully know about itself:
 *
 *   STRATEGY EFFICACY — for each strategy, on each kind of task, how well has
 *   it worked? Measured, not assumed. A strategy that reads well in a design
 *   document and loses on the evidence should lose.
 *
 *   BANDWIDTH — how much attention a strategy tends to consume before it
 *   concludes. A mind that does not know how expensive its own habits are
 *   cannot decide whether it can afford them.
 *
 *   PREDICTION CHARACTER — whether this mind tends to jump to conclusions or
 *   to dither. Estimated from the gap between how confident it acts and how
 *   often it turns out to be right on this kind of task.
 *
 * One deliberate omission: there is no "intelligence" score. A single number
 * summarising a mind would be exactly the kind of thing this architecture is
 * built to avoid — unfalsifiable, unactionable, and flattering. What is
 * reported instead is a set of measurements, each of which names a decision it
 * could change.
 */

import type { Clock } from '../kernel/clock.ts';
import type { EventBus } from '../kernel/bus.ts';
import type { Credence, Tick } from '../kernel/types.ts';
import { LogosError, clampCredence } from '../kernel/types.ts';
import type { Calibrator } from './calibration.ts';

/**
 * How a problem might be approached.
 *
 * These are not arbitrary labels. Each names a genuinely different allocation
 * of the mind's scarce resources, and the differences are what make choosing
 * between them a decision rather than a coin flip:
 */
export type Strategy =
  /** Retrieve from memory and answer with what comes back. Cheap, fast, wrong when the memory is thin. */
  | 'recall'
  /** Reason from what is already believed. Costs attention, but does not depend on the store being relevant. */
  | 'infer'
  /** Deliberately gather more evidence before committing. Expensive; the right move when confidence is low and the stakes are high. */
  | 'gather'
  /** Decompose into subproblems and work them in order. Expensive; the right move when the problem is unfamiliar. */
  | 'decompose'
  /** Hand the problem to a known skill. Cheapest of all when the skill is mastered. */
  | 'apply-skill'
  /** Decline to answer. Sometimes correct, and almost never modelled. */
  | 'defer';

/** What kind of problem was faced. Strategies are measured per kind. */
export interface ProblemProfile {
  /** A label for the domain or task type: 'diagnosis', 'arithmetic', 'social'. */
  readonly kind: string;
  /** How the problem was posed, for the record. */
  readonly description: string;
  /** Caller's estimate of the stakes, in [0,1]. `undefined` means unassessed. */
  readonly stakes?: number;
  /** Caller's sense of how familiar this kind of problem is, in [0,1]. */
  readonly familiarity?: number;
}

/** What a strategy did, recorded when the attempt concludes. */
export interface StrategyOutcome {
  readonly strategy: Strategy;
  readonly kind: string;
  readonly succeeded: boolean;
  /** Confidence the mind acted on, in [0,1]. */
  readonly confidence: Credence;
  /** Attention consumed before concluding. */
  readonly attention: number;
  readonly at: Tick;
  /** Tick the attempt began, so latency is measurable rather than merely total. */
  readonly startedAt: Tick;
  readonly detail: string;
}

/** How one strategy has performed on one kind of problem. */
export interface StrategyRecord {
  readonly strategy: Strategy;
  readonly kind: string;
  readonly attempts: number;
  readonly successes: number;
  /** Success rate in [0,1]. */
  readonly efficacy: Credence;
  /** Mean attention consumed per attempt. */
  readonly meanAttention: number;
  /** Mean ticks from start to conclusion. */
  readonly meanLatency: number;
  /**
   * Mean confidence MINUS observed success rate, on this kind of problem.
   *
   * Positive means the mind's confidence runs ahead of its accuracy here — it
   * thinks it is doing better than it is. This is the "prediction character"
   * measurement, and it is what lets a strategy be discounted for its own
   * known bias rather than only for being wrong.
   */
  readonly confidenceGap: number;
  /**
   * Expected value per unit of attention: efficacy divided by cost.
   *
   * The figure a decision should actually be made on. Not the same as efficacy,
   * and the difference matters: a strategy that is slightly worse but three
   * times cheaper is usually the right choice, and a mind that ranked by raw
   * success rate would never notice.
   */
  readonly efficiency: number;
}

export interface Recommendation {
  readonly strategy: Strategy;
  readonly reason: string;
  /** How confident the self-model is in this recommendation, in [0,1]. */
  readonly confidence: Credence;
  /** The record it was based on, when there is one. */
  readonly record: StrategyRecord | undefined;
  /** All candidates considered, best first, so the decision is inspectable. */
  readonly considered: readonly StrategyRecord[];
}

export interface SelfModelOptions {
  readonly clock: Clock;
  readonly bus: EventBus;
  /** Optional calibrator: its verdict feeds the confidence adjustment. */
  readonly calibrator?: Calibrator;
  /**
   * Attempts on a (strategy, kind) pair before its record is trusted over the
   * generic prior. Below this, selection falls back to heuristics.
   */
  readonly evidenceThreshold?: number;
  /** How much attention is treated as "cheap". Scales the efficiency figure. */
  readonly attentionScale?: number;
  /** Retained outcomes. Oldest are shed first. */
  readonly capacity?: number;
}

/** A bounded journal of what the mind concluded about itself, and when. */
export interface ReflectionEntry {
  readonly at: Tick;
  readonly kind: string;
  readonly chosen: Strategy;
  readonly reason: string;
  readonly alternative: Strategy | undefined;
  readonly detail: string;
}

interface Record_ {
  attempts: number;
  successes: number;
  attention: number;
  latency: number;
  confidenceSum: number;
  /** Recent outcomes, so a strategy that has stopped working is noticed. */
  recent: boolean[];
}

export class SelfModel {
  readonly #clock: Clock;
  readonly #bus: EventBus;
  #calibrator: Calibrator | undefined;
  readonly #evidenceThreshold: number;
  readonly #attentionScale: number;
  readonly #capacity: number;

  /** (strategy, kind) -> performance. */
  readonly #records = new Map<string, Record_>();
  /** kind -> strategies attempted on it, for enumeration. */
  readonly #kinds = new Map<string, Set<Strategy>>();
  #journal: ReflectionEntry[] = [];
  #decisions = 0;

  constructor(options: SelfModelOptions) {
    this.#clock = options.clock;
    this.#bus = options.bus;
    this.#calibrator = options.calibrator;
    this.#evidenceThreshold = Math.max(1, Math.floor(options.evidenceThreshold ?? 3));
    this.#attentionScale = Math.max(0.01, options.attentionScale ?? 1);
    this.#capacity = Math.max(16, Math.floor(options.capacity ?? 2_000));
  }

  setCalibrator(calibrator: Calibrator | undefined): void {
    this.#calibrator = calibrator;
  }

  // ── introspection ─────────────────────────────────────────────────────────

  get decisions(): number {
    return this.#decisions;
  }

  get kinds(): readonly string[] {
    return [...this.#kinds.keys()];
  }

  get journal(): readonly ReflectionEntry[] {
    return [...this.#journal];
  }

  /** Every strategy record, best efficiency first. */
  records(kind?: string): readonly StrategyRecord[] {
    const out: StrategyRecord[] = [];
    for (const [key, record] of this.#records) {
      const parsed = parseKey(key);
      if (parsed === undefined) continue;
      if (kind !== undefined && parsed.kind !== kind) continue;
      out.push(this.#view(parsed.strategy, parsed.kind, record));
    }
    return out.sort((a, b) => b.efficiency - a.efficiency || a.strategy.localeCompare(b.strategy));
  }

  record(strategy: Strategy, kind: string): StrategyRecord | undefined {
    const stored = this.#records.get(key(strategy, kind));
    return stored === undefined ? undefined : this.#view(strategy, kind, stored);
  }

  describe(): string {
    const kinds = this.kinds.length;
    const total = [...this.#records.values()].reduce((a, r) => a + r.attempts, 0);
    const best = this.records()[0];
    return (
      `self[decisions=${this.#decisions} kinds=${kinds} outcomes=${total}` +
      (best === undefined ? '' : ` best=${best.strategy}@${best.efficiency.toFixed(2)}`) +
      ']'
    );
  }

  // ── observation ───────────────────────────────────────────────────────────

  /**
   * Record what a strategy actually did.
   *
   * `attention` and latency are recorded because a mind that does not know how
   * expensive its own habits are cannot decide whether it can afford them. A
   * strategy that works 90% of the time and costs ten times as much as one that
   * works 80% of the time is usually the wrong choice, and only the cost
   * measurement reveals that.
   */
  observe(outcome: {
    readonly strategy: Strategy;
    readonly kind: string;
    readonly succeeded: boolean;
    readonly confidence: Credence;
    readonly attention: number;
    readonly startedAt: Tick;
    readonly detail?: string;
  }): StrategyOutcome {
    if (typeof outcome.kind !== 'string' || outcome.kind.trim().length === 0) {
      throw new LogosError('SELF_EMPTY_KIND', 'an outcome needs a non-empty problem kind', { outcome });
    }
    if (!Number.isFinite(outcome.attention) || outcome.attention < 0) {
      throw new LogosError('SELF_BAD_ATTENTION', 'attention must be a non-negative finite number', {
        attention: outcome.attention,
      });
    }

    const kind = outcome.kind.trim();
    const k = key(outcome.strategy, kind);
    const record = this.#records.get(k) ?? {
      attempts: 0,
      successes: 0,
      attention: 0,
      latency: 0,
      confidenceSum: 0,
      recent: [],
    };

    record.attempts += 1;
    if (outcome.succeeded) record.successes += 1;
    record.attention += outcome.attention;
    record.latency += Math.max(0, this.#clock.current - outcome.startedAt);
    record.confidenceSum += clampCredence(outcome.confidence);
    record.recent.push(outcome.succeeded);
    if (record.recent.length > 16) record.recent.shift();

    this.#records.set(k, record);
    const strategies = this.#kinds.get(kind) ?? new Set<Strategy>();
    strategies.add(outcome.strategy);
    this.#kinds.set(kind, strategies);

    const result: StrategyOutcome = Object.freeze({
      strategy: outcome.strategy,
      kind,
      succeeded: outcome.succeeded,
      confidence: clampCredence(outcome.confidence),
      attention: outcome.attention,
      at: this.#clock.current,
      startedAt: outcome.startedAt,
      detail: outcome.detail ?? (outcome.succeeded ? 'worked' : 'did not work'),
    });

    this.#bus.publish(
      'self:observed',
      {
        strategy: outcome.strategy,
        kind,
        succeeded: outcome.succeeded,
        efficacy: this.#view(outcome.strategy, kind, record).efficacy,
        efficiency: this.#view(outcome.strategy, kind, record).efficiency,
      },
      this.#clock.current,
    );

    this.#enforceCapacity();
    return result;
  }

  // ── selection ─────────────────────────────────────────────────────────────

  /**
   * Choose how to approach a problem.
   *
   * The choice is made from MEASURED performance when there is evidence, and
   * from heuristics when there is not — and the two are never blended, because
   * a heuristic that silently diluted real evidence would be worse than either
   * alone. When falling back, the recommendation says so, and says which
   * heuristic it used.
   */
  recommend(
    profile: ProblemProfile,
    options: { readonly available?: readonly Strategy[] } = {},
  ): Recommendation {
    const kind = profile.kind?.trim();
    if (kind === undefined || kind.length === 0) {
      throw new LogosError('SELF_EMPTY_KIND', 'a problem profile needs a non-empty kind', { profile });
    }

    const available = new Set<Strategy>(
      options.available ?? ['recall', 'infer', 'gather', 'decompose', 'apply-skill', 'defer'],
    );
    this.#decisions += 1;

    // ── evidence first ──
    const candidates = this.records(kind).filter(
      (r) => available.has(r.strategy) && r.attempts >= this.#evidenceThreshold,
    );

    if (candidates.length > 0) {
      const best = candidates[0] as StrategyRecord;
      const second = candidates[1];

      // A confident recommendation requires the leader to be measurably better
      // than the runner-up. Two strategies within noise of each other should
      // produce a hesitant answer, not a decisive one.
      const margin = second === undefined ? 1 : clampUnit((best.efficiency - second.efficiency) / Math.max(0.01, best.efficiency));
      const evidence = clampUnit(best.attempts / (best.attempts + 4));
      const confidence = clampUnit(0.35 + 0.4 * margin + 0.35 * evidence);

      const reason =
        second === undefined
          ? `only "${best.strategy}" has been tried on "${kind}" and it has worked ${(best.efficacy * 100).toFixed(0)}% of the time`
          : `"${best.strategy}" has worked ${(best.efficacy * 100).toFixed(0)}% of the time on "${kind}" at ` +
            `${best.meanAttention.toFixed(2)} attention per attempt, ahead of "${second.strategy}" at ` +
            `${(second.efficacy * 100).toFixed(0)}% and ${second.meanAttention.toFixed(2)}`;

      return this.#decide(kind, best.strategy, reason, confidence, best, candidates);
    }

    // ── heuristics, because there is no evidence yet ──
    const heuristic = this.#heuristic(profile, available);
    return this.#decide(kind, heuristic.strategy, heuristic.reason, heuristic.confidence, undefined, []);
  }

  /**
   * Fall back to what is plausible rather than what is measured.
   *
   * These are the assumptions a mind starts with before it has any experience
   * of its own. They are deliberately stated as assumptions and deliberately
   * unconfident, so that real evidence replaces them rather than competing with
   * them.
   */
  #heuristic(
    profile: ProblemProfile,
    available: ReadonlySet<Strategy>,
  ): { strategy: Strategy; reason: string; confidence: number } {
    const stakes = clampUnit(profile.stakes ?? 0.5);
    const familiarity = clampUnit(profile.familiarity ?? 0.5);

    const pick = (strategy: Strategy, reason: string, confidence: number): { strategy: Strategy; reason: string; confidence: number } =>
      available.has(strategy) ? { strategy, reason, confidence } : { strategy: 'defer', reason: `${reason} (but "${strategy}" is unavailable)`, confidence: 0.1 };

    // High stakes and low familiarity is the case that most deserves the
    // expensive treatment — and the case a mind without a self-model most often
    // gets wrong, by reaching for the cheap habit.
    if (stakes > 0.7 && familiarity < 0.4) {
      return pick('decompose', 'high stakes on an unfamiliar problem; the expensive route is warranted', 0.4);
    }
    if (stakes > 0.7) {
      return pick('gather', 'high stakes; more evidence is worth the attention', 0.4);
    }
    if (familiarity > 0.7 && available.has('apply-skill')) {
      return pick('apply-skill', 'a familiar problem; a practised procedure is the cheapest route', 0.4);
    }
    if (familiarity > 0.5) {
      return pick('recall', 'a familiar problem; memory is the cheapest first move', 0.3);
    }
    if (stakes < 0.3) {
      return pick('defer', 'low stakes and no familiarity; declining is defensible', 0.25);
    }
    return pick('infer', 'no strong signal either way; reasoning from what is believed', 0.25);
  }

  #decide(
    kind: string,
    strategy: Strategy,
    reason: string,
    confidence: number,
    record: StrategyRecord | undefined,
    considered: readonly StrategyRecord[],
  ): Recommendation {
    const recommendation: Recommendation = Object.freeze({
      strategy,
      reason,
      confidence: round(clampCredence(confidence)),
      record,
      considered: Object.freeze([...considered]),
    });

    this.#journal.push(
      Object.freeze({
        at: this.#clock.current,
        kind,
        chosen: strategy,
        reason,
        alternative: considered[1]?.strategy,
        detail: record === undefined ? 'from heuristic' : `from ${record.attempts} measured attempt(s)`,
      }),
    );
    if (this.#journal.length > 256) this.#journal.shift();

    this.#bus.publish(
      'self:recommended',
      {
        kind,
        strategy,
        confidence: recommendation.confidence,
        fromEvidence: record !== undefined,
        reason,
      },
      this.#clock.current,
    );

    return recommendation;
  }

  /**
   * The mind's opinion of its own confidence on a kind of problem.
   *
   * Two sources, which measure related but different things:
   *
   *   THE SELF-MODEL'S OWN GAP is a bias — a signed discrepancy between the
   *   confidence the mind acted on and how often it turned out to be right on
   *   this kind of problem. It is SUBTRACTED.
   *
   *   THE CALIBRATOR'S FIGURE is a TARGET — an already-corrected confidence
   *   value, produced by shrinking toward the observed frequency. It is moved
   *   TOWARD, not subtracted from.
   *
   * Conflating the two is a sign error with a specific and unpleasant symptom:
   * a calibrator reporting "you are overconfident, this should be 0.65" was
   * read as a bias of −0.25 and then subtracted again, producing
   * `0.9 − (−0.25 × trust)`, which raises confidence. A mind told it was
   * overconfident became more confident. The two are now applied in their own
   * proper forms.
   *
   * Both corrections are weighted by how much evidence stands behind them, so
   * a mind does not violently re-scale its self-assessment on one data point.
   */
  adjustConfidence(confidence: Credence, kind: string): Credence {
    const own = clampCredence(confidence);

    // ── the self-model's own measured bias, subtracted ──
    let adjusted = own;
    const gap = this.#confidenceGap(kind);
    if (gap !== undefined) adjusted = clampCredence(adjusted - gap);

    // ── the calibrator's target, moved toward ──
    const target = this.#calibrator?.adjustedConfidence(own, kind);
    if (target !== undefined) {
      const weight = this.#calibratorWeight();
      adjusted = clampCredence(adjusted + (target - adjusted) * weight);
    }

    return clampCredence(adjusted);
  }

  /**
   * How much weight to give the calibrator's corrected figure.
   *
   * Reads a report for a domain it has data on so the sample count is real; the
   * correction itself is domain-specific and is applied by the calibrator.
   * Zero when there is nothing to go on, which makes the calibrator abstain
   * rather than contribute a no-op.
   */
  #calibratorWeight(): number {
    const calibrator = this.#calibrator;
    if (calibrator === undefined) return 0;

    let resolved = 0;
    for (const domain of calibrator.domains) {
      const report = calibrator.report(domain);
      if (report.resolved > resolved) resolved = report.resolved;
    }
    if (resolved === 0) return 0;
    // Saturating: a large sample does not make the calibrator's opinion
    // absolute, because it is measuring a global tendency and this is one kind.
    return clampUnit(resolved / (resolved + 24));
  }

  /**
   * Mean confidence minus mean success rate across every strategy tried on a
   * kind. Undefined with too little evidence to say anything.
   */
  #confidenceGap(kind: string): number | undefined {
    let attempts = 0;
    let confidenceSum = 0;
    let successSum = 0;
    for (const [k, record] of this.#records) {
      const parsed = parseKey(k);
      if (parsed === undefined || parsed.kind !== kind) continue;
      attempts += record.attempts;
      confidenceSum += record.confidenceSum;
      successSum += record.successes;
    }
    if (attempts < this.#evidenceThreshold) return undefined;
    return clampUnit(confidenceSum / attempts) - successSum / attempts;
  }

  // ── housekeeping ──────────────────────────────────────────────────────────

  clear(): void {
    this.#records.clear();
    this.#kinds.clear();
    this.#journal = [];
    this.#decisions = 0;
  }

  check(): readonly string[] {
    const problems: string[] = [];
    for (const [k, record] of this.#records) {
      const parsed = parseKey(k);
      if (parsed === undefined) {
        problems.push(`malformed record key: ${k}`);
        continue;
      }
      if (record.successes > record.attempts) {
        problems.push(`"${parsed.strategy}" on "${parsed.kind}" has more successes than attempts`);
      }
      if (record.attempts === 0) {
        problems.push(`"${parsed.strategy}" on "${parsed.kind}" has a record with no attempts`);
      }
      if (!Number.isFinite(record.attention / record.attempts)) {
        problems.push(`"${parsed.strategy}" on "${parsed.kind}" has a non-finite mean attention`);
      }
      if (!this.#kinds.get(parsed.kind)?.has(parsed.strategy)) {
        problems.push(`"${parsed.kind}" does not list "${parsed.strategy}" among its strategies`);
      }
    }
    return problems;
  }

  #view(strategy: Strategy, kind: string, record: Record_): StrategyRecord {
    const efficacy = record.attempts === 0 ? 0 : record.successes / record.attempts;
    const meanAttention = record.attempts === 0 ? 0 : record.attention / record.attempts;
    const meanLatency = record.attempts === 0 ? 0 : record.latency / record.attempts;
    const meanConfidence = record.attempts === 0 ? 0 : record.confidenceSum / record.attempts;

    // Efficiency is success per unit of attention, scaled so that a strategy
    // costing about `attentionScale` per attempt lands near its raw efficacy.
    // Without the scale the number is unreadable; with it, 1.0 means "as good
    // as a free strategy that always works".
    const cost = Math.max(1e-6, meanAttention / this.#attentionScale);
    const efficiency = efficacy / (1 + cost);

    return Object.freeze({
      strategy,
      kind,
      attempts: record.attempts,
      successes: record.successes,
      efficacy: round(efficacy),
      meanAttention: round(meanAttention),
      meanLatency: round(meanLatency),
      confidenceGap: round(meanConfidence - efficacy),
      efficiency: round(efficiency),
    });
  }

  #enforceCapacity(): void {
    let total = 0;
    for (const record of this.#records.values()) total += record.attempts;
    if (total <= this.#capacity) return;

    // Shed the least-exercised records. A strategy tried once on a kind is a
    // hypothesis, and hypotheses are the right thing to lose first.
    const entries = [...this.#records.entries()].sort((a, b) => a[1].attempts - b[1].attempts);
    let excess = total - this.#capacity;
    for (const [k, record] of entries) {
      if (excess <= 0) break;
      this.#records.delete(k);
      const parsed = parseKey(k);
      if (parsed !== undefined) this.#kinds.get(parsed.kind)?.delete(parsed.strategy);
      excess -= record.attempts;
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

const key = (strategy: Strategy, kind: string): string => `${strategy}\u0000${kind}`;

function parseKey(k: string): { strategy: Strategy; kind: string } | undefined {
  const index = k.indexOf('\u0000');
  if (index === -1) return undefined;
  return { strategy: k.slice(0, index) as Strategy, kind: k.slice(index + 1) };
}

const clampUnit = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
