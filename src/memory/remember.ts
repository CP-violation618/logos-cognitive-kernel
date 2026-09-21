/**
 * LOGOS :: Memory :: Remembering
 * ---------------------------------------------------------------------------
 * The unified retrieval facade, and the answer to "what do I know about this?"
 *
 * Four stores answering separately would be a filing cabinet. A mind asked
 * about something does not consult its episodic drawer and then its semantic
 * drawer and then compare — it brings back whatever is relevant, of whatever
 * kind, and the kinds inform each other. That mutual informing is the point of
 * this file.
 *
 * Two mechanisms make it more than a merge of four result lists:
 *
 * 1. CROSS-STORE SPREADING ACTIVATION, IN TWO DIRECTIONS.
 *
 *      episodes ──generalise to──▶ concepts ──remind of──▶ other episodes
 *
 *    A recalled episode activates the concepts it contributed to, those
 *    concepts activate their associates, and those associates reach back into
 *    episodic memory for other experiences of the same thing. This is how
 *    recalling one incident brings to mind both the general rule it taught and
 *    the other occasions that taught the same rule — a two-hop round trip that
 *    no single store can perform alone.
 *
 * 2. MOOD IS APPLIED ONCE, GLOBALLY.
 *
 *    Retrieval bias by affect is a property of the rememberer, not of a store.
 *    Applying it per-store would make the bias compound with every store
 *    consulted, so a slightly low mood would become a total filter by the
 *    fourth lookup. It is applied once, here, to the combined result.
 */

import type { Affect, Concept, Episode, MemoryTrace } from './types.ts';
import { NEUTRAL_AFFECT, affectMagnitude, decayFactor } from './types.ts';
import type { WorkingMemory } from './working.ts';
import type { EpisodicMemory, EpisodeHit } from './episodic.ts';
import type { SemanticMemory } from './semantic.ts';
import type { Rng } from '../kernel/rng.ts';
import type { Tick } from '../kernel/types.ts';

/** What a recall returned: one ranked list, each entry knowing its origin. */
export interface Recollection {
  readonly trace: MemoryTrace | Episode | Concept;
  readonly store: 'working' | 'episodic' | 'semantic';
  /**
   * Final relevance. Comparable ACROSS stores, which is the whole reason this
   * facade exists: a caller asking "what do I know" should not have to
   * normalise four different scales to find out what the mind considers most
   * relevant.
   */
  readonly relevance: number;
  /** The trace's own strength, before retrieval weighting. */
  readonly strength: number;
  /** Why this came back — the route, if activation spread reached it. */
  readonly via: 'direct' | 'association' | 'spread';
  /** Concept labels (or episode ids) that led here, empty for a direct hit. */
  readonly path: readonly string[];
}

export interface RecallResult {
  readonly items: readonly Recollection[];
  /** Concepts most activated overall. Exposed because they are the "gist". */
  readonly gist: readonly Concept[];
  /** Episodes activated by association rather than by direct matching. */
  readonly resonant: readonly Episode[];
  readonly at: Tick;
  /** Per-store counts before ranking, so a skewed result is explainable. */
  readonly considered: { readonly working: number; readonly episodic: number; readonly semantic: number };
}

export interface RecallOptions {
  readonly text?: string;
  readonly mood?: Affect;
  readonly limit?: number;
  /** Minimum relevance for an item to be returned. */
  readonly threshold?: number;
  /**
   * Minimum similarity for a store to call something a DIRECT match.
   *
   * Kept separate from `threshold` because the two answer different questions.
   * `threshold` asks "is this worth returning at all"; this asks "is this
   * actually about the query". Conflating them means a high bar for direct
   * matches also silences association, and a low bar lets the lexical
   * embedding's no-overlap similarity baseline (0.2) admit unrelated traces as
   * direct hits — which then suppress the association route via de-duplication.
   *
   * Defaults to a value well clear of that baseline.
   */
  readonly directThreshold?: number;
  readonly stores?: readonly ('working' | 'episodic' | 'semantic')[];
  readonly since?: Tick;
  readonly exclude?: readonly string[];
  /** Hops of cross-store activation to perform. 0 disables spreading. */
  readonly spreadDepth?: number;
  /** Bias toward the general (concepts) or the specific (episodes). */
  readonly prefer?: 'specific' | 'general' | 'balanced';
}

