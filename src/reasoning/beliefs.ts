/**
 * LOGOS :: Reasoning :: Beliefs
 * ---------------------------------------------------------------------------
 * What the mind holds to be true, and how strongly.
 *
 * The central design decision is that a belief is stored in LOG-ODDS, not as a
 * probability. That is not a numerical nicety; it is what makes the rest of
 * this file possible:
 *
 *   · EVIDENCE ACCUMULATES BY ADDITION. Bayes' rule is `posterior odds =
 *     prior odds × likelihood ratio`, which in log-odds is a single sum.
 *     Evidence is therefore additive and order-independent, so the same
 *     evidence in any sequence reaches the same belief.
 *   · EVIDENCE IS RETRACTABLE. Because each item contributes a term to a sum,
 *     withdrawing one is a subtraction. A mind that cannot un-believe
 *     something after learning it was told in error is not reasoning, it is
 *     accumulating.
 *   · EXTREME BELIEFS DO NOT COLLAPSE TO CERTAINTY. Probabilities saturate at
 *     0 and 1 under repeated multiplication of floats; log-odds keep growing
 *     and are converted back only at the edges, where the clamping is honest
 *     about the resolution of a double.
 *
 * Three further commitments:
 *
 *   SOURCE INDEPENDENCE IS TRACKED, NOT ASSUMED. Ten pieces of evidence from
 *   one source is not ten pieces of evidence. Each item names its source, and
 *   corroboration is discounted by how much of the existing support already
 *   came from that direction.
 *
 *   CONTRADICTION IS A FIRST-CLASS STATE, NOT AN ERROR. A belief can be held
 *   with strong support on both sides at once. That is a genuinely different
 *   state from indifference, and downstream reasoning must be able to tell
 *   them apart: "I have no idea" and "my evidence is in violent conflict" call
 *   for completely different responses.
 *
 *   WHY IS RECORDED. Every belief can report the evidence that produced it,
 *   because a mind that holds a proposition and cannot say what it is based on
 *   cannot revise it, defend it, or explain it.
 */

import type { Clock } from '../kernel/clock.ts';
import type { EventBus } from '../kernel/bus.ts';
import type { BeliefId, Credence, Tick } from '../kernel/types.ts';
import { LogosError, clampCredence, fromLogOdds, newBeliefId, toLogOdds } from '../kernel/types.ts';

/** Which way a piece of evidence points. */
export type EvidenceStance = 'supports' | 'opposes';

/**
 * How much a piece of evidence should move a belief.
 *
 * Expressed as a likelihood ratio: how much more likely this observation would
 * be if the proposition were true than if it were false. 10 means "ten times
 * more likely under true", which is a genuinely strong piece of evidence; 2 is
 * suggestive; 1.2 is barely worth recording.
 */
export interface Evidence {
  readonly id: string;
  /** What was observed, in words. */
  readonly content: string;
  /** Where it came from. Used to discount correlated corroboration. */
  readonly source: string;
  readonly stance: EvidenceStance;
  /** Likelihood ratio >= 1. 1 means uninformative. */
  readonly strength: number;
  /** How much the SOURCE itself should be trusted, in [0,1]. */
  readonly reliability: number;
  /** Logical instant the evidence was admitted. */
  readonly at: Tick;
  readonly data: Readonly<Record<string, unknown>>;
}

/** A proposition, with everything known about it. */
export interface Belief {
  readonly id: BeliefId;
  /** The proposition, stated as a claim that could be true or false. */
  readonly proposition: string;
  /** Current credence in [0,1]. */
  readonly credence: Credence;
  /** Credence before any evidence. */
  readonly prior: Credence;
  /**
   * Credence implied by the links from other beliefs alone.
   *
   * Kept separate from the current credence so that "what I inferred" and
   * "what I was told" stay distinguishable — a mind should be able to tell
   * whether it believes something because of its own reasoning or because of
   * testimony, and revise them independently.
   */
  readonly inferential: Credence;
  /** Evidence items, most recent last. */
  readonly evidence: readonly Evidence[];
  /** Combined informativeness of the supporting evidence, unbounded above 0. */
  readonly support: number;
  /** Combined informativeness of the opposing evidence, unbounded above 0. */
  readonly opposition: number;
  /**
   * True when both sides carry substantial weight.
   *
   * Distinguishes "conflicted" from "unknown": a credence near 0.5 with high
   * support on both sides is a genuinely different epistemic state from a
   * credence near 0.5 with no evidence at all.
   */
  readonly conflicted: boolean;
  readonly updatedAt: Tick;
  readonly createdAt: Tick;
  readonly data: Readonly<Record<string, unknown>>;
}

