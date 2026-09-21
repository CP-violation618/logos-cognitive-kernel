/**
 * LOGOS :: Memory :: Consolidation
 * ---------------------------------------------------------------------------
 * Where experience becomes knowledge.
 *
 * Consolidation is the process that reads a set of specific episodes and
 * writes a general concept: the episodes are the evidence, and the concept is
 * the invariant they share. Without it a mind accumulates a longer and longer
 * diary and never learns anything; the diary is episodic memory, the lesson is
 * semantic memory, and this file is the step between them.
 *
 * The hard part is not "summarise these texts". It is deciding WHAT deserves
 * to become a concept at all, and the answer implemented here is: only what
 * RECURS.
 *
 *   · A single episode yields no concept, however vivid. One observation is an
 *     anecdote, and promoting anecdotes to knowledge is how a system becomes
 *     confidently wrong.
 *   · Two similar episodes yield a tentative concept, held at low confidence
 *     and vulnerable to revision.
 *   · Many episodes yield an entrenched one, whose confidence and durability
 *     grow with the number of distinct sources.
 *
 * Two further decisions are worth stating because they are choices rather than
 * consequences:
 *
 *   1. ABSTRACTION IS BY INTERSECTION, THEN DIFFERENCE. The shared vocabulary
 *      across a cluster becomes the concept's label, and the vocabulary that
 *      distinguishes the episodes from each other is discarded as incidental
 *      detail. This is what makes a concept general rather than a merged blob.
 *
 *   2. SOURCE EPISODES ARE MARKED, NOT DELETED. Generalising does not erase
 *      the experiences that produced the generalisation. A mind that forgot
 *      the events but kept the conclusion could never re-examine its own
 *      reasoning, which is the whole basis of metacognition.
 */

import type { Clock } from '../kernel/clock.ts';
import type { EventBus } from '../kernel/bus.ts';
import type { Scheduler } from '../kernel/scheduler.ts';
import type { KernelConfig } from '../kernel/config.ts';
import type { Rng } from '../kernel/rng.ts';
import type { Tick } from '../kernel/types.ts';
import { LogosError } from '../kernel/types.ts';
import type { Episode } from './types.ts';
import type { EpisodicMemory } from './episodic.ts';
import type { SemanticMemory, ConceptObservation } from './semantic.ts';
import { blendedSimilarity, embed, tokenize } from './vector.ts';

/** A group of episodes judged to be about the same thing. */
export interface EpisodeCluster {
  readonly episodes: readonly Episode[];
  /** Shared tokens: the invariant. Becomes the concept label. */
  readonly sharedTokens: readonly string[];
  /** Tokens present in some but not all: incidental detail, discarded. */
  readonly distinguishingTokens: readonly string[];
  /** Mean pairwise similarity within the cluster, in [0, 1]. */
  readonly cohesion: number;
  /** Mean significance of members. Drives confidence of what is derived. */
  readonly significance: number;
}

export interface ConsolidationOutcome {
  /** Clusters found and processed this pass. */
  readonly clusters: number;
  /** Concepts newly created. */
  readonly conceptsFormed: number;
  /** Existing concepts that absorbed new evidence. */
  readonly conceptsReinforced: number;
  /** Episodes marked as having contributed. */
  readonly episodesConsolidated: number;
  /** Episode ids that went into a concept, for auditability. */
  readonly sources: readonly string[];
  /** Logical tick the pass ran on. */
  readonly at: Tick;
  /** Why the pass stopped early, if it did. */
  readonly truncated: boolean;
}

export interface ConsolidationOptions {
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly scheduler: Scheduler;
  readonly config: KernelConfig;
  readonly rng: Rng;
  readonly episodic: EpisodicMemory;
  readonly semantic: SemanticMemory;
  /** Minimum episodes in a cluster before anything is generalised. */
  readonly minClusterSize?: number;
  /** Similarity above which two episodes are treated as the same phenomenon. */
  readonly clusterThreshold?: number;
  /** Maximum episodes examined per pass, bounding a single tick's work. */
  readonly maxPerPass?: number;
}

export class ConsolidationEngine {
  readonly #clock: Clock;
  readonly #bus: EventBus;
  readonly #scheduler: Scheduler;
  readonly #config: KernelConfig;
  readonly #rng: Rng;
  readonly #episodic: EpisodicMemory;
  readonly #semantic: SemanticMemory;

  readonly #minClusterSize: number;
  readonly #clusterThreshold: number;
  readonly #maxPerPass: number;

  #passes = 0;
  #conceptsFormed = 0;
  #conceptsReinforced = 0;
  #episodesConsolidated = 0;
  /** Rolling record of the last few outcomes, newest last. */
  #log: ConsolidationOutcome[] = [];