interface RememberOptions {
  readonly working: WorkingMemory;
  readonly episodic: EpisodicMemory;
  readonly semantic: SemanticMemory;
  readonly rng: Rng;
  /** Current logical instant, read from the kernel rather than tracked here. */
  readonly now: () => Tick;
}

export class Rememberer {
  readonly #working: WorkingMemory;
  readonly #episodic: EpisodicMemory;
  readonly #semantic: SemanticMemory;
  readonly #rng: Rng;
  readonly #now: () => Tick;
  #recalls = 0;

  constructor(options: RememberOptions) {
    this.#working = options.working;
    this.#episodic = options.episodic;
    this.#semantic = options.semantic;
    this.#rng = options.rng;
    this.#now = options.now;
  }

  get recalls(): number {
    return this.#recalls;
  }

  /**
   * Bring back whatever is relevant, of whatever kind.
   *
   * Ranking is deliberately not a single similarity score. A relevant concept
   * and a relevant episode reach the top by different routes and should each
   * be able to win: the store weights below encode the claim that, all else
   * equal, a concept is a better answer to "what do I know" than a single
   * experience of it — while a strongly matching episode still beats a weakly
   * matching concept.
   */
  recall(options: RecallOptions = {}): RecallResult {
    const limit = Math.max(0, options.limit ?? 8);
    const threshold = clampUnit(options.threshold ?? 0.1);
    const directThreshold = clampUnit(options.directThreshold ?? 0.32);
    const stores = new Set(options.stores ?? (['working', 'episodic', 'semantic'] as const));
    const exclude = new Set(options.exclude ?? []);
    const mood = options.mood ?? NEUTRAL_AFFECT;
    const spreadDepth = Math.max(0, Math.floor(options.spreadDepth ?? 2));
    const prefer = options.prefer ?? 'balanced';

    const query = (options.text ?? '').trim();
    const items: Recollection[] = [];
    const considered = { working: 0, episodic: 0, semantic: 0 };

    // ── 1. direct hits from each store ──
    const directEpisodes: EpisodeHit[] = [];
    if (stores.has('episodic')) {
      const query2: Parameters<EpisodicMemory['recall']>[0] = {
        limit: limit * 3,
        threshold: directThreshold,
        exclude: [...exclude],
        mood,
        includeConsolidated: true,
      };
      const hits = this.#episodic.recall(
        options.since === undefined ? { ...query2, text: query } : { ...query2, text: query, since: options.since },
      );
      directEpisodes.push(...hits);
      considered.episodic = hits.length;
    }

