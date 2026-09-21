/**
 * LOGOS :: Memory :: Shared types
 * ---------------------------------------------------------------------------
 * The vocabulary of remembering.
 *
 * One decision shapes everything here: a memory trace is never a bare string.
 * Every remembered thing carries *how strongly* it is held, *when* it was
 * formed, *when* it was last touched, and *how often*. Those four numbers are
 * the difference between a database and a memory — they are what allows a
 * trace to fade, to be reinforced by rehearsal, to be reconstructed
 * differently depending on the cue that reaches it.
 */

import type { ConceptId, Credence, EpisodeId, Tick } from '../kernel/types.ts';
import type { SparseVector } from './vector.ts';

/**
 * Which memory system a trace belongs to.
 *
 * These are not arbitrary buckets; they are functionally distinct systems
 * that differ in capacity, duration, and what they are *for*:
 *
 *   working      — the current contents of attention. Tiny, seconds-long.
 *   episodic     — what happened. Autonoetic, context-bound, single-trial.
 *   semantic     — what is true. Detached from context, built by abstraction.
 *   procedural   — how to do things. Compiled, not recalled.
 */
export type MemoryKind = 'working' | 'episodic' | 'semantic' | 'procedural';

/** Emotional colouring. Affects consolidation priority and retrieval bias. */
export interface Affect {
  /** -1 aversive → 0 neutral → +1 appetitive. */
  readonly valence: number;
  /** 0 calm → 1 urgent. High arousal narrows attention and speeds encoding. */
  readonly arousal: number;
}

export const NEUTRAL_AFFECT: Affect = Object.freeze({ valence: 0, arousal: 0 });

/** Affective charge, ignoring sign: how *moving* an experience was. */
export const affectMagnitude = (affect: Affect): number =>
  Math.min(1, Math.abs(affect.valence) * 0.6 + affect.arousal * 0.6);

/**
 * Why a trace was encoded. Determines how fast it decays: the brain does not
 * treat "I chose this" and "I noticed this" as equally worth keeping.
 */
export type EncodingIntent =
  | 'observed' // perceived from outside
  | 'inferred' // derived by reasoning
  | 'chosen' // produced by a decision
  | 'imagined' // counterfactual or simulated
  | 'recalled'; // re-encoded from memory itself

/**
 * Per-intent decay multipliers. Chosen actions and inferred conclusions are
 * kept more tenaciously than raw percepts, because they cost more to
 * reconstruct.
 */
export const INTENT_PERSISTENCE: Readonly<Record<EncodingIntent, number>> = Object.freeze({
  observed: 1.0,
  inferred: 1.3,
  chosen: 1.6,
  imagined: 0.8,
  recalled: 0.9,
});

/** A trace as it exists in memory, independent of which store holds it. */
export interface MemoryTrace {
  readonly id: string;
  readonly kind: MemoryKind;
  /** The remembered content, as text. The substrate every store shares. */
  readonly content: string;
  /** Tokenised form, cached so retrieval does not re-tokenise on every probe. */
  readonly tokens: readonly string[];
  /** Semantic projection, cached for the same reason. */
  readonly vector: SparseVector;
  /** Strength of the trace in [0, 1]. Decays with disuse, grows with use. */
  readonly strength: number;
  /** Retrieval confidence: how much this trace should be trusted as evidence. */
  readonly confidence: Credence;
  readonly intent: EncodingIntent;
  readonly affect: Affect;
  /** Logical instant the trace was formed. */
  readonly encodedAt: Tick;
  /** Logical instant the trace was last retrieved or reinforced. */
  readonly lastAccessAt: Tick;
  /** Number of times the trace has been retrieved or reinforced. */
  readonly accessCount: number;
  /** Arbitrary structured payload — goals, entities, outcomes. */
  readonly data: Readonly<Record<string, unknown>>;
}

/** An episode: a memory trace that additionally knows its context and time. */
export interface Episode extends MemoryTrace {
  readonly kind: 'episodic';
  /** What was going on: active goal, location, situation descriptor. */
  readonly context: Readonly<Record<string, unknown>>;
  /** Free-text situation label, used as a retrieval cue. */
  readonly situation: string;
  /** Ids of episodes that preceded this one, in order. Enables replay. */
  readonly precededBy: readonly EpisodeId[];
  /** How surprising this episode was when it happened, in [0, 1]. */
  readonly surprise: number;
  /** How much this episode is about the self. Biases recall and consolidation. */
  readonly selfRelevance: number;
}

/** A relation between two concepts, with a learned strength. */
export interface SemanticEdge {
  readonly from: ConceptId;
  readonly to: ConceptId;
  /** Relation label, e.g. 'is-a', 'causes', 'part-of', 'opposes'. */
  readonly relation: string;
  /** Learned association strength in [0, 1]; grows each time it is traversed. */
  readonly weight: number;
  /** Evidence count backing this edge. */
  readonly support: number;
  /** Credence that the relation holds at all. */
  readonly confidence: Credence;
  readonly updatedAt: Tick;
}

