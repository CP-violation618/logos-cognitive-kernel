/**
 * LOGOS :: Memory :: Working memory
 * ---------------------------------------------------------------------------
 * The bottleneck. Everything a mind is currently *thinking about* lives here,
 * and almost nothing else does.
 *
 * Four mechanisms, none of them decorative:
 *
 * 1. HARD CAPACITY. A fixed number of slots. This is not a performance limit
 *    being modelled for realism's sake — it is the constraint that forces
 *    abstraction. A system that can hold everything never needs to form a
 *    concept.
 *
 * 2. DECAY. Activation falls off with a half-life. Unrehearsed content leaves
 *    without anything having to decide to remove it, which is what makes
 *    forgetting the default and remembering the work.
 *
 * 3. REHEARSAL, WITH DIMINISHING RETURNS. Retrieving a slot raises its
 *    activation *and lengthens its half-life*, so a rehearsed trace decays
 *    more slowly than a fresh one. This is the empirical shape of the
 *    forgetting curve, and it is why the tenth review of a fact costs less
 *    than the first.
 *
 * 4. BIASED COMPETITION. Attention is not a filter applied after the fact; it
 *    is a competition. The strongest slot does not merely survive — it
 *    actively suppresses its neighbours, so that a mind holding two similar
 *    thoughts resolves toward one of them instead of hovering between both.
 *    Top-down goals bias the competition by pre-activating matching content.
 *
 * Capacity is deliberately configurable: the folk figure is "7 ± 2", but the
 * modern replication literature puts deliberate maintenance closer to 4. The
 * default is 7 because the rest of the architecture was tuned against it, but
 * the honest number is lower and a caller who cares should say so.
 */

import type { Tick } from '../kernel/types.ts';
import { LogosError, clampCredence } from '../kernel/types.ts';
import type { SparseVector } from './vector.ts';
import { blendedSimilarity, embed, tokenize } from './vector.ts';
import type {
  Affect,
  EncodeResult,
  EncodingIntent,
  EvictionRecord,
  MemoryKind,
  WorkingMemorySnapshot,
} from './types.ts';
import { INTENT_PERSISTENCE, NEUTRAL_AFFECT, affectMagnitude, decayFactor, reinforcementGain } from './types.ts';

/** A slot is a held thought, with everything needed to reason about its fate. */
interface Slot {
  readonly id: string;
  readonly content: string;
  readonly tokens: readonly string[];
  readonly vector: SparseVector;
  readonly kind: MemoryKind;
  readonly intent: EncodingIntent;
  readonly data: Readonly<Record<string, unknown>>;

  activation: number;
  /** Retrieval confidence. Evidence, not activation: it survives decay. */
  confidence: number;
  /** Affective colouring. Replaced by a more intense re-encoding, never diluted. */
  affect: Affect;
  encodedAt: Tick;
  accessedAt: Tick;
  accessCount: number;
  /**
   * Current effective half-life in ticks. Grows with rehearsal, which is what
   * makes well-learned content persist and one-off content vanish.
   */
  halfLife: number;
  /** Instant after which the slot is dropped regardless of activation. */
  expiresAt: number | undefined;

  // ── competition bookkeeping ──
  /** How strongly attention currently favours this slot, in [0, 1]. */
  focus: number;
  /** Accumulated suppression from neighbours that won the competition. */
  inhibition: number;
  /** Top-down bias applied by `prime()`, in [0, 1]. */
  priming: number;
}

/** Per-kind baseline half-life in ticks. Procedural knowledge barely decays. */
const BASE_HALF_LIFE: Readonly<Record<MemoryKind, number>> = Object.freeze({
  working: 8,
  episodic: 40,
  semantic: 400,
  procedural: 4_000,
});

/**
 * Per-kind TTL as a multiple of half-life. Working memory has a hard limit as
 * well as a soft one: a thought that has faded to a third of its original
 * activation is gone, however recently it was touched.
 */