  constructor(options: ConsolidationOptions) {
    this.#clock = options.clock;
    this.#bus = options.bus;
    this.#scheduler = options.scheduler;
    this.#config = options.config;
    this.#rng = options.rng;
    this.#episodic = options.episodic;
    this.#semantic = options.semantic;

    this.#minClusterSize = Math.max(2, options.minClusterSize ?? 3);
    this.#clusterThreshold = Math.min(1, Math.max(0, options.clusterThreshold ?? 0.3));
    this.#maxPerPass = Math.max(1, options.maxPerPass ?? 64);
  }

  get passes(): number {
    return this.#passes;
  }

  get history(): readonly ConsolidationOutcome[] {
    return [...this.#log];
  }

  /**
   * Cluster candidate episodes by similarity.
   *
   * Implemented as single-pass online clustering: each episode joins the
   * existing cluster it is most similar to, or starts a new one. Agglomerative
   * clustering would produce marginally tighter groups and a much worse story
   * about how a mind actually works — you do not get to re-examine every past
   * experience each time a new one arrives.
   *
   * Cluster membership is judged by similarity to the cluster's CENTROID
   * rather than to any single member, so a cluster can absorb a gradual drift
   * in wording that no pairwise comparison would have caught.
   */
  cluster(episodes: readonly Episode[], threshold = this.#clusterThreshold): readonly EpisodeCluster[] {
    interface Working {
      readonly members: Episode[];
      readonly centroidTokens: Map<string, number>;
      readonly vectors: { tokens: readonly string[]; vector: ReturnType<typeof embed> }[];
    }

    const clusters: Working[] = [];

    for (const episode of episodes) {
      let best: { cluster: Working; score: number } | undefined;

      for (const cluster of clusters) {
        // Score against the centroid: mean similarity to existing members.
        let total = 0;
        for (const member of cluster.vectors) {
          total += blendedSimilarity(episode.vector, episode.tokens, member.vector, member.tokens);
        }
        const score = total / Math.max(1, cluster.vectors.length);
        if (best === undefined || score > best.score) best = { cluster, score };
      }

      if (best !== undefined && best.score >= threshold) {
        best.cluster.members.push(episode);
        best.cluster.vectors.push({ tokens: episode.tokens, vector: episode.vector });
        for (const token of episode.tokens) {
          best.cluster.centroidTokens.set(token, (best.cluster.centroidTokens.get(token) ?? 0) + 1);
        }
      } else {
        const centroidTokens = new Map<string, number>();
        for (const token of episode.tokens) centroidTokens.set(token, 1);
        clusters.push({
          members: [episode],
          centroidTokens,
          vectors: [{ tokens: episode.tokens, vector: episode.vector }],
        });
      }
    }

    return clusters
      .filter((c) => c.members.length >= this.#minClusterSize)
      .map((c) => this.#describeCluster(c.members, c.centroidTokens));
  }

  /**
   * Run one consolidation pass.
   *
   * Enqueued on the scheduler rather than run inline, because consolidation is
   * background work: it must yield to whatever the mind is actually doing, and
   * it must be interruptible. Modelling that with the scheduler instead of a
   * bare async call means the cost is accounted for in the same budget as
   * everything else.
   */
  async run(): Promise<ConsolidationOutcome> {
    const outcome = await this.#scheduler.run<ConsolidationOutcome>({
      name: 'memory:consolidate',
      // Background priority: consolidation never preempts deliberation.
      priority: 50,
      resource: 'memory',
      // Consolidation is genuinely expensive, so it is billed accordingly.
      chargeOnComplete: 2,
      run: () => {
        const result = this.consolidateNow();
        return { status: 'done', value: result };
      },
    });

    if (outcome.state !== 'done' || outcome.value === undefined) {
      throw new LogosError('CONSOLIDATION_FAILED', `consolidation pass ended as ${outcome.state}`, {
        state: outcome.state,
        work: outcome.work,
        attempts: outcome.attempts,
      });
    }
    return outcome.value;
  }

  /**
   * The pass itself, synchronously.
   *
   * Exposed separately so tests and the CLI can drive consolidation without
   * going through the scheduler, while `run()` remains the path used by the
   * live kernel.
   */
  consolidateNow(): ConsolidationOutcome {
    const minimumAge = this.#config.memory.consolidationAgeTicks;
    const candidates = this.#episodic.consolidationCandidates(minimumAge, this.#maxPerPass);
    const truncated = candidates.length >= this.#maxPerPass;

    const clusters = this.cluster(candidates);
    const sources: string[] = [];
    let formed = 0;
    let reinforced = 0;

    for (const cluster of clusters) {
      const observation = this.#toObservation(cluster);
      if (observation === undefined) continue;

      const existing = this.#semantic.get(observation.label);
      const result = this.#semantic.observe(observation);

      if (result.created) formed += 1;
      else if (existing !== undefined || result.mergedInto !== undefined) reinforced += 1;

      const memberIds = cluster.episodes.map((e) => e.id);
      this.#episodic.markConsolidated(memberIds);
      sources.push(...memberIds);

      this.#bus.publish(
        'memory:concept',
        {
          conceptId: result.id,
          label: observation.label,
          created: result.created,
          sources: memberIds.length,
          cohesion: cluster.cohesion,
        },
        this.#clock.current,
      );
    }

    // Relate concepts that were generalised from overlapping experiences:
    // if the same episode contributed to two concepts, those concepts are
    // about something adjacent, and the link should exist without anyone
    // asserting it.
    const links = this.#relateSharedSources(clusters);

    const outcome: ConsolidationOutcome = Object.freeze({
      clusters: clusters.length,
      conceptsFormed: formed,
      conceptsReinforced: reinforced + links,
      episodesConsolidated: sources.length,
      sources: Object.freeze(sources),
      at: this.#clock.current,
      truncated,
    });

    this.#passes += 1;
    this.#conceptsFormed += formed;
    this.#conceptsReinforced += reinforced;
    this.#episodesConsolidated += sources.length;
    this.#log.push(outcome);
    if (this.#log.length > 32) this.#log.shift();

    this.#bus.publish(
      'memory:consolidation',
      {
        clusters: outcome.clusters,
        formed: outcome.conceptsFormed,
        reinforced: outcome.conceptsReinforced,
        episodes: outcome.episodesConsolidated,
      },
      this.#clock.current,
    );

    return outcome;
  }