/** A concept in semantic memory: a node with a definition and associations. */
export interface Concept extends MemoryTrace {
  readonly kind: 'semantic';
  readonly label: string;
  readonly definition: string;
  /** Aliases and surface forms that should route to this concept. */
  readonly aliases: readonly string[];
  /** Category membership, e.g. ['animal', 'mammal']. */
  readonly categories: readonly string[];
  /** Properties believed to hold of this concept. */
  readonly properties: Readonly<Record<string, unknown>>;
  /** How many distinct episodes contributed to this concept's formation. */
  readonly grounding: number;
}

/** What a retrieval returned, and — crucially — why. */
export interface RetrievalHit<T extends MemoryTrace = MemoryTrace> {
  readonly trace: T;
  /** Final ranking score in [0, 1]. */
  readonly score: number;
  /**
   * Score decomposition. Exposed rather than hidden so that a surprising
   * recall can be explained after the fact instead of guessed at.
   */
  readonly components: {
    /** Similarity of the cue to this trace. */
    readonly similarity: number;
    /** Contribution of the trace's own strength. */
    readonly strength: number;
    /** Contribution of recency. */
    readonly recency: number;
    /** Contribution of activation spread from other retrieved traces. */
    readonly spread: number;
    /** Contribution of affective match with the current mood. */
    readonly affect: number;
  };
}

/** A cue: what a retrieval is launched with. */
export interface RetrievalCue {
  /** Free text to match against. */
  readonly text?: string;
  /** Structured filters that must match a trace's `data` exactly. */
  readonly where?: Readonly<Record<string, unknown>>;
  /** Restrict to particular memory kinds. */
  readonly kinds?: readonly MemoryKind[];
  /** Current mood, which biases what comes back (mood-congruent recall). */
  readonly mood?: Affect;
  /** Ids to exclude, e.g. traces already used this cycle. */
  readonly exclude?: readonly string[];
  /** Maximum hits to return. */
  readonly limit?: number;
  /** Minimum score for a hit to be returned. Higher = more selective. */
  readonly threshold?: number;
  /** Only traces encoded at or after this instant. */
  readonly since?: Tick;
  /** Free the caller from caring about any of the above. */
  readonly requireAll?: boolean;
}

/** Tunables for scoring, so retrieval policy is inspectable and testable. */
export interface RetrievalWeights {
  readonly similarity: number;
  readonly strength: number;
  readonly recency: number;
  readonly spread: number;
  readonly affect: number;
}

export const DEFAULT_RETRIEVAL_WEIGHTS: RetrievalWeights = Object.freeze({
  similarity: 0.55,
  strength: 0.2,
  recency: 0.15,
  spread: 0.07,
  affect: 0.03,
});

/** Result of an eviction decision, kept for introspection. */
export interface EvictionRecord {
  readonly id: string;
  readonly content: string;
  readonly reason: 'capacity' | 'decay' | 'expired' | 'displaced';
  /** Strength at the moment of eviction. */
  readonly strength: number;
  readonly at: Tick;
}

/** Result of encoding an item into working memory. */
export interface EncodeResult {
  /** True when the item strengthened an existing slot rather than taking one. */
  readonly reinforced: boolean;
  /** The slot id the content now occupies. */
  readonly id: string;
  /** What was pushed out to make room, if anything. */
  readonly evicted: readonly EvictionRecord[];
  /** Whether the item actually got in. Low-salience items are refused. */
  readonly admitted: boolean;
}

/** Snapshot of working memory, suitable for persistence or test assertions. */
export interface WorkingMemorySnapshot {
  readonly capacity: number;
  readonly tick: number;
  readonly slots: readonly {
    readonly id: string;
    readonly content: string;
    readonly strength: number;
    readonly kind: MemoryKind;
    readonly intent: EncodingIntent;
    readonly accessedAt: Tick;
    readonly accessCount: number;
  }[];
}

/**
 * Incremental mean.
 *
 * Used wherever a trace is repeatedly updated by new evidence — concept
 * prototypes, edge weights, calibration estimates. Written out rather than
 * done inline because the naive `sum / n` accumulates float error and, worse,
 * forces us to keep every sample forever.
 */
export class RunningMean {
  #count = 0;
  #mean = 0;

  constructor(initial = 0) {
    this.#mean = initial;
  }

  get count(): number {
    return this.#count;
  }

  get value(): number {
    return this.#mean;
  }

  /** Welford's update: numerically stable and O(1) in memory. */
  push(sample: number, weight = 1): number {
    const w = Math.max(0, weight);
    if (w === 0) return this.#mean;
    const total = this.#count + w;
    if (total === 0) return this.#mean;
    this.#mean += (sample - this.#mean) * (w / total);
    this.#count = total;
    return this.#mean;
  }

  reset(value = 0): void {
    this.#count = 0;
    this.#mean = value;
  }
}

/** Exponential decay by half-life: the shape of forgetting. */
export const decayFactor = (elapsed: number, halfLife: number): number => {
  if (elapsed <= 0) return 1;
  if (halfLife <= 0) return 0;
  return Math.pow(0.5, elapsed / halfLife);
};

/**
 * Reinforcement gain.
 *
 * Repeated rehearsal has sharply diminishing returns — the tenth review of a
 * fact adds far less than the first. A square-root curve captures that: it is
 * unbounded (so nothing is ever un-reinforceable) but its slope collapses
 * quickly.
 */
export const reinforcementGain = (priorAccessCount: number, base = 0.35): number =>
  base / Math.sqrt(1 + Math.max(0, priorAccessCount));
