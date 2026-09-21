/**
 * LOGOS :: Metacognition :: Calibration
 * ---------------------------------------------------------------------------
 * Knowing how much to trust yourself.
 *
 * A system that reports confidence but never checks it is not self-aware, it is
 * merely expressive. Calibration is the difference: it compares what was
 * predicted at each confidence level against what actually happened, and
 * measures the gap.
 *
 * The measure used throughout is BRIER SCORE — the mean squared error of
 * probabilistic predictions, in [0,1], where 0 is perfect and 0.25 is what you
 * get by always saying 50%. It is chosen over log loss because it is bounded,
 * because it degrades gracefully rather than exploding on a single confident
 * miss, and because its decomposition into reliability and resolution is
 * exactly the distinction this module needs:
 *
 *   RELIABILITY is the calibration gap: when you said 80%, how often were you
 *   right? A system can be perfectly reliable and still useless — always saying
 *   50% about a coin is perfectly calibrated.
 *
 *   RESOLUTION is discrimination: do you say different things in different
 *   situations? A system can be sharp and badly wrong. It is the combination
 *   that matters, and reporting only one of them hides the failure mode that
 *   the other would have caught.
 *
 * Three further commitments:
 *
 *   CALIBRATION IS PER-DOMAIN. A mind can be well-calibrated about arithmetic
 *   and badly overconfident about other people. A single global score would
 *   average those into a number that describes neither, so estimates are kept
 *   per domain and a global figure is reported only as a summary.
 *
 *   THE OVERCONFIDENCE DIRECTION IS NAMED. Calibration error is signed.
 *   Overconfidence and underconfidence are different failures with different
 *   remedies — one should make a mind gather more evidence, the other should
 *   make it act on what it already has — so the sign is preserved rather than
 *   squared away.
 *
 *   ADJUSTMENT IS APPLIED, NOT JUST REPORTED. `adjustedConfidence()` returns a
 *   corrected estimate based on the measured bias, so the calibration actually
 *   changes behaviour instead of decorating a dashboard.
 */

import type { Clock } from '../kernel/clock.ts';
import type { EventBus } from '../kernel/bus.ts';
import type { Credence, Tick } from '../kernel/types.ts';
import { LogosError, clampCredence } from '../kernel/types.ts';

/** A prediction, and later the outcome that settled it. */
export interface Prediction {
  readonly id: string;
  /** What was predicted, in words. */
  readonly claim: string;
  /** Confidence at the time of the prediction, in [0,1]. */
  readonly confidence: Credence;
  /** What the prediction was about. Calibration is kept per domain. */
  readonly domain: string;
  /** Who or what produced it. Lets the mind track its own sub-agents. */
  readonly source: string;
  /** Undefined until the outcome is known. */
  readonly outcome: boolean | undefined;
  readonly at: Tick;
  readonly resolvedAt: Tick | undefined;
  readonly data: Readonly<Record<string, unknown>>;
}

/** A bucket of the reliability diagram. */
export interface CalibrationBin {
  /** Lower edge of the confidence band, in [0,1]. */
  readonly from: number;
  readonly to: number;
  readonly count: number;
  /** Mean stated confidence in this band. */
  readonly meanConfidence: number;
  /** Observed frequency of the outcome. */
  readonly frequency: number;
  /** Signed gap: positive means overconfident. */
  readonly gap: number;
}

export interface CalibrationReport {
  /** Brier score over resolved predictions, in [0,1]. Lower is better. */
  readonly brier: number;
  /** Brier score of always answering with the base rate. Higher is worse. */
  readonly baselineBrier: number;
  /** Skill over the base rate: 1 is perfect, 0 is no better than guessing. */
  readonly skill: number;
  /** Calibration error: |stated − observed| averaged over bins. */
  readonly reliability: number;
  /** Discrimination: how much the bins differ from the base rate. */
  readonly resolution: number;
  /** Mean signed error. Positive means overconfident. */
  readonly bias: number;
  readonly resolved: number;
  readonly pending: number;
  readonly bins: readonly CalibrationBin[];
  /** Plain-language verdict, for logs and self-reports. */
  readonly verdict: 'well-calibrated' | 'overconfident' | 'underconfident' | 'uninformative' | 'insufficient-data';
}

export interface CalibrationOptions {
  readonly clock: Clock;
  readonly bus: EventBus;
  /** Confidence bands in the reliability diagram. */
  readonly bins?: number;
  /** Resolved predictions required before a verdict is offered. */
  readonly minimumSamples?: number;
  /** Gap at or below which the verdict is "well-calibrated". */
  readonly tolerance?: number;
  /** Retained predictions. Oldest resolved ones are shed first. */
  readonly capacity?: number;
}