  stats(): Readonly<Record<string, number>> {
    return Object.freeze({
      passes: this.#passes,
      conceptsFormed: this.#conceptsFormed,
      conceptsReinforced: this.#conceptsReinforced,
      episodesConsolidated: this.#episodesConsolidated,
      minClusterSize: this.#minClusterSize,
      clusterThreshold: this.#clusterThreshold,
    });
  }

  reset(): void {
    this.#passes = 0;
    this.#conceptsFormed = 0;
    this.#conceptsReinforced = 0;
    this.#episodesConsolidated = 0;
    this.#log = [];
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Describe a cluster as a candidate concept.
   *
   * The label is the shared vocabulary; the definition is built from the
   * members themselves; and the confidence rises with the number of distinct
   * sources, so a concept generalised from two episodes starts life far less
   * certain than one from ten.
   */
  #toObservation(cluster: EpisodeCluster): ConceptObservation | undefined {
    if (cluster.episodes.length < this.#minClusterSize) return undefined;

    const label = this.#labelFor(cluster);
    if (label.length === 0) return undefined;

    // Representative definition: the shortest member that still contains the
    // shared vocabulary. Shortest because it is the most economical statement
    // of the invariant; containing the shared tokens because a definition that
    // omits them would not be a definition of this concept.
    const representative =
      [...cluster.episodes]
        .filter((e) => cluster.sharedTokens.every((token) => e.tokens.includes(token)))
        .sort((a, b) => a.content.length - b.content.length)[0] ?? cluster.episodes[0];

    const properties = this.#extractProperties(cluster);
    const contexts = new Set(cluster.episodes.map((e) => e.situation));

    return {
      label,
      definition: representative?.content ?? '',
      categories: contexts.size <= 2 ? [...contexts] : ['generalised'],
      properties,
      // Every member is independent evidence, so all of them are passed as
      // sources. Concatenating them into one string would make the store count
      // a whole cluster as a single source — precisely the overconfidence the
      // grounding rule exists to prevent.
      sourceEpisodes: cluster.episodes.map((e) => e.id),
      confidence: clampUnit(0.4 + 0.5 * clampUnit(cluster.episodes.length / 8) + 0.1 * cluster.cohesion),
    };
  }

  /**
   * The concept's label: the tokens shared by every member.
   *
   * Intersection, not frequency. A token appearing in most members but not all
   * describes the cluster's tendency rather than its identity, and using it
   * would produce a label that over-claims.
   *
   * Order is FIRST APPEARANCE in the representative episode, not frequency and
   * certainly not alphabetical. Alphabetical ordering turns
   * "the payment gateway timed out" into "gateway out payment timed", which is
   * not a label a mind could use or a human could read — the shared tokens are
   * a phrase, and a phrase depends on its word order.
   */
  #labelFor(cluster: EpisodeCluster): string {
    const shared = cluster.sharedTokens.filter((token) => token.length > 1);
    if (shared.length === 0) {
      // No strict invariant. Fall back to the most common tokens rather than
      // refusing to generalise, still in first-appearance order.
      return cluster.sharedTokens.slice(0, 3).join(' ').trim();
    }

    const ordered = [...shared].sort(
      (a, b) => firstAppearance(cluster, a) - firstAppearance(cluster, b),
    );
    // Bounded so a label stays a label rather than becoming a sentence.
    return ordered.slice(0, 5).join(' ');
  }