const TTL_HALF_LIVES: Readonly<Record<MemoryKind, number>> = Object.freeze({
  working: 4,
  episodic: 12,
  semantic: 40,
  procedural: 80,
});

/** A slot this fraction below the winner's activation is suppressed. */
const INHIBITION_RADIUS = 0.45;
/** How much activation the winner removes from a nearby competitor. */
const INHIBITION_STRENGTH = 0.3;
/** Below this activation a slot is simply gone. */
const FLOOR = 0.01;

export interface WorkingMemoryOptions {
  /** Number of slots. The attentional bottleneck, made explicit. */
  readonly capacity?: number;
  /** Similarity above which new content reinforces an existing slot. */
  readonly dedupeThreshold?: number;
  /** Baseline ticks for a half-life at zero rehearsals. */
  readonly baseHalfLife?: number;
  /** Minimum initial activation for an item to be admitted at all. */
  readonly admitThreshold?: number;
  /** Slots below this activation after a decay step are dropped. */
  readonly retainThreshold?: number;
  /** Sigmoid steepness of the admission curve. Higher = more all-or-nothing. */
  readonly salienceGain?: number;
}

export interface Priming {
  readonly text: string;
  /** Bias strength in [0, 1]. 1 fully pre-activates matching content. */
  readonly weight?: number;
  /** Optional label naming the goal doing the priming, for introspection. */
  readonly source?: string;
}

export interface WorkingMemoryStats {
  readonly capacity: number;
  readonly occupied: number;
  readonly tick: number;
  readonly meanActivation: number;
  readonly meanHalfLife: number;
  /**
   * NEW slots created. Encodes that reinforced an existing slot are counted by
   * `reinforced` instead, and refused ones by `refused`, so that
   *
   *     encodeCalls === encoded + reinforced + refused
   *
   * holds for every caller.
   */
  readonly encoded: number;
  readonly refused: number;
  readonly reinforced: number;
  readonly evicted: number;
  readonly decayed: number;
  readonly focusSize: number;
}

export class WorkingMemory {
  readonly #capacity: number;
  readonly #dedupeThreshold: number;
  readonly #baseHalfLife: number;
  readonly #admitThreshold: number;
  readonly #retainThreshold: number;
  readonly #salienceGain: number;

  #slots: Slot[] = [];
  #tick = 0;
  #seq = 0;
  #focus: string[] = [];
  #priming: Priming[] = [];

  #encoded = 0;
  #refused = 0;
  #reinforced = 0;
  #evicted = 0;
  #decayed = 0;
  /** Recent evictions, newest last. Bounded so introspection cannot leak. */
  #evictionLog: EvictionRecord[] = [];

  constructor(options: WorkingMemoryOptions = {}) {
    this.#capacity = Math.max(1, Math.floor(options.capacity ?? 7));
    this.#dedupeThreshold = clampUnit(options.dedupeThreshold ?? 0.72);
    this.#baseHalfLife = Math.max(1, options.baseHalfLife ?? 8);
    this.#admitThreshold = clampUnit(options.admitThreshold ?? 0.3);
    this.#retainThreshold = Math.max(0, options.retainThreshold ?? 0.12);
    this.#salienceGain = Math.max(0.1, options.salienceGain ?? 6);
  }