interface DomainStats {
  readonly domain: string;
  readonly predictions: Map<string, Prediction>;
}

export class Calibrator {
  readonly #clock: Clock;
  readonly #bus: EventBus;
  readonly #binCount: number;
  readonly #minimumSamples: number;
  readonly #tolerance: number;
  readonly #capacity: number;

  readonly #domains = new Map<string, DomainStats>();
  #seq = 0;
  #resolved = 0;
  #pending = 0;

  constructor(options: CalibrationOptions) {
    this.#clock = options.clock;
    this.#bus = options.bus;
    this.#binCount = Math.max(2, Math.floor(options.bins ?? 10));
    this.#minimumSamples = Math.max(1, Math.floor(options.minimumSamples ?? 8));
    this.#tolerance = clampUnit(options.tolerance ?? 0.08);
    this.#capacity = Math.max(16, Math.floor(options.capacity ?? 4_000));
  }

  // ── introspection ─────────────────────────────────────────────────────────

  get resolvedCount(): number {
    return this.#resolved;
  }

  get pendingCount(): number {
    return this.#pending;
  }

  get domains(): readonly string[] {
    return [...this.#domains.keys()];
  }

  /** Mean stated confidence of everything still unresolved. */
  get pendingConfidence(): number {
    let total = 0;
    let n = 0;
    for (const stats of this.#domains.values()) {
      for (const prediction of stats.predictions.values()) {
        if (prediction.outcome !== undefined) continue;
        total += prediction.confidence;
        n += 1;
      }
    }
    return n === 0 ? 0 : total / n;
  }

  // ── recording ─────────────────────────────────────────────────────────────

  /**
   * Record a prediction.
   *
   * Returns the id needed to resolve it later. Recording a prediction BEFORE
   * knowing the outcome is what makes calibration meaningful — a mind that
   * reconstructed its past confidence from its present knowledge would always
   * find itself well calibrated, and would have learned nothing about itself.
   */
  predict(
    claim: string,
    confidence: Credence,
    options: { readonly domain?: string; readonly source?: string; readonly data?: Record<string, unknown> } = {},
  ): Prediction {
    if (typeof claim !== 'string' || claim.trim().length === 0) {
      throw new LogosError('CALIBRATION_EMPTY_CLAIM', 'a prediction needs a non-empty claim', { claim });
    }

    this.#seq += 1;
    const id = `pred${this.#seq}`;
    const domain = options.domain ?? 'general';

    const prediction: Prediction = Object.freeze({
      id,
      claim: claim.trim(),
      confidence: clampCredence(confidence),
      domain,
      source: options.source ?? 'self',
      outcome: undefined,
      at: this.#clock.current,
      resolvedAt: undefined,
      data: Object.freeze({ ...(options.data ?? {}) }),
    });

    const stats = this.#domains.get(domain) ?? { domain, predictions: new Map<string, Prediction>() };
    stats.predictions.set(id, prediction);
    this.#domains.set(domain, stats);
    this.#pending += 1;

    this.#enforceCapacity();
    return prediction;
  }

  /**
   * Settle a prediction with its outcome.
   *
   * Returns the Brier contribution, so a caller can react immediately to a
   * particularly bad miss without waiting for a report.
   */
  resolve(id: string, outcome: boolean): number | undefined {
    for (const stats of this.#domains.values()) {
      const prediction = stats.predictions.get(id);
      if (prediction === undefined) continue;
      if (prediction.outcome !== undefined) {
        // Already settled. Re-settling would let a mind recount its successes.
        return undefined;
      }

      const resolved: Prediction = Object.freeze({
        ...prediction,
        outcome,
        resolvedAt: this.#clock.current,
      });
      stats.predictions.set(id, resolved);
      this.#pending -= 1;
      this.#resolved += 1;

      // Brier contribution: (confidence − outcome)². A confident miss costs
      // the most, which is the point.
      const actual = outcome ? 1 : 0;
      const contribution = (prediction.confidence - actual) ** 2;

      this.#bus.publish(
        'metacognition:resolved',
        {
          id,
          claim: prediction.claim.slice(0, 120),
          domain: prediction.domain,
          confidence: prediction.confidence,
          outcome,
          contribution: round(contribution),
        },
        this.#clock.current,
      );

      return contribution;
    }
    return undefined;
  }

  /**
   * Settle every unresolved prediction matching a filter.
   *
   * Used when a whole episode resolves at once — a plan either worked or did
   * not, and every prediction that depended on it settles together.
   */
  resolveWhere(filter: (prediction: Prediction) => boolean, outcome: boolean): number {
    let settled = 0;
    for (const stats of this.#domains.values()) {
      for (const prediction of [...stats.predictions.values()]) {
        if (prediction.outcome !== undefined) continue;
        if (!filter(prediction)) continue;
        if (this.resolve(prediction.id, outcome) !== undefined) settled += 1;
      }
    }
    return settled;
  }

