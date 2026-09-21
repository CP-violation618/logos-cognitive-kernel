/**
 * LOGOS :: Memory :: Episodic memory
 * ---------------------------------------------------------------------------
 * What happened, and when.
 *
 * Episodic memory differs from semantic memory in three ways that all matter
 * mechanically, not just taxonomically:
 *
 *   1. IT IS TIME-INDEXED. An episode knows its position in a sequence. This
 *      is what allows replay — reconstructing not just that something
 *      happened, but what led to it.
 *
 *   2. IT IS CONTEXT-BOUND. An episode is retrievable *because* the current
 *      situation resembles the situation it was encoded in. This is the
 *      mechanism behind context-dependent recall, and it is why a cue with no
 *      context match scores lower even at identical content similarity.
 *
 *   3. IT IS RECONSTRUCTIVE. This is the part most implementations get wrong.
 *      Retrieval here does not return a stored record — it *rewrites* one. A
 *      recalled episode is re-encoded at the current instant with the current
 *      context folded in, so its strength rises but its content drifts toward
 *      how it was last understood. That is reconsolidation, and it means a
 *      memory can become more confident and less accurate at the same time.
 *
 * How long an episode survives is driven by surprise and self-relevance, in
 * that order of magnitude. An unremarkable Tuesday fades in a day; the moment
 * something unexpected and personally important happened is still vivid years
 * later, and the architecture should reproduce that asymmetry rather than
 * treat every event as equally worth keeping.
 */

import type { EpisodeId, Tick } from '../kernel/types.ts';
import { LogosError, clampCredence } from '../kernel/types.ts';
import type { SparseVector } from './vector.ts';
import { blendedSimilarity, embed, tokenize } from './vector.ts';
import type { Affect, EncodingIntent, Episode } from './types.ts';
import { INTENT_PERSISTENCE, NEUTRAL_AFFECT, affectMagnitude, decayFactor } from './types.ts';

/** Internal mutable form. `Episode` is the read-only view handed out. */
interface EpisodeRecord {
  id: EpisodeId;
  content: string;
  tokens: readonly string[];
  vector: SparseVector;
  situation: string;
  context: Record<string, unknown>;
  precededBy: EpisodeId[];
  surprised: number;
  selfRelevance: number;
  affect: Affect;
  intent: EncodingIntent;
  confidence: number;
  strength: number;
  halfLife: number;
  encodedAt: Tick;
  lastAccessAt: Tick;
  accessCount: number;
  /** How many times this episode has been re-encoded by recall. */
  reconsolidations: number;
  /**
   * Instant of the most recent recall, or undefined if never recalled.
   *
   * Kept separate from `lastAccessAt` (which tracks ordinary touches) because
   * forgetting must distinguish "encoded strong" from "actively used". An
   * episode that was merely encoded is subject to decay; one that was just
   * recalled gets a full half-life of protection from that moment.
   */
  recalledAt: Tick | undefined;
  data: Record<string, unknown>;
  /** True once this episode has been folded into a semantic concept. */
  consolidated: boolean;
}

export interface EpisodicMemoryOptions {
  /** Maximum episodes retained. Excess is resolved by forgetting, not by age. */
  readonly capacity?: number;
  /** Baseline half-life in ticks for an entirely unremarkable episode. */
  readonly baseHalfLife?: number;
  /** Episodes weaker than this are eligible for forgetting. */
  readonly forgetThreshold?: number;
  /** Similarity above which recall is treated as re-encoding the same event. */
  readonly mergeThreshold?: number;
}

export interface EpisodeQuery {
  readonly text?: string;
  /** Situation label to match, weighted heavily as an episodic cue. */
  readonly situation?: string;
  /** Context key/values that must match exactly. */
  readonly context?: Readonly<Record<string, unknown>>;
  readonly mood?: Affect;
  readonly limit?: number;
  readonly threshold?: number;
  readonly since?: Tick;
  readonly until?: Tick;
  readonly exclude?: readonly string[];
  /** Include episodes already consolidated into semantic memory. */
  readonly includeConsolidated?: boolean;
}

export interface EpisodeHit {
  readonly episode: Episode;
  readonly score: number;
  readonly components: {
    readonly similarity: number;
    readonly contextMatch: number;
    readonly strength: number;
    readonly recency: number;
    readonly affect: number;
  };
}