  // ── introspection ─────────────────────────────────────────────────────────

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return this.#slots.length;
  }

  get tick(): number {
    return this.#tick;
  }

  get pressure(): number {
    return this.#slots.length / this.#capacity;
  }

  /** Ids of the slots currently winning the competition, strongest first. */
  get focus(): readonly string[] {
    return [...this.#focus];
  }

  /** Current contents, strongest first. Freshly copied; safe to retain. */
  contents(): readonly { id: string; content: string; activation: number; kind: MemoryKind }[] {
    return [...this.#slots]
      .sort(byActivation)
      .map((s) => ({ id: s.id, content: s.content, activation: s.activation, kind: s.kind }));
  }

  /** The focus set, resolved to full slot data. */
  focused(): readonly { id: string; content: string; activation: number; focus: number }[] {
    const byId = new Map(this.#slots.map((s) => [s.id, s]));
    return this.#focus
      .map((id) => byId.get(id))
      .filter((s): s is Slot => s !== undefined)
      .map((s) => ({ id: s.id, content: s.content, activation: s.activation, focus: s.focus }));
  }

  has(id: string): boolean {
    return this.#slots.some((s) => s.id === id);
  }

  activationOf(id: string): number | undefined {
    return this.#slots.find((s) => s.id === id)?.activation;
  }

  evictionLog(): readonly EvictionRecord[] {
    return [...this.#evictionLog];
  }

  stats(): WorkingMemoryStats {
    const n = this.#slots.length;
    return Object.freeze({
      capacity: this.#capacity,
      occupied: n,
      tick: this.#tick,
      meanActivation: n === 0 ? 0 : this.#slots.reduce((a, s) => a + s.activation, 0) / n,
      meanHalfLife: n === 0 ? 0 : this.#slots.reduce((a, s) => a + s.halfLife, 0) / n,
      encoded: this.#encoded,
      refused: this.#refused,
      reinforced: this.#reinforced,
      evicted: this.#evicted,
      decayed: this.#decayed,
      focusSize: this.#focus.length,
    });
  }

  // ── encoding ──────────────────────────────────────────────────────────────

  /**
   * Admit a thought to working memory.
   *
   * The item competes for a slot. It may:
   *   · be refused, if its salience never reaches the admission threshold;
   *   · reinforce an existing slot, if it is similar enough to one already
   *     held (the same thought arriving twice is one thought, rehearsed);
   *   · displace the weakest slot, if it is stronger than what is there;
   *   · simply take a free slot.
   */
  encode(
    content: string,
    options: {
      readonly kind?: MemoryKind;
      readonly intent?: EncodingIntent;
      readonly confidence?: number;
      readonly affect?: Affect;
      readonly salience?: number;
      readonly data?: Record<string, unknown>;
      readonly ttlTicks?: number;
    } = {},
  ): EncodeResult {
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new LogosError('MEMORY_EMPTY_ENCODE', 'cannot encode empty content', { content });
    }

    const kind = options.kind ?? 'working';
    const intent = options.intent ?? 'observed';
    const confidence = clampCredence(options.confidence ?? 0.7);
    const affect = options.affect ?? NEUTRAL_AFFECT;
    const tokens = tokenize(content);
    const vector = embed(content);

    // Salience is what the caller asserts plus what the content itself
    // carries: affect and confidence both make a trace more likely to be held.
    const stated = clampUnit(options.salience ?? 0.5);
    const intrinsic = clampUnit(0.5 * affectMagnitude(affect) + 0.5 * confidence);
    const salience = clampUnit(0.55 * stated + 0.45 * intrinsic);

    // A sigmoid rather than a hard cutoff: near the threshold, small
    // differences in salience should produce small differences in outcome.
    const initial = clampUnit(sigmoid((salience - this.#admitThreshold) * this.#salienceGain));

    if (salience < this.#admitThreshold || initial < FLOOR) {
      this.#refused += 1;
      return Object.freeze({ reinforced: false, id: '', evicted: [], admitted: false });
    }

    // ── does this reinforce something already held? ──
    const existing = this.#mostSimilar(vector, tokens);
    if (existing !== undefined && existing.score >= this.#dedupeThreshold) {
      this.#rehearse(existing.slot, initial, confidence, affect);
      this.#reinforced += 1;
      this.#recomputeFocus();
      return Object.freeze({ reinforced: true, id: existing.slot.id, evicted: [], admitted: true });
    }

    // ── competition for a slot ──
    const evicted: EvictionRecord[] = [];
    if (this.#slots.length >= this.#capacity) {
      const weakest = [...this.#slots].sort(byActivation)[0];
      if (weakest === undefined) throw new LogosError('MEMORY_INVARIANT', 'full working memory with no slots');

      if (weakest.activation >= initial) {
        // The newcomer is not strong enough to displace anything. This is the
        // interesting case: a mind at capacity does not simply drop the oldest
        // thing, it refuses the least important new thing.
        this.#refused += 1;
        return Object.freeze({ reinforced: false, id: '', evicted: [], admitted: false });
      }

      this.#remove(weakest.id);
      evicted.push(this.#recordEviction(weakest, 'capacity'));
    }

    this.#seq += 1;
    const halfLife = this.#halfLifeFor(kind, intent, 0);
    const slot: Slot = {
      id: `wm${this.#seq}`,
      content,
      tokens,
      vector,
      kind,
      intent,
      affect,
      data: Object.freeze({ ...(options.data ?? {}) }),
      activation: initial,
      confidence,
      encodedAt: this.#asTick(),
      accessedAt: this.#asTick(),
      accessCount: 0,
      halfLife,
      expiresAt: options.ttlTicks === undefined ? this.#asTick() + halfLife * TTL_HALF_LIVES[kind] : this.#tick + options.ttlTicks,
      focus: 0,
      inhibition: 0,
      priming: 0,
    };

    this.#slots.push(slot);
    this.#encoded += 1;
    this.#recomputeFocus();

    return Object.freeze({ reinforced: false, id: slot.id, evicted, admitted: true });
  }

  /** Retrieve a slot by id, reinforcing it (the retrieval-practice effect). */
  get(id: string, options: { readonly reinforce?: boolean } = {}): Slot | undefined {
    const slot = this.#slots.find((s) => s.id === id);
    if (slot === undefined) return undefined;
    if (options.reinforce !== false) this.#rehearse(slot, slot.activation * 0.5, slot.confidence, slot.affect);
    return { ...slot };
  }

  /** Manually drop a slot. Returns what was removed, if anything. */
  forget(id: string, reason: EvictionRecord['reason'] = 'displaced'): EvictionRecord | undefined {
    const slot = this.#slots.find((s) => s.id === id);
    if (slot === undefined) return undefined;
    this.#remove(id);
    return this.#recordEviction(slot, reason);
  }

  /** Drop everything. Used on shutdown and between scenarios. */
  clear(): void {
    this.#slots = [];
    this.#focus = [];
    this.#priming = [];
    this.#evictionLog = [];
  }

  // ── attention ─────────────────────────────────────────────────────────────

  /**
   * Apply top-down bias: content similar to `text` becomes more likely to win
   * the competition. This is how a goal makes the mind notice relevant things
   * without filtering anything out.
   *
   * Priming is stored rather than applied once, because its whole point is to
   * persist across the ticks during which a goal is active.
   */
  prime(text: string, weight = 0.5, source?: string): () => void {
    const entry: Priming = source === undefined ? { text, weight } : { text, weight, source };
    this.#priming.push(entry);
    const vector = embed(text);
    const tokens = tokenize(text);

    for (const slot of this.#slots) {
      const sim = blendedSimilarity(vector, tokens, slot.vector, slot.tokens);
      slot.priming = clampUnit(Math.max(slot.priming, sim * clampUnit(weight)));
      // Priming is a genuine head start, not merely a tiebreak.
      slot.activation = clampUnit(slot.activation + slot.priming * 0.25);
    }
    this.#recomputeFocus();

    return () => {
      const i = this.#priming.indexOf(entry);
      if (i >= 0) this.#priming.splice(i, 1);
      this.#recomputeFocus();
    };
  }

  /** Active priming sources, for introspection. */
  primings(): readonly Priming[] {
    return [...this.#priming];
  }

  // ── the passage of time ───────────────────────────────────────────────────

  /**
   * Advance working memory by one logical instant: decay everything, expire
   * what has run out, recompute attention, and report what was lost.
   *
   * Returning the evictions (rather than just mutating) is what lets the layer
   * above notice that a thought slipped away — which is the trigger for
   * consolidation.
   */
  step(): readonly EvictionRecord[] {
    this.#tick += 1;
    const lost: EvictionRecord[] = [];

    for (const slot of [...this.#slots]) {
      const elapsed = 1;
      const factor = decayFactor(elapsed, slot.halfLife);
      // Priming slows decay: an attended thought is held, not merely boosted.
      const held = 1 - (1 - factor) * (1 - 0.6 * slot.priming);
      slot.activation *= held;
      slot.inhibition *= 0.85; // suppression itself fades
      this.#decayed += 1;

      const expired = slot.expiresAt !== undefined && this.#tick >= slot.expiresAt;
      if (slot.activation < FLOOR || (expired && slot.activation < this.#retainThreshold * 2)) {
        this.#remove(slot.id);
        const record = this.#recordEviction(slot, expired ? 'expired' : 'decay');
        lost.push(record);
      }
    }

    this.#recomputeFocus();
    return lost;
  }

  /** Advance `n` instants, accumulating everything lost along the way. */
  advance(n: number): readonly EvictionRecord[] {
    if (!Number.isFinite(n) || n < 1) throw new RangeError(`advance(n) requires n >= 1, received ${n}`);
    const all: EvictionRecord[] = [];
    for (let i = 0; i < Math.floor(n); i += 1) all.push(...this.step());
    return all;
  }

  // ── persistence ───────────────────────────────────────────────────────────

  snapshot(): WorkingMemorySnapshot {
    return Object.freeze({
      capacity: this.#capacity,
      tick: this.#tick,
      slots: Object.freeze(
        [...this.#slots].sort(byActivation).map((s) => ({
          id: s.id,
          content: s.content,
          strength: round(s.activation),
          kind: s.kind,
          intent: s.intent,
          accessedAt: s.accessedAt,
          accessCount: s.accessCount,
        })),
      ),
    });
  }

  /** Restore contents saved by `snapshot()`. Content is re-encoded, not trusted. */
  restore(snapshot: WorkingMemorySnapshot): void {
    this.clear();
    this.#tick = snapshot.tick;
    for (const item of snapshot.slots) {
      const result = this.encode(item.content, { kind: item.kind, intent: item.intent });
      if (!result.admitted) continue;
      const slot = this.#slots.find((s) => s.id === result.id);
      if (slot === undefined) continue;
      // Reinstate the recorded strength: the snapshot knows more about this
      // trace's history than a fresh encode can reconstruct.
      slot.activation = Math.max(slot.activation, clampUnit(item.strength));
      slot.accessCount = item.accessCount;
    }
    this.#recomputeFocus();
  }

  /** Detect internal inconsistency. Used by tests and by `health()`. */
  check(): readonly string[] {
    const problems: string[] = [];
    if (this.#slots.length > this.#capacity) {
      problems.push(`over capacity: ${this.#slots.length} > ${this.#capacity}`);
    }
    const ids = new Set<string>();
    for (const slot of this.#slots) {
      if (ids.has(slot.id)) problems.push(`duplicate slot id: ${slot.id}`);
      ids.add(slot.id);
      if (!Number.isFinite(slot.activation) || slot.activation < 0) {
        problems.push(`slot ${slot.id} has invalid activation ${slot.activation}`);
      }
      if (slot.halfLife <= 0) problems.push(`slot ${slot.id} has non-positive half-life`);
    }
    for (const id of this.#focus) {
      if (!ids.has(id)) problems.push(`focus references missing slot ${id}`);
    }
    return problems;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Similarity-weighted rehearsal of an existing slot. */
  #rehearse(slot: Slot, incoming: number, confidence: number, affect: Affect): void {
    const gain = reinforcementGain(slot.accessCount);
    slot.activation = clampUnit(slot.activation + gain * (1 - slot.activation) * (0.5 + 0.5 * incoming));
    // Consolidating evidence raises confidence toward the incoming value
    // rather than replacing it: one new observation should not overwrite a
    // well-established belief.
    const n = slot.accessCount + 1;
    slot.confidence = clampCredence(slot.confidence + (confidence - slot.confidence) / (n + 1));
    // Rehearsal stretches the half-life. This is the mechanism behind the
    // spacing effect: reviewed material becomes structurally more durable.
    slot.halfLife = this.#halfLifeFor(slot.kind, slot.intent, n) * (1 + 0.15 * Math.log1p(n));
    slot.accessedAt = this.#asTick();
    slot.accessCount = n;
    // Arousal at re-encoding leaves an affective mark.
    if (affectMagnitude(affect) > affectMagnitude(slot.affect)) {
      slot.affect = affect;
    }
  }

  #halfLifeFor(kind: MemoryKind, intent: EncodingIntent, accessCount: number): number {
    const base = kind === 'working' ? this.#baseHalfLife : BASE_HALF_LIFE[kind];
    // Intent modulates persistence; access count is applied by the caller so
    // that `encode` and `#rehearse` do not double-count.
    return Math.max(1, base * (INTENT_PERSISTENCE[intent] ?? 1) * (1 + 0.1 * Math.log1p(accessCount)));
  }

  /**
   * Biased competition.
   *
   * The strongest slot wins and suppresses neighbours whose content is
   * similar. Suppression is proportional to similarity, so a mind holding
   * "the meeting is at three" and "the meeting is at four" resolves decisively
   * toward one of them, while two unrelated thoughts coexist happily.
   */
  #recomputeFocus(): void {
    for (const slot of this.#slots) {
      slot.focus = 0;
    }
    if (this.#slots.length === 0) {
      this.#focus = [];
      return;
    }

    const ranked = [...this.#slots].sort(byActivation);
    const winner = ranked[0];
    if (winner === undefined) {
      this.#focus = [];
      return;
    }

    const suppressed = new Set<string>();
    for (const slot of ranked.slice(1)) {
      const sim = blendedSimilarity(winner.vector, winner.tokens, slot.vector, slot.tokens);
      if (sim < INHIBITION_RADIUS) continue;
      slot.inhibition = clampUnit(slot.inhibition + INHIBITION_STRENGTH * sim);
      slot.activation = Math.max(0, slot.activation * (1 - INHIBITION_STRENGTH * sim));
      suppressed.add(slot.id);
    }

    // Focus is the set of slots that are either strongly activated or
    // explicitly primed — this is the "spotlight" the rest of the kernel reads.
    const focusSize = Math.max(1, Math.ceil(this.#capacity / 2));
    const focus = [...this.#slots]
      .sort((a, b) => b.activation + b.priming - (a.activation + a.priming))
      .slice(0, focusSize);

    for (const slot of focus) {
      slot.focus = clampUnit(slot.activation + slot.priming);
    }
    this.#focus = focus.map((s) => s.id);
    void suppressed;
  }

  #mostSimilar(vector: SparseVector, tokens: readonly string[]): { slot: Slot; score: number } | undefined {
    let best: { slot: Slot; score: number } | undefined;
    for (const slot of this.#slots) {
      const score = blendedSimilarity(vector, tokens, slot.vector, slot.tokens);
      if (best === undefined || score > best.score) best = { slot, score };
    }
    return best;
  }

  #remove(id: string): void {
    const i = this.#slots.findIndex((s) => s.id === id);
    if (i >= 0) this.#slots.splice(i, 1);
    const f = this.#focus.indexOf(id);
    if (f >= 0) this.#focus.splice(f, 1);
  }

  #recordEviction(slot: Slot, reason: EvictionRecord['reason']): EvictionRecord {
    const record: EvictionRecord = Object.freeze({
      id: slot.id,
      content: slot.content,
      reason,
      strength: round(slot.activation),
      at: this.#asTick(),
    });
    this.#evicted += 1;
    this.#evictionLog.push(record);
    if (this.#evictionLog.length > 64) this.#evictionLog.shift();
    return record;
  }

  #asTick(): Tick {
    return this.#tick as Tick;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

const clampUnit = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

const byActivation = (a: Slot, b: Slot): number => b.activation - a.activation;

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