  forget(id: string): boolean {
    for (const stats of this.#domains.values()) {
      const prediction = stats.predictions.get(id);
      if (prediction === undefined) continue;
      stats.predictions.delete(id);
      if (prediction.outcome === undefined) this.#pending -= 1;
      else this.#resolved -= 1;
      return true;
    }
    return false;
  }

  clear(): void {
    this.#domains.clear();
    this.#seq = 0;
    this.#resolved = 0;
    this.#pending = 0;
  }

  // ── measurement ───────────────────────────────────────────────────────────

  /**
   * Measure calibration, for one domain or for everything.
   *
   * The decomposition reported here is what makes the number actionable.
   * Reliability alone cannot distinguish a well-calibrated mind from a useless
   * one, and resolution alone cannot distinguish a discriminating mind from a
   * confidently wrong one. Both are reported, with skill as the summary.
   */
  report(domain?: string): CalibrationReport {
    const predictions = this.#resolvedFor(domain);
    const binCount = this.#binCount;

    if (predictions.length === 0) {
      return Object.freeze({
        brier: 0,
        baselineBrier: 0,
        skill: 0,
        reliability: 0,
        resolution: 0,
        bias: 0,
        resolved: 0,
        pending: this.#pending,
        bins: Object.freeze([]),
        verdict: 'insufficient-data',
      });
    }

    // `.map` over a `boolean` array infers `0 | 1`, and `reduce` then refuses a
    // plain-number accumulator. The explicit annotation is the fix, and it is
    // preferable to a cast because it states the intent.
    const actuals: number[] = predictions.map((p) => (p.outcome === true ? 1 : 0));
    const baseRate = actuals.reduce((a: number, b: number) => a + b, 0) / actuals.length;

    // ── Brier score ──
    let brierSum = 0;
    for (const prediction of predictions) {
      const actual = prediction.outcome === true ? 1 : 0;
      brierSum += (prediction.confidence - actual) ** 2;
    }
    const brier = brierSum / predictions.length;

    // The Brier score of the constant forecaster who always answers the base
    // rate. Expanding the definition:
    //
    //     (p - p)²·p + ((1-p) - p)²·(1-p)  =  p(1-p)
    //
    // An earlier version wrote `2p(1-p)`, which doubles it and therefore
    // reports a skill of 0.5 for a forecaster with no skill at all — the one
    // number that must never be flattering.
    const baselineBrier = baseRate * (1 - baseRate);
    // Skill over the base rate: 1 is perfect, 0 is no better than always
    // answering the base rate. Measured against the base rate rather than
    // against zero, because a base rate near 0 or 1 is trivial to predict and
    // would otherwise flatter the score.
    const skill =
      baselineBrier === 0
        ? brier === 0
          ? 1
          : 0
        : Math.max(-1, Math.min(1, 1 - brier / baselineBrier));

    // ── reliability diagram ──
    const bins: CalibrationBin[] = [];
    let reliabilitySum = 0;
    let reliabilityWeight = 0;
    let resolutionSum = 0;
    let biasSum = 0;

    for (let i = 0; i < binCount; i += 1) {
      const from = i / binCount;
      const to = (i + 1) / binCount;
      // The final bin is closed at the top so a confidence of exactly 1 lands
      // somewhere rather than being dropped.
      const inBin = predictions.filter((p) =>
        i === binCount - 1 ? p.confidence >= from && p.confidence <= to : p.confidence >= from && p.confidence < to,
      );
      if (inBin.length === 0) continue;

      const meanConfidence = inBin.reduce((a, p) => a + p.confidence, 0) / inBin.length;
      const frequency = inBin.reduce((a, p) => a + (p.outcome === true ? 1 : 0), 0) / inBin.length;
      const gap = meanConfidence - frequency;

      bins.push(
        Object.freeze({
          from: round(from),
          to: round(to),
          count: inBin.length,
          meanConfidence: round(meanConfidence),
          frequency: round(frequency),
          gap: round(gap),
        }),
      );

      reliabilitySum += inBin.length * Math.abs(gap);
      reliabilityWeight += inBin.length;
      resolutionSum += inBin.length * (frequency - baseRate) ** 2;
      biasSum += inBin.length * gap;
    }

    const reliability = reliabilityWeight === 0 ? 0 : reliabilitySum / reliabilityWeight;
    const resolution = predictions.length === 0 ? 0 : resolutionSum / predictions.length;
    const bias = predictions.length === 0 ? 0 : biasSum / predictions.length;

    return Object.freeze({
      brier: round(brier),
      baselineBrier: round(baselineBrier),
      skill: round(skill),
      reliability: round(reliability),
      resolution: round(resolution),
      bias: round(bias),
      resolved: predictions.length,
      pending: this.#pending,
      bins: Object.freeze(bins),
      verdict: this.#verdict(predictions.length, bias, reliability),
    });
  }