  #describeCluster(members: Episode[], counts: Map<string, number>): EpisodeCluster {
    const shared: string[] = [];
    const distinguishing: string[] = [];

    for (const [token, count] of counts) {
      if (token.length < 2) continue;
      if (count === members.length) shared.push(token);
      else if (count === 1) distinguishing.push(token);
    }

    // Deterministic ordering. Deliberately NOT sorted by frequency or
    // alphabetically: `#labelFor` imposes first-appearance order so that a
    // label reads as the phrase the experience actually used.
    shared.sort((a, b) => a.localeCompare(b));

    let total = 0;
    let pairs = 0;
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i];
        const b = members[j];
        if (a === undefined || b === undefined) continue;
        total += blendedSimilarity(a.vector, a.tokens, b.vector, b.tokens);
        pairs += 1;
      }
    }

    const significance =
      members.length === 0
        ? 0
        : members.reduce((acc, e) => acc + clampUnit(0.5 * e.surprise + 0.5 * e.selfRelevance), 0) / members.length;

    return Object.freeze({
      episodes: Object.freeze([...members]),
      sharedTokens: Object.freeze(shared),
      distinguishingTokens: Object.freeze(distinguishing.slice(0, 16)),
      cohesion: pairs === 0 ? 1 : round(total / pairs),
      significance: round(significance),
    });
  }

  /**
   * Extract stable properties from the cluster's episodes.
   *
   * Only keys present in MORE THAN HALF the members become properties of the
   * concept. A key that appeared once is that episode's detail, not the
   * concept's attribute, and promoting it would make every concept carry the
   * idiosyncrasies of whichever episode happened to be first.
   */
  #extractProperties(cluster: EpisodeCluster): Record<string, unknown> {
    const tallies = new Map<string, Map<string, number>>();
    const threshold = Math.ceil(cluster.episodes.length / 2);

    for (const episode of cluster.episodes) {
      for (const [key, value] of Object.entries(episode.data)) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'object' && !Array.isArray(value)) continue; // too structured to generalise
        let values = tallies.get(key);
        if (values === undefined) {
          values = new Map();
          tallies.set(key, values);
        }
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        values.set(rendered, (values.get(rendered) ?? 0) + 1);
      }
    }

    const properties: Record<string, unknown> = {};
    for (const [key, values] of tallies) {
      let bestValue: string | undefined;
      let bestCount = 0;
      for (const [value, count] of values) {
        if (count > bestCount) {
          bestCount = count;
          bestValue = value;
        }
      }
      if (bestValue !== undefined && bestCount >= threshold) properties[key] = bestValue;
    }
    return properties;
  }

  /**
   * Link concepts that share a source episode.
   *
   * Two concepts drawn from overlapping experiences are about adjacent things.
   * The evidence is already present in the data, so requiring a caller to
   * assert the link would mean throwing away information the system has.
   */
  #relateSharedSources(clusters: readonly EpisodeCluster[]): number {
    const byEpisode = new Map<string, string[]>();

    for (const cluster of clusters) {
      const label = this.#labelFor(cluster);
      if (label.length === 0) continue;
      for (const episode of cluster.episodes) {
        const labels = byEpisode.get(episode.id);
        if (labels === undefined) byEpisode.set(episode.id, [label]);
        else if (!labels.includes(label)) labels.push(label);
      }
    }

    let links = 0;
    const made = new Set<string>();
    for (const labels of byEpisode.values()) {
      for (let i = 0; i < labels.length; i += 1) {
        for (let j = i + 1; j < labels.length; j += 1) {
          const a = labels[i];
          const b = labels[j];
          if (a === undefined || b === undefined) continue;
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (made.has(key)) continue;
          made.add(key);

          const edge = this.#semantic.relate(a, 'co-occurs-with', b, { weight: 0.4, confidence: 0.3 });
          if (edge !== undefined) links += 1;
        }
      }
    }
    return links;
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
 * Where a token first occurs in the cluster's episodes, used to keep a label's
 * word order faithful to how the experience was actually described.
 *
 * The representative episode is preferred; failing that, whichever member
 * mentions the token soonest.
 */
function firstAppearance(cluster: EpisodeCluster, token: string): number {
  const representative = cluster.episodes[0];
  if (representative !== undefined) {
    const index = representative.tokens.indexOf(token);
    if (index >= 0) return index;
  }
  for (const episode of cluster.episodes) {
    const index = episode.tokens.indexOf(token);
    if (index >= 0) return 1000 + index;
  }
  return Number.MAX_SAFE_INTEGER;
}

/** Exported for tests and tooling that want to inspect tokenisation directly. */
export { tokenize as tokenizeForClustering, embed as embedForClustering };