/** How a link between two beliefs propagates credence. */
export type LinkKind = 'supports' | 'opposes';

export interface BeliefLink {
  readonly from: BeliefId;
  readonly to: BeliefId;
  readonly kind: LinkKind;
  /** Strength of the influence, in (0,1]. 1 means fully determinative. */
  readonly weight: number;
  /** How many observations established this link. */
  readonly support: number;
  readonly createdAt: Tick;
}

export interface BeliefQuery {
  readonly text?: string;
  readonly minCredence?: number;
  readonly maxCredence?: number;
  readonly conflicted?: boolean;
  readonly limit?: number;
  readonly source?: string;
}

export interface BeliefStats {
  readonly beliefs: number;
  readonly links: number;
  readonly evidence: number;
  readonly conflicted: number;
  readonly meanCredence: number;
  /** Mean credence weighted by how much evidence stands behind each belief. */
  readonly meanInformedCredence: number;
  readonly revisions: number;
}

/** Explanations for why a belief changed. */
export interface Revision {
  readonly beliefId: BeliefId;
  readonly proposition: string;
  readonly before: Credence;
  readonly after: Credence;
  readonly cause: 'evidence' | 'retraction' | 'inference' | 'prior';
  readonly detail: string;
  readonly at: Tick;
}

export interface BeliefStoreOptions {
  readonly clock: Clock;
  readonly bus: EventBus;
  /** Credence at or above which a belief counts as asserted. */
  readonly assertThreshold?: number;
  /** Credence at or below which a belief counts as denied. */
  readonly denyThreshold?: number;
  /** Support on both sides above which a belief is conflicted. */
  readonly conflictThreshold?: number;
  /** How much corroboration from one source is discounted. */
  readonly sourceDiscount?: number;
  /** Retained revisions. 0 disables the log. */
  readonly revisionLogLimit?: number;
}

interface BeliefRecord {
  id: BeliefId;
  proposition: string;
  prior: Credence;
  /** Sum of log-likelihood ratios from evidence. */
  evidenceLogOdds: number;
  /** Log-odds implied by incoming links. */
  inferentialLogOdds: number;
  evidence: Evidence[];
  links: BeliefLink[];
  support: number;
  opposition: number;
  createdAt: Tick;
  updatedAt: Tick;
  data: Record<string, unknown>;
}

export class BeliefStore {
  readonly #clock: Clock;
  readonly #bus: EventBus;
  readonly #assertThreshold: number;
  readonly #denyThreshold: number;
  readonly #conflictThreshold: number;
  readonly #sourceDiscount: number;
  readonly #revisionLogLimit: number;

  readonly #beliefs = new Map<BeliefId, BeliefRecord>();
  /** Support already contributed per (belief, source), for discounting. */
  readonly #sourceSupport = new Map<string, number>();
  #revisions: Revision[] = [];
  #revisionCount = 0;
  /** Monotonic counter, only for generating distinct ids and never exposed. */
  #beliefsSeq = 0;

  constructor(options: BeliefStoreOptions) {
    this.#clock = options.clock;
    this.#bus = options.bus;
    this.#assertThreshold = clampUnit(options.assertThreshold ?? 0.75);
    this.#denyThreshold = clampUnit(options.denyThreshold ?? 0.25);
    this.#conflictThreshold = Math.max(0, options.conflictThreshold ?? 1);
    this.#sourceDiscount = clampUnit(options.sourceDiscount ?? 0.5);
    this.#revisionLogLimit = Math.max(0, options.revisionLogLimit ?? 256);

    if (this.#denyThreshold >= this.#assertThreshold) {
      throw new LogosError('BELIEF_INCOHERENT_THRESHOLDS', 'denyThreshold must be below assertThreshold', {
        denyThreshold: this.#denyThreshold,
        assertThreshold: this.#assertThreshold,
      });
    }
  }