  /** Reports for every domain with resolved predictions, worst first. */
  reportAll(): readonly CalibrationReport[] {
    return this.domains
      .map((domain) => ({ domain, report: this.report(domain) }))
      .filter((entry) => entry.report.resolved > 0)
      .sort((a, b) => b.report.reliability - a.report.reliability)
      .map((entry) => entry.report);
  }

  /**
   * Correct a stated confidence using the measured bias.
   *
   * This is the part that makes calibration behavioural rather than decorative.
   * An overconfident mind that reports "80%" and knows it is overconfident
   * should act on something nearer 70%; one that merely displays a calibration
   * chart has learned nothing it can use.
   *
   * The correction is deliberately CONSERVATIVE — it shrinks toward the
   * observed frequency in proportion to how much evidence there is, so a mind
   * with three data points does not violently re-scale its self-assessment.
   */
  adjustedConfidence(confidence: Credence, domain?: string): Credence {
    const report = this.report(domain);
    if (report.resolved < this.#minimumSamples) return clampCredence(confidence);
    if (Math.abs(report.bias) <= this.#tolerance) return clampCredence(confidence);

    // Confidence in the correction grows with the sample size, saturating.
    const trust = clampUnit(report.resolved / (report.resolved + 24));
    const corrected = confidence - report.bias * trust;
    return clampCredence(corrected);
  }

  /**
   * How much this mind should trust its own stated confidence at a given
   * level, based on the observed frequency in that band.
   *
   * Answers "when I feel 90% sure, how often am I actually right?" — the
   * question a self-model needs to answer in order to be useful.
   */
  observedFrequency(confidence: Credence, domain?: string): number | undefined {
    const report = this.report(domain);
    const band = clampUnit(confidence);
    const bin = report.bins.find((b) => band >= b.from && band <= b.to);
    return bin === undefined ? undefined : bin.frequency;
  }

  describe(domain?: string): string {
    const report = this.report(domain);
    return (
      `calibration[${domain ?? 'all'} n=${report.resolved} brier=${report.brier.toFixed(3)} ` +
      `bias=${report.bias >= 0 ? '+' : ''}${report.bias.toFixed(3)} skill=${report.skill.toFixed(2)} ` +
      `${report.verdict}]`
    );
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #resolvedFor(domain?: string): Prediction[] {
    const out: Prediction[] = [];
    for (const stats of this.#domains.values()) {
      if (domain !== undefined && stats.domain !== domain) continue;
      for (const prediction of stats.predictions.values()) {
        if (prediction.outcome !== undefined) out.push(prediction);
      }
    }
    return out;
  }

  /**
   * Plain-language verdict.
   *
   * The sign of the bias is what distinguishes the two failure modes, and they
   * call for opposite responses: an overconfident mind needs to gather more
   * evidence before acting, an underconfident one needs to act on what it
   * already has.
   */
  #verdict(samples: number, bias: number, reliability: number): CalibrationReport['verdict'] {
    if (samples < this.#minimumSamples) return 'insufficient-data';
    if (reliability <= this.#tolerance) return 'well-calibrated';
    if (bias > this.#tolerance) return 'overconfident';
    if (bias < -this.#tolerance) return 'underconfident';
    // Large reliability with no consistent direction means the errors are
    // scattered rather than systematic — noisy, not biased.
    return 'uninformative';
  }

  #enforceCapacity(): void {
    let total = 0;
    for (const stats of this.#domains.values()) total += stats.predictions.size;
    if (total <= this.#capacity) return;

    // Shed resolved predictions first and oldest-first: the recent record is
    // what the current self-assessment should be based on.
    const resolved: { domain: string; prediction: Prediction }[] = [];
    for (const stats of this.#domains.values()) {
      for (const prediction of stats.predictions.values()) {
        if (prediction.outcome !== undefined) resolved.push({ domain: stats.domain, prediction });
      }
    }
    resolved.sort((a, b) => (a.prediction.resolvedAt ?? 0) - (b.prediction.resolvedAt ?? 0));

    const excess = total - this.#capacity;
    for (const entry of resolved.slice(0, excess)) {
      this.#domains.get(entry.domain)?.predictions.delete(entry.prediction.id);
      this.#resolved -= 1;
    }
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