export interface EpisodicStats {
  readonly count: number;
  readonly capacity: number;
  readonly tick: number;
  readonly encoded: number;
  readonly recalled: number;
  readonly reconsolidated: number;
  readonly forgotten: number;
  readonly consolidated: number;
  readonly meanStrength: number;
  readonly meanSurprise: number;
  readonly oldestTick: number | null;
}

export class EpisodicMemory {
  readonly #capacity: number;
  readonly #baseHalfLife: number;
  readonly #forgetThreshold: number;
  readonly #mergeThreshold: number;

  #episodes = new Map<EpisodeId, EpisodeRecord>();
  /** Chronological order of ids currently retained, oldest first. */
  #order: EpisodeId[] = [];
  #tick = 0;
  #seq = 0;

  #encoded = 0;
  #recalled = 0;
  #reconsolidated = 0;
  #forgotten = 0;

  constructor(options: EpisodicMemoryOptions = {}) {
    this.#capacity = Math.max(1, Math.floor(options.capacity ?? 2_000));
    this.#baseHalfLife = Math.max(1, options.baseHalfLife ?? 400);
    this.#forgetThreshold = Math.max(0, options.forgetThreshold ?? 0.05);
    this.#mergeThreshold = Math.min(1, Math.max(0, options.mergeThreshold ?? 0.93));
  }

  // ── introspection ─────────────────────────────────────────────────────────

  get size(): number {
    return this.#episodes.size;
  }

  get tick(): number {
    return this.#tick;
  }

  get capacity(): number {
    return this.#capacity;
  }

  /** The most recent episode, or undefined for a blank memory. */
  latest(): Episode | undefined {
    const id = this.#order.at(-1);
    return id === undefined ? undefined : this.#view(id);
  }

  /** The earliest retained episode. */
  earliest(): Episode | undefined {
    const id = this.#order[0];
    return id === undefined ? undefined : this.#view(id);
  }

  get(id: string): Episode | undefined {
    return this.#view(id as EpisodeId);
  }