  // ── introspection ─────────────────────────────────────────────────────────

  get size(): number {
    return this.#beliefs.size;
  }

  get revisionCount(): number {
    return this.#revisionCount;
  }

  get revisions(): readonly Revision[] {
    return [...this.#revisions];
  }

  /** True when the belief is held with credence at or above the assert bar. */
  asserts(proposition: string): boolean {
    const belief = this.get(proposition);
    return belief !== undefined && belief.credence >= this.#assertThreshold;
  }

  /** True when the belief is held with credence at or below the deny bar. */
  denies(proposition: string): boolean {
    const belief = this.get(proposition);
    return belief !== undefined && belief.credence <= this.#denyThreshold;
  }

  /**
   * True when the mind holds no opinion worth acting on.
   *
   * Deliberately true both for the uninformed and for the deeply conflicted:
   * a mind torn between two strong bodies of evidence should not act on the
   * midpoint as though it were a settled moderate view.
   */
  isUndecided(proposition: string): boolean {
    const belief = this.get(proposition);
    if (belief === undefined) return true;
    return !this.asserts(proposition) && !this.denies(proposition);
  }

  get(proposition: string): Belief | undefined {
    const record = this.#find(proposition);
    return record === undefined ? undefined : this.#view(record);
  }

  getById(id: string): Belief | undefined {
    const record = this.#beliefs.get(id as BeliefId);
    return record === undefined ? undefined : this.#view(record);
  }

  all(): readonly Belief[] {
    return [...this.#beliefs.values()]
      .map((r) => this.#view(r))
      .filter((b): b is Belief => b !== undefined);
  }

  query(query: BeliefQuery = {}): readonly Belief[] {
    const limit = Math.max(0, query.limit ?? 20);
    const needle = query.text?.trim().toLowerCase();

    const matched = [...this.#beliefs.values()].filter((record) => {
      if (needle !== undefined && needle.length > 0 && !record.proposition.toLowerCase().includes(needle)) {
        return false;
      }
      const credence = this.#credenceOf(record);
      if (query.minCredence !== undefined && credence < query.minCredence) return false;
      if (query.maxCredence !== undefined && credence > query.maxCredence) return false;
      if (query.conflicted !== undefined && this.#isConflicted(record) !== query.conflicted) return false;
      if (query.source !== undefined && !record.evidence.some((e) => e.source === query.source)) return false;
      return true;
    });

    return matched
      .sort((a, b) => b.evidence.length - a.evidence.length || a.proposition.localeCompare(b.proposition))
      .slice(0, limit)
      .map((r) => this.#view(r))
      .filter((b): b is Belief => b !== undefined);
  }

  stats(): BeliefStats {
    const records = [...this.#beliefs.values()];
    let informed = 0;
    let informedWeight = 0;
    for (const record of records) {
      const credence = this.#credenceOf(record);
      const weight = record.evidence.length;
      informed += credence * weight;
      informedWeight += weight;
    }
    return Object.freeze({
      beliefs: records.length,
      links: records.reduce((a, r) => a + r.links.length, 0),
      evidence: records.reduce((a, r) => a + r.evidence.length, 0),
      conflicted: records.filter((r) => this.#isConflicted(r)).length,
      meanCredence: records.length === 0 ? 0 : round(records.reduce((a, r) => a + this.#credenceOf(r), 0) / records.length),
      meanInformedCredence: informedWeight === 0 ? 0 : round(informed / informedWeight),
      revisions: this.#revisionCount,
    });
  }

  describe(): string {
    const s = this.stats();
    return (
      `beliefs[n=${s.beliefs} evidence=${s.evidence} links=${s.links} ` +
      `conflicted=${s.conflicted} mean=${s.meanCredence.toFixed(3)}]`
    );
  }

  // ── belief management ─────────────────────────────────────────────────────

  /**
   * Declare a proposition and give it a prior.
   *
   * Idempotent on the proposition text: declaring an existing belief only
   * updates its prior if one is supplied, because re-declaring something must
   * not silently discard the evidence already gathered for it.
   */
  declare(proposition: string, options: { readonly prior?: Credence; readonly data?: Record<string, unknown> } = {}): Belief {
    const text = normalise(proposition);
    const existing = this.#find(text);
    if (existing !== undefined) {
      if (options.prior !== undefined) {
        this.#updatePrior(existing, clampCredence(options.prior));
      }
      if (options.data !== undefined) existing.data = { ...existing.data, ...options.data };
      return this.#view(existing) as Belief;
    }

    this.#beliefsSeq += 1;
    const record: BeliefRecord = {
      id: newBeliefId(),
      proposition: text,
      prior: clampCredence(options.prior ?? 0.5),
      evidenceLogOdds: 0,
      inferentialLogOdds: 0,
      evidence: [],
      links: [],
      support: 0,
      opposition: 0,
      createdAt: this.#clock.current,
      updatedAt: this.#clock.current,
      data: { ...(options.data ?? {}) },
    };
    this.#beliefs.set(record.id, record);
    // Prime the log-odds cache so an evidence-free belief still reports its
    // prior through the same path as every other belief.
    this.#sourceSupport.set(`${record.id}\u0000`, 0);

    this.#bus.publish(
      'belief:declared',
      { id: record.id, proposition: text, prior: record.prior },
      this.#clock.current,
    );

    return this.#view(record) as Belief;
  }

  /**
   * Add a piece of evidence and update the belief.
   *
   * The update is a single addition in log-odds, which is why the order in
   * which evidence arrives does not matter — a property worth having, because
   * a mind that reached different conclusions from the same facts in a
   * different order would be unusable.
   */
  addEvidence(
    proposition: string,
    evidence: {
      readonly content: string;
      readonly source?: string;
      readonly stance?: EvidenceStance;
      /** Likelihood ratio >= 1. */
      readonly strength?: number;
      readonly reliability?: number;
      readonly data?: Record<string, unknown>;
      /** Explicit id, so the same evidence cannot be counted twice by accident. */
      readonly id?: string;
    },
  ): Belief {
    if (typeof evidence?.content !== 'string' || evidence.content.trim().length === 0) {
      throw new LogosError('BELIEF_EMPTY_EVIDENCE', 'evidence needs non-empty content', { evidence });
    }

    const record = this.#require(proposition);
    const before = this.#credenceOf(record);

    const source = evidence.source ?? 'unspecified';
    const stance: EvidenceStance = evidence.stance ?? 'supports';
    const rawStrength = Math.max(1, evidence.strength ?? 2);
    const reliability = clampUnit(evidence.reliability ?? 1);
    const item = this.#makeEvidence(evidence, source, stance, rawStrength, reliability);

    if (record.evidence.some((e) => e.id === item.id)) {
      // Counting the same evidence twice would let a mind talk itself into
      // certainty simply by re-reading its own notes.
      return this.#view(record) as Belief;
    }

    record.evidence.push(item);
    record.updatedAt = this.#clock.current;

    // Recompute from the whole evidence set rather than adding an increment.
    // See `#recompute` for why this is not merely tidy but required.
    this.#recompute(record);

    this.#recordRevision(
      record,
      before,
      'evidence',
      `${stance} by ${source}: ${item.content.slice(0, 80)}`,
    );

    this.#bus.publish(
      'belief:updated',
      {
        id: record.id,
        proposition: record.proposition,
        before: round(before),
        after: round(this.#credenceOf(record)),
        stance,
        source,
        evidence: record.evidence.length,
      },
      this.#clock.current,
    );

    return this.#view(record) as Belief;
  }

  /**
   * Withdraw a piece of evidence by id.
   *
   * This is the operation that a probability-valued belief store cannot offer
   * cleanly: because every item contributed a term to a sum, retracting one is
   * a subtraction and the belief returns to exactly what it would have been
   * had the evidence never arrived.
   */
  retract(proposition: string, evidenceId: string): Belief | undefined {
    const record = this.#find(proposition);
    if (record === undefined) return undefined;

    const index = record.evidence.findIndex((e) => e.id === evidenceId);
    if (index === -1) return this.#view(record);

    const before = this.#credenceOf(record);
    const item = record.evidence[index] as Evidence;
    record.evidence.splice(index, 1);
    record.updatedAt = this.#clock.current;

    // Recompute from what remains, so retraction restores exactly the state
    // the belief would have been in had the evidence never arrived. This is
    // the operation a probability-valued store cannot offer cleanly.
    this.#recompute(record);

    this.#recordRevision(record, before, 'retraction', `withdrew evidence from ${item.source}`);

    this.#bus.publish(
      'belief:retracted',
      {
        id: record.id,
        proposition: record.proposition,
        evidenceId,
        before: round(before),
        after: round(this.#credenceOf(record)),
      },
      this.#clock.current,
    );

    return this.#view(record);
  }

  /** Lower or raise the prior, keeping all evidence. */
  setPrior(proposition: string, prior: Credence): Belief {
    const record = this.#require(proposition);
    const before = this.#credenceOf(record);
    this.#updatePrior(record, clampCredence(prior));
    this.#recordRevision(record, before, 'prior', `prior set to ${prior}`);
    return this.#view(record) as Belief;
  }

  forget(proposition: string): boolean {
    const record = this.#find(proposition);
    if (record === undefined) return false;

    this.#beliefs.delete(record.id);
    for (const [key] of this.#sourceSupport) {
      if (key.startsWith(`${record.id}\u0000`)) this.#sourceSupport.delete(key);
    }
    // Remove links pointing at it, from anywhere.
    for (const other of this.#beliefs.values()) {
      other.links = other.links.filter((l) => l.from !== record.id && l.to !== record.id);
    }
    // And links from it, which lived on the removed record, may still be
    // referenced by others' incoming lists — the filter above handles both
    // directions because each record keeps its own incoming list.
    return true;
  }

  clear(): void {
    this.#beliefs.clear();
    this.#sourceSupport.clear();
    this.#revisions = [];
    this.#revisionCount = 0;
    this.#beliefsSeq = 0;
  }

  check(): readonly string[] {
    const problems: string[] = [];
    for (const record of this.#beliefs.values()) {
      if (!Number.isFinite(record.evidenceLogOdds)) {
        problems.push(`belief "${record.proposition}" has non-finite evidence log-odds`);
      }
      if (record.support < 0 || record.opposition < 0) {
        problems.push(`belief "${record.proposition}" has negative support or opposition`);
      }
      const seen = new Set<string>();
      for (const item of record.evidence) {
        if (seen.has(item.id)) problems.push(`belief "${record.proposition}" has duplicate evidence id ${item.id}`);
        seen.add(item.id);
        if (item.strength < 1) problems.push(`evidence ${item.id} has strength below 1`);
      }
      for (const link of record.links) {
        if (!this.#beliefs.has(link.from)) {
          problems.push(`belief "${record.proposition}" has a link from missing belief ${link.from}`);
        }
      }
    }
    return problems;
  }

  // ── inference ─────────────────────────────────────────────────────────────

  /**
   * Connect two beliefs so that credence in one propagates to the other.
   *
   * Links carry weight and accumulate support, so a connection asserted once is
   * tentative and one observed repeatedly is firm. The propagation itself is
   * `propagate()`; this only records the connection.
   */
  link(
    from: string,
    to: string,
    kind: LinkKind = 'supports',
    options: { readonly weight?: number } = {},
  ): BeliefLink | undefined {
    const source = this.#find(from);
    const target = this.#find(to);
    if (source === undefined || target === undefined) return undefined;
    if (source.id === target.id) {
      throw new LogosError('BELIEF_SELF_LINK', 'a belief cannot link to itself', { proposition: from });
    }

    const weight = clampUnit(options.weight ?? 0.5);
    const existing = target.links.find((l) => l.from === source.id && l.kind === kind);

    if (existing !== undefined) {
      const support = existing.support + 1;
      // Weight converges toward the asserted value as support accumulates, so
      // a repeated assertion firms the link rather than merely restating it.
      const merged: BeliefLink = Object.freeze({
        from: existing.from,
        to: existing.to,
        kind: existing.kind,
        weight: clampUnit(existing.weight + (weight - existing.weight) / support),
        support,
        createdAt: existing.createdAt,
      });
      target.links = target.links.map((l) => (l === existing ? merged : l));
      return merged;
    }

    const link: BeliefLink = Object.freeze({
      from: source.id,
      to: target.id,
      kind,
      weight,
      support: 1,
      createdAt: this.#clock.current,
    });
    target.links.push(link);
    return link;
  }

  /** Incoming links of a belief, strongest first. */
  linksInto(proposition: string): readonly BeliefLink[] {
    const record = this.#find(proposition);
    if (record === undefined) return [];
    return [...record.links].sort((a, b) => b.weight - a.weight);
  }

  /**
   * Recompute inferential credence for every belief from its incoming links.
   *
   * Iterated to a fixed point, because links chain: a change to one belief
   * changes what its dependants should infer, which changes theirs. Bounded by
   * `maxIterations` and damped, because a graph with cycles has no fixed point
   * to converge to and an unbounded loop is not an option.
   *
   * The combination is NOISY-OR over supporting links and NOISY-AND-NOT over
   * opposing ones, which is the standard choice for causal networks and has the
   * property that matters here: several independent causes of the same effect
   * each raise its probability, but with diminishing returns, so the tenth
   * corroborating cause does not push it to certainty.
   */
  propagate(options: { readonly maxIterations?: number; readonly tolerance?: number; readonly damping?: number } = {}): number {
    const maxIterations = Math.max(1, Math.floor(options.maxIterations ?? 32));
    const tolerance = Math.max(1e-9, options.tolerance ?? 1e-6);
    const damping = Math.min(1, Math.max(0.05, options.damping ?? 0.6));

    const records = [...this.#beliefs.values()];
    let iterations = 0;

    for (let i = 0; i < maxIterations; i += 1) {
      iterations = i + 1;
      let maxDelta = 0;

      // Read all current inferential values first, then write, so that within
      // one sweep every node sees the same generation. Updating in place would
      // make the result depend on map iteration order.
      const current = new Map<BeliefId, number>();
      for (const record of records) current.set(record.id, fromLogOdds(record.inferentialLogOdds));

      const next = new Map<BeliefId, number>();
      for (const record of records) {
        const inferred = this.#inferFor(record, current);
        next.set(record.id, inferred);
      }

      for (const record of records) {
        const target = next.get(record.id) ?? 0.5;
        const before = fromLogOdds(record.inferentialLogOdds);
        const blended = before + (target - before) * damping;
        const delta = Math.abs(blended - before);
        if (delta > maxDelta) maxDelta = delta;
        record.inferentialLogOdds = toLogOdds(clampCredence(blended));
      }

      if (maxDelta < tolerance) break;
    }

    // One revision event per propagate() call rather than per belief: the
    // interesting fact is that inference ran and how much it moved, not the
    // blow-by-blow of every node.
    this.#bus.publish(
      'belief:inferred',
      { beliefs: records.length, iterations },
      this.#clock.current,
    );

    return iterations;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Inferential credence for one belief, given current values of the others.
   *
   * Support combines as a noisy-OR: `1 - Π(1 - wᵢ·pᵢ)`. Opposition combines
   * the same way and then acts as evidence against, so a belief with strong
   * support and strong opposition lands near the middle but carries the
   * conflict flag rather than looking like indifference.
   */
  #inferFor(record: BeliefRecord, current: ReadonlyMap<BeliefId, number>): number {
    if (record.links.length === 0) return record.prior;

    let supportProbability = 0;
    let oppositionProbability = 0;

    for (const link of record.links) {
      const sourceValue = current.get(link.from);
      if (sourceValue === undefined) continue;
      // An opposing link is evidence FOR the negation, so its contribution is
      // the credence that the source is WRONG, not that it is right.
      const contribution = link.kind === 'supports' ? sourceValue : 1 - sourceValue;
      const weighted = link.weight * contribution;
      if (link.kind === 'supports') {
        supportProbability = 1 - (1 - supportProbability) * (1 - weighted);
      } else {
        oppositionProbability = 1 - (1 - oppositionProbability) * (1 - weighted);
      }
    }

    if (supportProbability === 0 && oppositionProbability === 0) return record.prior;

    // Prior is the baseline; support and opposition move away from it.
    const positive = 1 - (1 - record.prior) * (1 - supportProbability);
    const combined = positive * (1 - oppositionProbability) + record.prior * oppositionProbability * 0.5;
    return clampCredence(combined);
  }

  /**
   * Recompute a belief's evidence contribution from its whole evidence set.
   *
   * This looks like it should be an incremental update — add a term when
   * evidence arrives, subtract it when it is withdrawn — and an earlier version
   * did exactly that. It was wrong, and wrong in a way that broke a promise the
   * class makes: EVIDENCE ORDER MUST NOT MATTER.
   *
   * Source discounting makes each item's weight depend on how much support that
   * source already has, so an incremental update makes the weight of the second
   * report from a witness depend on whether it arrived before or after an
   * unrelated report from somebody else. Measured on the same three facts in
   * three orders, the incremental version produced credences of 0.897, 0.902
   * and 0.848. A mind that reached different conclusions from the same facts in
   * a different sequence would be unusable, and no amount of documentation
   * makes it acceptable.
   *
   * So the sum is rebuilt from scratch each time, over a CANONICAL ordering of
   * the evidence: grouped by source and sorted within each source. The
   * discount for a source's nth report then depends only on that source's own
   * earlier reports, never on interleaving with others, and the result is
   * genuinely independent of arrival order.
   *
   * The cost is O(n log n) per update over one belief's evidence, which is
   * trivial at the scale a belief accumulates. Correctness of a stated
   * invariant is worth more than the constant factor.
   */
  #recompute(record: BeliefRecord): void {
    // Canonical order: by source, then by evidence id. Both are properties of
    // the items themselves, so the order is a function of the SET rather than
    // of the history.
    const ordered = [...record.evidence].sort(
      (a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id),
    );

    let evidenceLogOdds = 0;
    let support = 0;
    let opposition = 0;
    /** Informativeness already accumulated for each source, within this pass. */
    const perSource = new Map<string, number>();

    for (const item of ordered) {
      const alreadyFromSource = perSource.get(item.source) ?? 0;
      const discount = 1 / (1 + this.#sourceDiscount * alreadyFromSource);

      // Reliability damps the log-likelihood ratio rather than multiplying it,
      // so an unreliable source can never INVERT a belief — a liar who says "P"
      // is not evidence for "not P". It can only fail to move it.
      const effective = 1 + (item.strength - 1) * item.reliability * discount;
      const informativeness = this.#informativeness(item);

      if (effective > 1) {
        const term = Math.log(effective);
        if (item.stance === 'supports') evidenceLogOdds += term;
        else evidenceLogOdds -= term;
      }

      if (item.stance === 'supports') support += informativeness;
      else opposition += informativeness;

      perSource.set(item.source, alreadyFromSource + informativeness);
    }

    record.evidenceLogOdds = evidenceLogOdds;
    record.support = support;
    record.opposition = opposition;

    // Keep the per-source index in step, for callers that inspect it.
    for (const [key] of this.#sourceSupport) {
      if (key.startsWith(`${record.id}\u0000`)) this.#sourceSupport.delete(key);
    }
    for (const [source, total] of perSource) {
      this.#sourceSupport.set(`${record.id}\u0000${source}`, total);
    }
  }

  #credenceOf(record: BeliefRecord): Credence {
    const priorOdds = toLogOdds(record.prior);
    return clampCredence(fromLogOdds(priorOdds + record.evidenceLogOdds + record.inferentialLogOdds));
  }

  #isConflicted(record: BeliefRecord): boolean {
    return record.support >= this.#conflictThreshold && record.opposition >= this.#conflictThreshold;
  }

  #view(record: BeliefRecord): Belief | undefined {
    if (!this.#beliefs.has(record.id)) return undefined;
    const credence = this.#credenceOf(record);
    return Object.freeze({
      id: record.id,
      proposition: record.proposition,
      credence: round(credence),
      prior: record.prior,
      inferential: round(fromLogOdds(record.inferentialLogOdds)),
      evidence: Object.freeze([...record.evidence]),
      support: round(record.support),
      opposition: round(record.opposition),
      conflicted: this.#isConflicted(record),
      updatedAt: record.updatedAt,
      createdAt: record.createdAt,
      data: Object.freeze({ ...record.data }),
    });
  }

  #makeEvidence(
    evidence: {
      readonly content: string;
      readonly source?: string;
      readonly id?: string;
      readonly data?: Record<string, unknown>;
    },
    source: string,
    stance: EvidenceStance,
    strength: number,
    reliability: number,
  ): Evidence {
    return Object.freeze({
      // A content-derived id by default, so the same observation reported twice
      // is recognised as one observation rather than two.
      id: evidence.id ?? `ev_${stableHash(`${source}\u0000${stance}\u0000${evidence.content}`)}`,
      content: evidence.content,
      source,
      stance,
      strength,
      reliability,
      at: this.#clock.current,
      data: Object.freeze({ ...(evidence.data ?? {}) }),
    });
  }

  /**
   * How much a piece of evidence should count toward "how much do I know",
   * as distinct from "which way do I lean".
   *
   * Uses the log of the likelihood ratio: evidence that moves a belief a lot
   * is evidence that told the mind a lot, and the log scale keeps a single
   * overwhelming observation from dwarfing a hundred ordinary ones.
   */
  #informativeness(item: Evidence): number {
    return Math.log(Math.max(1, item.strength)) * item.reliability;
  }

  #find(proposition: string): BeliefRecord | undefined {
    const text = normalise(proposition);
    for (const record of this.#beliefs.values()) {
      if (record.proposition === text) return record;
    }
    return undefined;
  }

  #require(proposition: string): BeliefRecord {
    const existing = this.#find(proposition);
    if (existing !== undefined) return existing;
    this.declare(proposition);
    const created = this.#find(proposition);
    if (created === undefined) {
      throw new LogosError('BELIEF_DECLARE_FAILED', `could not declare belief: ${proposition}`, { proposition });
    }
    return created;
  }

  #updatePrior(record: BeliefRecord, prior: Credence): void {
    const before = this.#credenceOf(record);
    record.prior = prior;
    record.updatedAt = this.#clock.current;
    if (Math.abs(before - this.#credenceOf(record)) > 1e-9) {
      this.#recordRevision(record, before, 'prior', `prior changed to ${prior}`);
    }
  }

  #recordRevision(record: BeliefRecord, before: Credence, cause: Revision['cause'], detail: string): void {
    const after = this.#credenceOf(record);
    this.#revisionCount += 1;
    if (this.#revisionLogLimit === 0) return;

    this.#revisions.push(
      Object.freeze({
        beliefId: record.id,
        proposition: record.proposition,
        before: round(before),
        after: round(after),
        cause,
        detail,
        at: this.#clock.current,
      }),
    );
    if (this.#revisions.length > this.#revisionLogLimit) this.#revisions.shift();
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

const normalise = (proposition: string): string => {
  if (typeof proposition !== 'string' || proposition.trim().length === 0) {
    throw new LogosError('BELIEF_EMPTY_PROPOSITION', 'a proposition needs non-empty text', { proposition });
  }
  return proposition.trim();
};

const clampUnit = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** FNV-1a, for content-derived evidence ids. Stable across processes. */
function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