    const directConcepts = stores.has('semantic')
      ? this.#semantic.find({
          text: query,
          limit: limit * 3,
          threshold: directThreshold,
          exclude: [...exclude],
        })
      : [];
    considered.semantic = directConcepts.length;

    const workingItems = stores.has('working') ? this.#working.contents() : [];
    considered.working = workingItems.length;

    // ── 2. cross-store spreading activation ──
    //
    // Seed concepts from the strongest direct concept hits, plus the concepts
    // that the recalled episodes generalised into. Both routes matter: the
    // first is "tell me about this", the second is "what did this teach me".
    const seedLabels: string[] = directConcepts.slice(0, 3).map((h) => h.concept.label);
    const episodeConcepts = new Map<string, string[]>();
    if (spreadDepth > 0 && directEpisodes.length > 0) {
      for (const hit of directEpisodes.slice(0, 6)) {
        const labels = this.#conceptsFromEpisode(hit.episode);
        episodeConcepts.set(hit.episode.id, labels);
        seedLabels.push(...labels);
      }
    }

    const associations =
      spreadDepth > 0 && seedLabels.length > 0
        ? this.#semantic.spread([...new Set(seedLabels)], { depth: spreadDepth, limit: limit * 2 })
        : [];

    // ── 3. score everything on one scale ──
    const storeWeight = (store: 'working' | 'episodic' | 'semantic'): number => {
      if (prefer === 'general') return store === 'semantic' ? 1.15 : store === 'episodic' ? 0.85 : 0.9;
      if (prefer === 'specific') return store === 'episodic' ? 1.15 : store === 'semantic' ? 0.85 : 0.9;
      return store === 'semantic' ? 1.0 : store === 'episodic' ? 0.95 : 0.9;
    };

    for (const hit of directConcepts) {
      if (exclude.has(hit.concept.id)) continue;
      items.push({
        trace: hit.concept,
        store: 'semantic',
        relevance: clampUnit(hit.score * storeWeight('semantic') * moodFactor(mood, hit.concept.affect)),
        strength: hit.concept.strength,
        via: 'direct',
        path: [],
      });
    }

    for (const hit of directEpisodes) {
      if (exclude.has(hit.episode.id)) continue;
      items.push({
        trace: hit.episode,
        store: 'episodic',
        relevance: clampUnit(hit.score * storeWeight('episodic') * moodFactor(mood, hit.episode.affect)),
        strength: hit.episode.strength,
        via: 'direct',
        path: [],
      });
    }

    for (const item of workingItems) {
      if (exclude.has(item.id)) continue;
      items.push({
        trace: {
          id: item.id,
          kind: 'working',
          content: item.content,
          tokens: [],
          vector: new Map(),
          strength: item.activation,
          confidence: 0.5,
          intent: 'observed',
          affect: NEUTRAL_AFFECT,
          encodedAt: this.#now(),
          lastAccessAt: this.#now(),
          accessCount: 0,
          data: {},
        },
        store: 'working',
        relevance: clampUnit(item.activation * storeWeight('working')),
        strength: item.activation,
        via: 'direct',
        path: [],
      });
    }

    for (const association of associations) {
      if (exclude.has(association.concept.id)) continue;
      if (items.some((i) => i.trace.id === association.concept.id)) continue;
      items.push({
        trace: association.concept,
        store: 'semantic',
        // An association is weaker evidence than a direct match, but a strong
        // one should be able to outrank a weak direct hit — that is what makes
        // it a memory rather than a lookup table.
        relevance: clampUnit(association.activation * 0.8 * storeWeight('semantic')),
        strength: association.concept.strength,
        via: 'association',
        path: association.path,
      });
    }

    // ── 4. episodes reached back from associations ──
    const resonant: Episode[] = [];
    if (spreadDepth > 0 && associations.length > 0) {
      const associateLabels = associations.slice(0, 4).map((a) => a.concept.label);
      for (const label of associateLabels) {
        const concept = this.#semantic.get(label);
        if (concept === undefined) continue;
        const related = this.#episodesForConcept(concept);
        for (const episode of related) {
          if (exclude.has(episode.id)) continue;
          if (items.some((i) => i.trace.id === episode.id)) continue;
          const recency = decayFactor(this.#now() - episode.lastAccessAt, Math.max(1, 100));
          const relevance = clampUnit(
            0.35 * episode.strength * (0.6 + 0.4 * recency) * storeWeight('episodic') * moodFactor(mood, episode.affect),
          );
          if (relevance < threshold) continue;
          resonant.push(episode);
          items.push({
            trace: episode,
            store: 'episodic',
            relevance,
            strength: episode.strength,
            via: 'spread',
            path: [label],
          });
        }
      }
    }

    // ── 5. rank on one scale ──
    const filtered = items.filter((i) => i.relevance >= threshold);
    filtered.sort(
      (a, b) => b.relevance - a.relevance || a.trace.id.localeCompare(b.trace.id),
    );

    const top = filtered.slice(0, limit);

    // Recall is rehearsal: it is not neutral. Bringing something to mind
    // strengthens it, which is why remembering is not the same as reading.
    for (const item of top) {
      if (item.store === 'episodic') this.#episodic.retrieve(item.trace.id, { reinforce: true });
      else if (item.store === 'working') this.#working.get(item.trace.id);
    }

    const gist = top
      .filter((i): i is Recollection & { trace: Concept } => i.store === 'semantic')
      .map((i) => i.trace);

    this.#recalls += 1;

    return Object.freeze({
      items: Object.freeze(top.map((i) => Object.freeze({ ...i }))),
      gist: Object.freeze(gist),
      resonant: Object.freeze(resonant.slice(0, limit)),
      at: this.#now(),
      considered: Object.freeze({ ...considered }),
    });
  }

  /**
   * One-line answer to "what do I know about this?", for logs and traces.
   * Kept here rather than in a formatter so that the shape of a recollection
   * is decided by the memory layer, not by whoever happens to be printing it.
   */
  describe(result: RecallResult, maxItems = 5): string {
    if (result.items.length === 0) return 'nothing recalled';
    const parts = result.items.slice(0, maxItems).map((item) => {
      // Every kind of trace carries `content`, so no narrowing is needed — a
      // concept renders as "label: definition" and an episode as its text.
      const content = item.trace.content;
      const trimmed = content.length > 48 ? `${content.slice(0, 45)}...` : content;
      const route = item.via === 'direct' ? '' : ` (via ${item.path.join('>') || item.via})`;
      return `${item.store}:${trimmed}${route}`;
    });
    return parts.join(' | ');
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Which concepts a given episode contributed to.
   *
   * Found by matching the episode's id against the concept's sources rather
   * than by storing a back-reference. The semantic store is the authority on
   * its own grounding, so asking it avoids a second index that could disagree
   * with the first.
   */
  #conceptsFromEpisode(episode: Episode): string[] {
    const labels: string[] = [];
    for (const concept of this.#semantic.all()) {
      const sources = concept.data['sources'];
      if (Array.isArray(sources) && sources.includes(episode.id)) labels.push(concept.label);
    }
    if (labels.length > 0) return labels;

    // No recorded provenance (concepts formed by direct observation rather
    // than by consolidation). Fall back to content similarity, which is a
    // weaker but still useful route.
    const hits = this.#semantic.find({ text: episode.content, limit: 2, threshold: 0.3 });
    return hits.map((h) => h.concept.label);
  }

  #episodesForConcept(concept: Concept): readonly Episode[] {
    const sources = concept.data['sources'];
    if (Array.isArray(sources)) {
      const found = sources
        .map((id) => this.#episodic.get(String(id)))
        .filter((e): e is Episode => e !== undefined);
      if (found.length > 0) return found;
    }
    return this.#episodic.recall({ text: concept.label, limit: 3, threshold: 0.25, includeConsolidated: true }).map(
      (h) => h.episode,
    );
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Mood-congruence applied at the level of the rememberer.
 *
 * Positive congruence helps and negative congruence hurts, asymmetrically: a
 * matching mood gives a memory a modest lift, a mismatching one suppresses it
 * harder. That asymmetry is what makes rumination possible — a low mood
 * reaches unhappy memories and actively pushes happy ones out of reach.
 */
function moodFactor(mood: Affect, memory: Affect): number {
  const magnitude = affectMagnitude(mood);
  if (magnitude === 0) return 1;

  const memoryMagnitude = affectMagnitude(memory);
  const sameSign = Math.sign(mood.valence) === Math.sign(memory.valence);
  const product = mood.valence * memory.valence;

  if (sameSign && product > 0) return 1 + 0.25 * product * (0.5 + 0.5 * mood.arousal);
  return Math.max(0.4, 1 - 0.5 * magnitude * (0.5 + 0.5 * memoryMagnitude));
}

const clampUnit = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

export { clampUnit as clampRelevance };