  stats(): EpisodicStats {
    const list = [...this.#episodes.values()];
    return Object.freeze({
      count: list.length,
      capacity: this.#capacity,
      tick: this.#tick,
      encoded: this.#encoded,
      recalled: this.#recalled,
      reconsolidated: this.#reconsolidated,
      forgotten: this.#forgotten,
      consolidated: list.filter((e) => e.consolidated).length,
      meanStrength: list.length === 0 ? 0 : list.reduce((a, e) => a + e.strength, 0) / list.length,
      meanSurprise: list.length === 0 ? 0 : list.reduce((a, e) => a + e.surprised, 0) / list.length,
      oldestTick: list.length === 0 ? null : Math.min(...list.map((e) => e.encodedAt)),
    });
  }

  // ── encoding ──────────────────────────────────────────────────────────────

  /**
   * Record an experience.
   *
   * Returns the id, plus a flag when the experience was similar enough to an
   * existing recent episode that it was treated as a continuation rather than
   * a new event — the difference between "I read three paragraphs" and "I read
   * a document".
   */
  encode(
    content: string,
    options: {
      readonly situation?: string;
      readonly context?: Record<string, unknown>;
      readonly precededBy?: EpisodeId[];
      readonly surprise?: number;
      readonly selfRelevance?: number;
      readonly affect?: Affect;
      readonly intent?: EncodingIntent;
      readonly confidence?: number;
      readonly salience?: number;
      readonly data?: Record<string, unknown>;
      readonly mergeWindow?: number;
    } = {},
  ): { readonly id: EpisodeId; readonly merged: boolean } {
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new LogosError('EPISODIC_EMPTY_ENCODE', 'cannot encode an empty episode', { content });
    }

    const situation = options.situation ?? 'unspecified';
    const surprise = clampUnit(options.surprise ?? 0);
    const selfRelevance = clampUnit(options.selfRelevance ?? 0.3);
    const affect = options.affect ?? NEUTRAL_AFFECT;
    const intent = options.intent ?? 'observed';
    const confidence = clampCredence(options.confidence ?? 0.7);
    const salience = clampUnit(options.salience ?? 0.5);
    const situationKey = `${situation} ${Object.values(options.context ?? {}).join(' ')}`;
    const vector = embed(`${content} ${situationKey}`);
    const tokens = tokenize(`${content} ${situationKey}`);

    // ── merge with a very recent near-duplicate? ──
    const window = options.mergeWindow ?? 2;
    const recent = this.#order.slice(-1 - window);
    for (const candidateId of recent) {
      const candidate = this.#episodes.get(candidateId);
      if (candidate === undefined || candidate.situation !== situation) continue;
      const sim = blendedSimilarity(vector, tokens, candidate.vector, candidate.tokens);
      if (sim < this.#mergeThreshold) continue;

      // Continuation, not a new event. Strengthen and extend instead.
      candidate.strength = clampUnit(candidate.strength + 0.15);
      candidate.lastAccessAt = this.#asTick();
      candidate.accessCount += 1;
      candidate.surprised = Math.max(candidate.surprised, surprise);
      this.#encoded += 1;
      return { id: candidate.id, merged: true };    }

    // ── how long will this last? ──
    // Surprise and self-relevance dominate, with affect a secondary term.
    const significance = clampUnit(0.5 * surprise + 0.35 * selfRelevance + 0.15 * affectMagnitude(affect));
    const halfLife =
      this.#baseHalfLife *
      (INTENT_PERSISTENCE[intent] ?? 1) *
      (0.4 + 2.6 * significance) *
      (0.6 + 0.8 * salience);

    this.#seq += 1;
    const id = `ep${this.#seq}` as EpisodeId;
    const record: EpisodeRecord = {
      id,
      content,
      tokens,
      vector,
      situation,
      context: { ...(options.context ?? {}) },
      precededBy: [...(options.precededBy ?? (this.#order.at(-1) === undefined ? [] : [this.#order.at(-1) as EpisodeId]))],
      surprised: surprise,
      selfRelevance,
      affect,
      intent,
      confidence,
      strength: clampUnit(0.35 + 0.5 * significance + 0.15 * salience),
      halfLife,
      encodedAt: this.#asTick(),
      lastAccessAt: this.#asTick(),
      accessCount: 0,
      reconsolidations: 0,
      // Not `encodedAt`: an episode has not been *recalled* merely by being
      // formed, and conflating the two would start its protection window
      // before it has had any chance to be used. `step()` measures the
      // protection window from `recalledAt ?? encodedAt`, so a fresh episode
      // still gets its grace period — it just gets it from the right instant.
      recalledAt: undefined,
      data: { ...(options.data ?? {}) },
      consolidated: false,
    };

    this.#episodes.set(id, record);
    this.#order.push(id);
    this.#encoded += 1;
    this.#enforceCapacity();

    return { id, merged: false };
  }

  // ── retrieval ─────────────────────────────────────────────────────────────

  /**
   * Recall episodes matching a cue.
   *
   * Context match is scored separately from content similarity and weighted
   * heavily, because that is the whole point of an episodic cue: being in the
   * same situation is what makes a specific past event come back.
   */
  recall(query: EpisodeQuery = {}): readonly EpisodeHit[] {
    const limit = Math.max(0, query.limit ?? 8);
    const threshold = clampUnit(query.threshold ?? 0.15);
    const exclude = new Set(query.exclude ?? []);
    const mood = query.mood ?? NEUTRAL_AFFECT;

    const cueText = [query.text ?? '', query.situation ?? ''].join(' ').trim();
    const probeVector = cueText.length > 0 ? embed(cueText) : undefined;
    const probeTokens = cueText.length > 0 ? tokenize(cueText) : [];

    const hits: EpisodeHit[] = [];

    for (const record of this.#episodes.values()) {
      if (exclude.has(record.id)) continue;
      if (query.includeConsolidated !== true && record.consolidated && query.text === undefined) continue;
      if (query.since !== undefined && record.encodedAt < query.since) continue;
      if (query.until !== undefined && record.encodedAt > query.until) continue;
      if (query.context !== undefined && !contextMatches(query.context, record.context)) continue;
      // `situation` is a hard filter, not merely a scoring term. A caller who
      // says "only from the kitchen" must not receive the lab because the text
      // happened to match well.
      if (query.situation !== undefined && record.situation !== query.situation) continue;

      // Content similarity. With no text cue, everything scores equally here
      // and the ranking falls to context, recency and strength — which is the
      // correct behaviour for "what happened around this time?".
      const similarity =
        probeVector === undefined
          ? 0.5
          : blendedSimilarity(probeVector, probeTokens, record.vector, record.tokens);

      // Situation is the strongest single episodic cue, so it gets its own term.
      const situationMatch =
        query.situation === undefined ? 0.5 : record.situation === query.situation ? 1 : 0;
      const contextMatch =
        query.context === undefined ? 0.5 : contextOverlap(query.context, record.context);

      const elapsed = this.#tick - record.lastAccessAt;
      const recency = decayFactor(elapsed, Math.max(1, record.halfLife * 2));
      const affectTerm = affectCongruence(mood, record.affect);

      const score = clampUnit(
        0.4 * similarity +
          0.2 * situationMatch +
          0.15 * contextMatch +
          0.15 * record.strength +
          0.06 * recency +
          0.04 * affectTerm,
      );

      if (score < threshold) continue;

      hits.push({
        episode: this.#view(record.id) as Episode,
        score,
        components: {
          similarity: round(similarity),
          contextMatch: round(contextMatch),
          strength: round(record.strength),
          recency: round(recency),
          affect: round(affectTerm),
        },
      });
    }

    // Ties break toward the more recent episode: when two memories explain the
    // present equally well, the nearer one is usually the relevant one.
    hits.sort((a, b) => b.score - a.score || b.episode.encodedAt - a.episode.encodedAt);
    const top = hits.slice(0, limit);

    if (top.length > 0) this.#recalled += 1;
    return top;
  }

  /**
   * Recall a specific episode by id, reconsolidating it.
   *
   * This is the operation that makes memory reconstructive rather than
   * read-only. Each recall re-encodes the episode at the current instant with
   * the current situation's context, which:
   *
   *   · raises its strength (retrieval practice),
   *   · makes it more retrievable in the CURRENT context (context drift),
   *   · and slowly edits it — the `reconsolidations` counter is how a caller
   *     finds out how many times a memory has been rewritten, and therefore
   *     how much to trust its present form.
   */
  retrieve(id: string, options: { readonly context?: Record<string, unknown>; readonly reinforce?: boolean } = {}): Episode | undefined {
    const record = this.#episodes.get(id as EpisodeId);
    if (record === undefined) return undefined;

    if (options.reinforce !== false) {
      record.accessCount += 1;
      record.lastAccessAt = this.#asTick();
      record.recalledAt = this.#asTick();
      record.strength = clampUnit(record.strength + 0.12 / Math.sqrt(1 + record.reconsolidations));

      if (options.context !== undefined) {
        // Re-encoding folds the present into the past. This is a real
        // phenomenon and modelling it is the point: the memory becomes easier
        // to reach from here, and correspondingly less faithful to there.
        record.context = { ...record.context, ...options.context };
        record.reconsolidations += 1;
        this.#reconsolidated += 1;
      }

      // Retrieval practice makes a memory structurally more durable, not just
      // temporarily stronger: the half-life itself grows. Without this, a
      // single recall would add a flat amount of strength that decays away at
      // the original rate, which is not how rehearsal works.
      record.halfLife *= 1.25;
    }

    return this.#view(record.id);
  }

  /** Episodes recorded in [from, to], oldest first. */
  between(from: Tick, to: Tick): readonly Episode[] {
    return this.#order
      .map((id) => this.#episodes.get(id))
      .filter((e): e is EpisodeRecord => e !== undefined && e.encodedAt >= from && e.encodedAt <= to)
      .map((e) => this.#view(e.id) as Episode);
  }

  /**
   * Walk the sequence backward from an episode: what led here?
   *
   * `maxSteps` bounds the walk so a corrupted or cyclic chain cannot hang a
   * caller.
   */
  replayFrom(id: string, maxSteps = 16): readonly Episode[] {
    const chain: Episode[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = id;

    while (cursor !== undefined && chain.length < maxSteps) {
      if (seen.has(cursor)) break; // cycle guard
      seen.add(cursor);
      const record = this.#episodes.get(cursor as EpisodeId);
      if (record === undefined) break;
      chain.push(this.#view(record.id) as Episode);
      cursor = record.precededBy[0];
    }

    return chain.reverse();
  }

  /** Walk the sequence forward: what followed from this episode? */
  replayTo(id: string, maxSteps = 16): readonly Episode[] {
    const chain: Episode[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = id;

    while (cursor !== undefined && chain.length < maxSteps) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const record = this.#episodes.get(cursor as EpisodeId);
      if (record === undefined) break;
      chain.push(this.#view(record.id) as Episode);

      const next = this.#order.find((candidate) => {
        const e = this.#episodes.get(candidate);
        return e !== undefined && e.precededBy.includes(record.id);
      });
      cursor = next;
    }

    return chain;
  }

  // ── consolidation support ─────────────────────────────────────────────────

  /**
   * Episodes eligible to be generalised into semantic memory.
   *
   * Selection is driven by significance rather than age: the point of
   * consolidation is to extract what was *worth* learning, and an uneventful
   * hour teaches nothing however long ago it was.
   */
  consolidationCandidates(minimumAge: number, limit = 32): readonly Episode[] {
    return this.#order
      .map((id) => this.#episodes.get(id))
      .filter(
        (e): e is EpisodeRecord =>
          e !== undefined &&
          !e.consolidated &&
          this.#tick - e.encodedAt >= minimumAge &&
          e.strength > this.#forgetThreshold,
      )
      .sort((a, b) => significance(b) - significance(a))
      .slice(0, limit)
      .map((e) => this.#view(e.id) as Episode);
  }

  /** Mark episodes as having contributed to a semantic concept. */
  markConsolidated(ids: readonly string[]): number {
    let n = 0;
    for (const id of ids) {
      const record = this.#episodes.get(id as EpisodeId);
      if (record === undefined || record.consolidated) continue;
      record.consolidated = true;
      n += 1;
    }
    return n;
  }

  // ── the passage of time ───────────────────────────────────────────────────

  /**
   * Advance time: decay every episode and forget those that fall below the
   * threshold.
   *
   * Forgetting requires BOTH conditions, and the conjunction is the whole
   * point:
   *
   *   1. the trace has decayed below `forgetThreshold` — the decay curve
   *      decides what is actually faint, and nothing should be discarded while
   *      it is still strong;
   *   2. the protection window has elapsed since it was last brought to mind —
   *      a memory that was just recalled must survive even at low strength,
   *      because that is what makes rehearsal worth doing.
   *
   * Using either condition alone produces the wrong system: testing only decay
   * throws away freshly-recalled weak memories, and testing only the window
   * discards vivid ones still at half strength.
   */
  step(): readonly string[] {
    this.#tick += 1;
    const lost: string[] = [];

    for (const record of this.#episodes.values()) {
      record.strength *= decayFactor(1, record.halfLife);

      if (record.strength >= this.#forgetThreshold) continue;

      const sinceRecalled = this.#tick - (record.recalledAt ?? record.encodedAt);
      if (sinceRecalled < protectionWindow(record.halfLife)) continue;

      this.#episodes.delete(record.id);
      const i = this.#order.indexOf(record.id);
      if (i >= 0) this.#order.splice(i, 1);
      this.#forgotten += 1;
      lost.push(record.id);
    }

    return lost;
  }

  advance(n: number): readonly string[] {
    if (!Number.isFinite(n) || n < 1) throw new RangeError(`advance(n) requires n >= 1, received ${n}`);
    const all: string[] = [];
    for (let i = 0; i < Math.floor(n); i += 1) all.push(...this.step());
    return all;
  }

  /** Forget a specific episode. Returns whether it existed. */
  forget(id: string): boolean {
    const record = this.#episodes.get(id as EpisodeId);
    if (record === undefined) return false;
    this.#episodes.delete(record.id);
    const i = this.#order.indexOf(record.id);
    if (i >= 0) this.#order.splice(i, 1);
    this.#forgotten += 1;
    return true;
  }

  clear(): void {
    this.#episodes.clear();
    this.#order = [];
    this.#tick = 0;
    this.#seq = 0;
    this.#encoded = 0;
    this.#recalled = 0;
    this.#reconsolidated = 0;
    this.#forgotten = 0;
  }

  /** All retained episodes, oldest first. */
  all(): readonly Episode[] {
    return this.#order.map((id) => this.#view(id)).filter((e): e is Episode => e !== undefined);
  }

  /** Detect internal inconsistency. Consumed by tests and `health()`. */
  check(): readonly string[] {
    const problems: string[] = [];
    if (this.#episodes.size !== this.#order.length) {
      problems.push(`order/payload divergence: ${this.#order.length} ids vs ${this.#episodes.size} episodes`);
    }
    if (this.#episodes.size > this.#capacity) {
      problems.push(`over capacity: ${this.#episodes.size} > ${this.#capacity}`);
    }
    for (const id of this.#order) {
      if (!this.#episodes.has(id)) problems.push(`order references missing episode ${id}`);
    }
    for (const record of this.#episodes.values()) {
      if (!Number.isFinite(record.strength) || record.strength < 0) {
        problems.push(`episode ${record.id} has invalid strength ${record.strength}`);
      }
      if (record.halfLife <= 0) problems.push(`episode ${record.id} has non-positive half-life`);
      for (const predecessor of record.precededBy) {
        if (!this.#episodes.has(predecessor)) {
          // Not an error: the predecessor may simply have been forgotten. But
          // once forgotten it must not remain in the chain, or `replayFrom`
          // silently truncates.
          problems.push(`episode ${record.id} points at forgotten predecessor ${predecessor}`);
        }
      }
    }
    return problems;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Read-only view handed to callers. Copies out of the mutable record. */
  #view(id: EpisodeId): Episode | undefined {
    const record = this.#episodes.get(id);
    if (record === undefined) return undefined;
    return Object.freeze({
      id: record.id,
      kind: 'episodic' as const,
      content: record.content,
      tokens: record.tokens,
      vector: record.vector,
      strength: round(record.strength),
      confidence: record.confidence,
      intent: record.intent,
      affect: Object.freeze({ ...record.affect }),
      encodedAt: record.encodedAt,
      lastAccessAt: record.lastAccessAt,
      accessCount: record.accessCount,
      situation: record.situation,
      context: Object.freeze({ ...record.context }),
      precededBy: Object.freeze([...record.precededBy]),
      surprise: record.surprised,
      selfRelevance: record.selfRelevance,
      data: Object.freeze({ ...record.data }),
    });
  }

  #enforceCapacity(): void {
    if (this.#episodes.size <= this.#capacity) return;

    // Over capacity, drop the least significant episode — not the oldest.
    // Significance, not age, decides what a mind keeps when it must choose.
    const ranked = [...this.#episodes.values()].sort((a, b) => significance(a) - significance(b));
    const excess = this.#episodes.size - this.#capacity;
    for (const victim of ranked.slice(0, excess)) {
      this.#episodes.delete(victim.id);
      const i = this.#order.indexOf(victim.id);
      if (i >= 0) this.#order.splice(i, 1);
      this.#forgotten += 1;
    }
  }

  #asTick(): Tick {
    return this.#tick as Tick;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * How long a memory is protected from decay-forgetting after being brought to
 * mind.
 *
 * Deliberately bounded above by `MAX_PROTECTION_TICKS`, which is the
 * non-obvious part. Equating the protection window with the half-life looks
 * natural and is wrong: a long half-life means both slow decay *and* a long
 * window, so a significant memory spends a very long time drifting down toward
 * the threshold and is then discarded the moment it crosses. That is exactly
 * backwards — significant memories are the ones most worth keeping.
 *
 * Capping the window means the strength threshold, not the window, is what
 * ultimately decides which faint memories go, which is what a threshold is for.
 */
const MIN_PROTECTION_TICKS = 10;
const MAX_PROTECTION_TICKS = 512;

const protectionWindow = (halfLife: number): number =>
  Math.max(MIN_PROTECTION_TICKS, Math.min(MAX_PROTECTION_TICKS, halfLife));

/**
 * How much an episode is worth generalising, and worth keeping when a full
 * store must shed something. Surprise dominates: the point of memory is not to
 * record the expected.
 */
const significance = (e: EpisodeRecord): number =>
  clampUnit(0.45 * e.surprised + 0.3 * e.selfRelevance + 0.15 * e.strength + 0.1 * affectMagnitude(e.affect));

const clampUnit = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Fraction of `wanted`'s keys whose values appear in `have`. */
function contextOverlap(
  wanted: Readonly<Record<string, unknown>>,
  have: Readonly<Record<string, unknown>>,
): number {
  const keys = Object.keys(wanted);
  if (keys.length === 0) return 1;
  let matched = 0;
  for (const key of keys) {
    if (key in have && String(have[key]) === String(wanted[key])) matched += 1;
  }
  return matched / keys.length;
}

function contextMatches(
  wanted: Readonly<Record<string, unknown>>,
  have: Readonly<Record<string, unknown>>,
): boolean {
  for (const [key, value] of Object.entries(wanted)) {
    if (!(key in have)) return false;
    if (String(have[key]) !== String(value)) return false;
  }
  return true;
}

/**
 * Mood-congruent recall: a matching mood makes a memory easier to reach, and
 * a mismatched one harder. The asymmetry matters — a sad mood makes sad
 * memories more available while actively suppressing happy ones, which is the
 * mechanism behind rumination.
 */
function affectCongruence(mood: Affect, memory: Affect): number {
  const moodMag = affectMagnitude(mood);
  if (moodMag === 0) return 0.5;

  const sameSign = Math.sign(mood.valence) === Math.sign(memory.valence);
  const product = mood.valence * memory.valence;
  if (sameSign && product >= 0) return clampUnit(0.5 + 0.5 * product * (0.5 + 0.5 * mood.arousal));
  return clampUnit((1 + product) / 2);
}
