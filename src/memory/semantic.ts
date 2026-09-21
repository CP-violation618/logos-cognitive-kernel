/**
 * LOGOS :: Memory :: Semantic memory
 * ---------------------------------------------------------------------------
 * What is true, as opposed to what happened.
 *
 * The defining property of this store is that its contents are CONSTRUCTED,
 * not written. A concept does not appear because someone declared it; it
 * emerges when several distinct episodes keep pointing at the same thing, and
 * its definition is the intersection of what those episodes had in common.
 * That is the difference between a mind that has memorised a definition and
 * one that has formed a concept, and the architecture should be able to tell
 * you which it has.
 *
 * Three consequences follow, and each one is implemented rather than assumed:
 *
 *   1. GROUNDING. A concept remembers how many distinct episodes produced it.
 *      A concept grounded in one episode is a rumour; one grounded in twenty
 *      is knowledge. `grounding` is therefore part of confidence, not a
 *      statistic.
 *
 *   2. ASSOCIATIVE STRUCTURE. Concepts are not a flat vocabulary — they are a
 *      weighted graph. Traversal is spreading activation: activating one
 *      concept partially activates its neighbours, decaying with distance and
 *      edge strength. This is how "doctor" reaches "hospital" without anyone
 *      having written that link down.
 *
 *   3. CONTESTED ATTRIBUTES. When episodes disagree about a property, the
 *      store does not silently pick a winner. It keeps the disagreement and
 *      reduces confidence, because a concept the mind is unsure about is
 *      genuinely different from one it is sure about, and downstream reasoning
 *      needs to know which it is dealing with.
 */

import type { ConceptId, Credence, Tick } from '../kernel/types.ts';
import { LogosError, clampCredence } from '../kernel/types.ts';
import type { SparseVector } from './vector.ts';
import { blendedSimilarity, embed, tokenize } from './vector.ts';
import type { Concept, SemanticEdge } from './types.ts';
import { decayFactor } from './types.ts';

interface ConceptRecord {
  id: ConceptId;
  label: string;
  definition: string;
  aliases: string[];
  categories: string[];
  properties: Map<string, PropertyBelief>;
  tokens: readonly string[];
  vector: SparseVector;
  confidence: number;
  strength: number;
  /** Distinct episodes that contributed. Drives confidence, not just stats. */
  grounding: number;
  /**
   * Which episodes have already contributed.
   *
   * Grounding must count *distinct sources*, not observations. Seeing the same
   * thing five times in one situation is one piece of evidence; if it counted
   * as five, a mind would become wildly overconfident about whatever happened
   * to be in front of it. The set is what makes "distinct" mean distinct.
   */
  contributedEpisodes: Set<string>;
  /**
   * Durability as a function of grounding, recomputed rather than accumulated.
   *
   * Deriving it means grounding is the single source of truth for how
   * entrenched a concept is, and nothing can drift out of sync with it.
   */
  entrenchment: number;
  halfLife: number;
  encodedAt: Tick;
  lastAccessAt: Tick;
  accessCount: number;
}

/**
 * A belief about one property of a concept.
 *
 * Attributes are contested rather than assigned. Two episodes claiming
 * different colours for the same thing produce two competing beliefs with
 * separate support counts, and the reported value is whichever currently
 * commands more evidence — while `contested` stays true so a caller can tell
 * the difference between a settled fact and a coin flip.
 */
interface PropertyBelief {
  readonly key: string;
  /** Value -> accumulated support for it. */
  readonly values: Map<string, number>;
  totalSupport: number;
}

const valueOf = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

export interface SemanticMemoryOptions {
  /** Maximum concepts retained. */
  readonly capacity?: number;
  /** Baseline half-life; semantic memory is far more durable than episodic. */
  readonly baseHalfLife?: number;
  /** Similarity above which a new observation joins an existing concept. */
  readonly mergeThreshold?: number;
  /** Maximum edges traversed per node during spreading activation. */
  readonly fanOut?: number;
  /** Concepts weaker than this are eligible for forgetting. */
  readonly forgetThreshold?: number;
}

export interface ConceptObservation {
  readonly label: string;
  readonly definition?: string;
  readonly aliases?: readonly string[];
  readonly categories?: readonly string[];
  readonly properties?: Readonly<Record<string, unknown>>;
  /** Id of the episode this came from. Drives grounding. */
  readonly sourceEpisode?: string;
  /** Caller's confidence in this particular observation. */
  readonly confidence?: number;
  /** Situational context, used to detect when a concept is context-bound. */
  readonly context?: string;
}

export interface ConceptQuery {
  readonly text?: string;
  readonly label?: string;
  readonly category?: string;
  /** Require a specific property value. */
  readonly hasProperty?: Readonly<Record<string, unknown>>;
  readonly limit?: number;
  readonly threshold?: number;
  readonly exclude?: readonly string[];
}

export interface ConceptHit {
  readonly concept: Concept;
  readonly score: number;
  readonly components: {
    readonly similarity: number;
    readonly grounding: number;
    readonly strength: number;
    readonly recency: number;
  };
}

/**
 * The result of spreading activation from one or more concepts.
 *
 * `activation` is the raw diffusion result. `path` records how each node was
 * reached, which is what makes an association auditable: a mind that connected
 * two ideas should be able to say by what route.
 */
export interface Association {
  readonly concept: Concept;
  readonly activation: number;
  readonly depth: number;
  readonly path: readonly string[];
}

export interface SemanticStats {
  readonly concepts: number;
  readonly edges: number;
  readonly capacity: number;
  readonly tick: number;
  readonly observations: number;
  readonly formed: number;
  readonly merged: number;
  readonly contestedProperties: number;
  readonly meanGrounding: number;
  readonly meanConfidence: number;
  readonly meanDegree: number;
}

export class SemanticMemory {
  readonly #capacity: number;
  readonly #baseHalfLife: number;
  readonly #mergeThreshold: number;
  readonly #fanOut: number;
  readonly #forgetThreshold: number;

  readonly #concepts = new Map<ConceptId, ConceptRecord>();
  /** Edge key is `from|relation|to` so a pair may hold several relations. */
  readonly #edges = new Map<string, SemanticEdge>();
  /** Adjacency index, rebuilt lazily after mutation. */
  #adjacency: Map<ConceptId, string[]> | undefined;
  /** Label -> concept, lowercased, for fast exact lookup. */
  #byLabel = new Map<string, ConceptId>();

  #tick = 0;
  #seq = 0;
  #observations = 0;
  #formed = 0;
  #merged = 0;

  constructor(options: SemanticMemoryOptions = {}) {
    this.#capacity = Math.max(1, Math.floor(options.capacity ?? 5_000));
    this.#baseHalfLife = Math.max(1, options.baseHalfLife ?? 4_000);
    this.#mergeThreshold = Math.min(1, Math.max(0, options.mergeThreshold ?? 0.62));
    this.#fanOut = Math.max(1, Math.floor(options.fanOut ?? 12));
    this.#forgetThreshold = Math.max(0, options.forgetThreshold ?? 0.02);
  }

  // ── introspection ─────────────────────────────────────────────────────────

  get size(): number {
    return this.#concepts.size;
  }

  get edgeCount(): number {
    return this.#edges.size;
  }

  get tick(): number {
    return this.#tick;
  }

  stats(): SemanticStats {
    const list = [...this.#concepts.values()];
    const n = list.length;
    return Object.freeze({
      concepts: n,
      edges: this.#edges.size,
      capacity: this.#capacity,
      tick: this.#tick,
      observations: this.#observations,
      formed: this.#formed,
      merged: this.#merged,
      contestedProperties: list.reduce(
        (acc, c) => acc + [...c.properties.values()].filter((p) => isContested(p)).length,
        0,
      ),
      meanGrounding: n === 0 ? 0 : list.reduce((a, c) => a + c.grounding, 0) / n,
      meanConfidence: n === 0 ? 0 : list.reduce((a, c) => a + c.confidence, 0) / n,
      meanDegree: n === 0 ? 0 : (2 * this.#edges.size) / n,
    });
  }

  has(label: string): boolean {
    return this.#byLabel.has(label.trim().toLowerCase());
  }

  /** Exact lookup by label or alias. */
  get(label: string): Concept | undefined {
    const id = this.#byLabel.get(label.trim().toLowerCase());
    return id === undefined ? undefined : this.#view(id);
  }

  getById(id: string): Concept | undefined {
    return this.#view(id as ConceptId);
  }

  all(): readonly Concept[] {
    return [...this.#concepts.keys()].map((id) => this.#view(id)).filter((c): c is Concept => c !== undefined);
  }

  /** The resolved value of a property, and whether the evidence disagrees. */
  property(label: string, key: string): { value: unknown; support: number; contested: boolean } | undefined {
    const id = this.#byLabel.get(label.trim().toLowerCase());
    if (id === undefined) return undefined;
    const record = this.#concepts.get(id);
    const belief = record?.properties.get(key);
    if (belief === undefined) return undefined;

    const ranked = [...belief.values.entries()].sort((a, b) => b[1] - a[1]);
    const best = ranked[0];
    if (best === undefined) return undefined;

    return {
      value: best[0],
      support: belief.totalSupport === 0 ? 0 : best[1] / belief.totalSupport,
      contested: isContested(belief),
    };
  }

  // ── construction ──────────────────────────────────────────────────────────

  /**
   * Absorb one observation, forming or updating a concept.
   *
   * The `sourceEpisode` argument is not decoration. Grounding is computed from
   * the SET of distinct episodes that contributed, so observing the same thing
   * five times in one situation is one piece of evidence, not five. Without
   * that distinction a mind would become wildly overconfident about whatever
   * it happened to be looking at.
   */
  observe(observation: ConceptObservation): { readonly id: ConceptId; readonly created: boolean; readonly mergedInto?: ConceptId } {
    const label = observation.label?.trim();
    if (label === undefined || label.length === 0) {
      throw new LogosError('SEMANTIC_EMPTY_LABEL', 'a concept observation needs a label', { observation });
    }

    this.#observations += 1;

    // ── exact match first: labels and aliases are strong evidence ──
    const existingId = this.#byLabel.get(label.toLowerCase());
    if (existingId !== undefined) {
      this.#merge(existingId, observation, label);
      this.#merged += 1;
      return { id: existingId, created: false };
    }

    // ── then semantic match, which is what catches synonyms ──
    const probeText = `${label} ${observation.definition ?? ''}`.trim();
    const vector = embed(probeText);
    const tokens = tokenize(probeText);
    const nearest = this.#nearestConcept(vector, tokens);
    if (nearest !== undefined && nearest.score >= this.#mergeThreshold) {
      this.#merge(nearest.record.id, observation, label);
      this.#merged += 1;
      return { id: nearest.record.id, created: false, mergedInto: nearest.record.id };
    }

    // ── genuinely new concept ──
    this.#seq += 1;
    const id = `con${this.#seq}` as ConceptId;
    const grounding = observation.sourceEpisode === undefined ? 0 : 1;
    const record: ConceptRecord = {
      id,
      label,
      definition: observation.definition ?? '',
      aliases: [...(observation.aliases ?? [])],
      categories: [...(observation.categories ?? [])],
      properties: new Map(),
      tokens,
      vector,
      // A concept seen once is a hypothesis. Seed confidence below the
      // caller's, and let grounding promote it.
      confidence: clampCredence((observation.confidence ?? 0.7) * 0.6),
      strength: 0.55,
      grounding,
      contributedEpisodes: new Set(observation.sourceEpisode === undefined ? [] : [observation.sourceEpisode]),
      // Durability is derived from grounding and kept in sync on every merge.
      entrenchment: entrenchmentFor(grounding),
      halfLife: this.#baseHalfLife,
      encodedAt: this.#asTick(),
      lastAccessAt: this.#asTick(),
      accessCount: 0,
    };

    this.#applyProperties(record, observation);

    this.#concepts.set(id, record);
    this.#byLabel.set(label.toLowerCase(), id);
    for (const alias of record.aliases) this.#byLabel.set(alias.toLowerCase(), id);
    this.#formed += 1;
    this.#adjacency = undefined;
    this.#enforceCapacity();

    return { id, created: true };
  }

  /**
   * Link two concepts with a relation.
   *
   * Repeated traversal and repeated assertion both strengthen the edge, and
   * the edge's confidence tracks how often it has been supported rather than
   * being fixed at creation.
   */
  relate(
    fromLabel: string,
    relation: string,
    toLabel: string,
    options: { readonly weight?: number; readonly confidence?: number } = {},
  ): SemanticEdge | undefined {
    const from = this.#byLabel.get(fromLabel.trim().toLowerCase());
    const to = this.#byLabel.get(toLabel.trim().toLowerCase());
    if (from === undefined || to === undefined) return undefined;

    const key = `${from}|${relation}|${to}`;
    const existing = this.#edges.get(key);
    const weight = clampUnit(options.weight ?? 0.5);

    if (existing !== undefined) {
      // Reinforcement: each assertion adds evidence and nudges weight up with
      // diminishing returns, so a link asserted once stays tentative.
      const support = existing.support + 1;
      const updated: SemanticEdge = Object.freeze({
        from: existing.from,
        to: existing.to,
        relation: existing.relation,
        weight: clampUnit(existing.weight + (weight - existing.weight) / support),
        support,
        confidence: clampCredence(1 - 1 / (1 + support)),
        updatedAt: this.#asTick(),
      });
      this.#edges.set(key, updated);
      return updated;
    }

    const edge: SemanticEdge = Object.freeze({
      from,
      to,
      relation,
      weight,
      support: 1,
      confidence: clampCredence(options.confidence ?? 0.5),
      updatedAt: this.#asTick(),
    });
    this.#edges.set(key, edge);
    this.#adjacency = undefined;
    return edge;
  }

  /** Outgoing edges of a concept, strongest first. */
  edgesFrom(label: string): readonly SemanticEdge[] {
    const id = this.#byLabel.get(label.trim().toLowerCase());
    if (id === undefined) return [];
    return [...this.#edges.values()]
      .filter((e) => e.from === id)
      .sort((a, b) => b.weight - a.weight);
  }

  /** Incoming edges, strongest first. */
  edgesTo(label: string): readonly SemanticEdge[] {
    const id = this.#byLabel.get(label.trim().toLowerCase());
    if (id === undefined) return [];
    return [...this.#edges.values()]
      .filter((e) => e.to === id)
      .sort((a, b) => b.weight - a.weight);
  }

  // ── retrieval ─────────────────────────────────────────────────────────────

  /** Concepts matching a query, best first. */
  find(query: ConceptQuery = {}): readonly ConceptHit[] {
    const limit = Math.max(0, query.limit ?? 8);
    const threshold = clampUnit(query.threshold ?? 0.1);
    const exclude = new Set(query.exclude ?? []);
    const probeText = [query.text ?? '', query.label ?? ''].join(' ').trim();
    const probeVector = probeText.length > 0 ? embed(probeText) : undefined;
    const probeTokens = probeText.length > 0 ? tokenize(probeText) : [];

    const hits: ConceptHit[] = [];
    for (const record of this.#concepts.values()) {
      if (exclude.has(record.id)) continue;
      if (query.label !== undefined && record.label.toLowerCase() !== query.label.trim().toLowerCase()) continue;
      if (query.category !== undefined && !record.categories.includes(query.category)) continue;
      if (query.hasProperty !== undefined && !hasProperties(record, query.hasProperty)) continue;

      const similarity =
        probeVector === undefined
          ? 0.5
          : blendedSimilarity(probeVector, probeTokens, record.vector, record.tokens);

      // Grounding is folded into the score, not merely reported: a concept the
      // mind has seen many times should outrank one it glimpsed once, even at
      // equal textual similarity.
      const grounding = clampUnit(Math.log1p(record.grounding) / Math.log1p(8));
      const recency = decayFactor(this.#tick - record.lastAccessAt, Math.max(1, record.halfLife * 2));

      const score = clampUnit(
        0.45 * similarity + 0.2 * grounding + 0.2 * record.strength + 0.1 * record.confidence + 0.05 * recency,
      );
      if (score < threshold) continue;

      hits.push({
        concept: this.#view(record.id) as Concept,
        score,
        components: {
          similarity: round(similarity),
          grounding: round(grounding),
          strength: round(record.strength),
          recency: round(recency),
        },
      });
    }

    hits.sort((a, b) => b.score - a.score || a.concept.label.localeCompare(b.concept.label));
    return hits.slice(0, limit);
  }

  /**
   * Spreading activation from one or more seeds.
   *
   * Activation flows along edges, multiplied by edge weight and attenuated per
   * hop. Two properties matter and both are deliberate:
   *
   *   · a node reached by several routes accumulates their contributions, so
   *     a strongly-connected concept surfaces even if no single path is strong;
   *   · activation never flows back to where it came from, which prevents the
   *     trivial echo that would otherwise make every seed its own best
   *     association.
   */
  spread(
    seeds: readonly string[],
    options: { readonly depth?: number; readonly decay?: number; readonly limit?: number; readonly minActivation?: number } = {},
  ): readonly Association[] {
    const maxDepth = Math.max(1, Math.floor(options.depth ?? 2));
    const decay = clampUnit(options.decay ?? 0.6);
    const limit = Math.max(1, options.limit ?? 12);
    const minActivation = Math.max(0, options.minActivation ?? 0.05);

    const activation = new Map<ConceptId, number>();
    const best = new Map<ConceptId, { depth: number; path: string[] }>();
    const adjacency = this.#buildAdjacency();

    interface Frontier {
      readonly id: ConceptId;
      readonly level: number;
      readonly path: readonly string[];
      readonly from: ConceptId | undefined;
    }

    let frontier: Frontier[] = [];
    for (const seed of seeds) {
      const id = this.#byLabel.get(seed.trim().toLowerCase());
      if (id === undefined) continue;
      activation.set(id, 1);
      best.set(id, { depth: 0, path: [seed] });
      frontier.push({ id, level: 0, path: [seed], from: undefined });
    }

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: Frontier[] = [];
      for (const node of frontier) {
        const incoming = activation.get(node.id) ?? 0;
        const edgeKeys = adjacency.get(node.id) ?? [];
        const ranked = edgeKeys
          .map((k) => this.#edges.get(k))
          .filter((e): e is SemanticEdge => e !== undefined)
          .slice(0, this.#fanOut);

        for (const edge of ranked) {
          // Do not immediately bounce back where we came from.
          if (edge.to === node.from) continue;

          const contribution = incoming * edge.weight * edge.confidence * decay;
          if (contribution < minActivation) continue;

          const previous = activation.get(edge.to) ?? 0;
          activation.set(edge.to, clampUnit(previous + contribution));

          const previousPath = best.get(edge.to);
          if (previousPath === undefined || previousPath.depth > depth + 1) {
            best.set(edge.to, { depth: depth + 1, path: [...node.path, this.#labelOf(edge.to)] });
          }
          if (contribution > minActivation) {
            next.push({ id: edge.to, level: depth + 1, path: best.get(edge.to)?.path ?? [], from: node.id });
          }
        }
      }
      frontier = next;
    }

    const seedIds = new Set(
      seeds.map((s) => this.#byLabel.get(s.trim().toLowerCase())).filter((id): id is ConceptId => id !== undefined),
    );

    const results: Association[] = [];
    for (const [id, level] of activation) {
      if (seedIds.has(id)) continue; // seeds are the question, not the answer
      const record = this.#concepts.get(id);
      if (record === undefined) continue;
      const info = best.get(id);
      results.push({
        concept: this.#view(id) as Concept,
        activation: round(level),
        depth: info?.depth ?? 0,
        path: info?.path ?? [],
      });
    }

    results.sort((a, b) => b.activation - a.activation || a.concept.label.localeCompare(b.concept.label));
    return results.slice(0, limit);
  }

  // ── the passage of time ───────────────────────────────────────────────────

  /**
   * Decay concepts and forget the faint ones.
   *
   * Semantic memory decays far more slowly than episodic, and grounding slows
   * it further: a concept built from many episodes is more entrenched than one
   * built from a single observation, and should survive longer without use.
   */
  step(): readonly string[] {
    this.#tick += 1;
    const lost: string[] = [];

    for (const record of this.#concepts.values()) {
      // Durability is a function of grounding, so a well-grounded concept
      // decays more slowly without anything having to track that separately.
      record.strength *= decayFactor(1, record.halfLife * record.entrenchment);

      if (record.strength >= this.#forgetThreshold) continue;
      if (this.#tick - record.lastAccessAt < record.halfLife) continue;

      this.#concepts.delete(record.id);
      this.#byLabel.delete(record.label.toLowerCase());
      for (const alias of record.aliases) this.#byLabel.delete(alias.toLowerCase());
      for (const [key, edge] of [...this.#edges]) {
        if (edge.from === record.id || edge.to === record.id) this.#edges.delete(key);
      }
      this.#adjacency = undefined;
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

  forget(label: string): boolean {
    const id = this.#byLabel.get(label.trim().toLowerCase());
    if (id === undefined) return false;
    const record = this.#concepts.get(id);
    if (record === undefined) return false;

    this.#concepts.delete(id);
    this.#byLabel.delete(record.label.toLowerCase());
    for (const alias of record.aliases) this.#byLabel.delete(alias.toLowerCase());
    for (const [key, edge] of [...this.#edges]) {
      if (edge.from === id || edge.to === id) this.#edges.delete(key);
    }
    this.#adjacency = undefined;
    return true;
  }

  clear(): void {
    this.#concepts.clear();
    this.#edges.clear();
    this.#byLabel.clear();
    this.#adjacency = undefined;
    this.#tick = 0;
    this.#seq = 0;
    this.#observations = 0;
    this.#formed = 0;
    this.#merged = 0;
  }

  /** Detect internal inconsistency. */
  check(): readonly string[] {
    const problems: string[] = [];
    if (this.#concepts.size > this.#capacity) {
      problems.push(`over capacity: ${this.#concepts.size} > ${this.#capacity}`);
    }
    for (const [label, id] of this.#byLabel) {
      if (!this.#concepts.has(id)) problems.push(`label index points at missing concept: ${label} -> ${id}`);
    }
    for (const record of this.#concepts.values()) {
      if (this.#byLabel.get(record.label.toLowerCase()) !== record.id) {
        problems.push(`concept ${record.label} is not reachable by its own label`);
      }
      if (!Number.isFinite(record.strength) || record.strength < 0) {
        problems.push(`concept ${record.label} has invalid strength ${record.strength}`);
      }
    }
    for (const edge of this.#edges.values()) {
      if (!this.#concepts.has(edge.from)) problems.push(`edge ${edge.relation} has missing source ${edge.from}`);
      if (!this.#concepts.has(edge.to)) problems.push(`edge ${edge.relation} has missing target ${edge.to}`);
    }
    return problems;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #merge(id: ConceptId, observation: ConceptObservation, rawLabel: string): void {
    const record = this.#concepts.get(id);
    if (record === undefined) return;

    // A new surface form for a known concept is an alias, not a new concept.
    const lower = rawLabel.toLowerCase();
    if (lower !== record.label.toLowerCase() && !record.aliases.some((a) => a.toLowerCase() === lower)) {
      record.aliases.push(rawLabel);
      this.#byLabel.set(lower, id);
    }

    if (observation.definition !== undefined && observation.definition.length > 0) {
      if (record.definition.length === 0) {
        record.definition = observation.definition;
      } else if (!record.definition.includes(observation.definition)) {
        // Definitions accumulate rather than overwrite: a later observation
        // adds detail instead of erasing what earlier ones established.
        record.definition = `${record.definition}; ${observation.definition}`;
      }
    }

    for (const category of observation.categories ?? []) {
      if (!record.categories.includes(category)) record.categories.push(category);
    }

    this.#applyProperties(record, observation);

    // Grounding counts DISTINCT episodes. Observing the same source again
    // strengthens the concept's activation but is not new evidence, and must
    // not raise confidence or entrenchment.
    let novelEvidence = false;
    if (observation.sourceEpisode !== undefined && !record.contributedEpisodes.has(observation.sourceEpisode)) {
      record.contributedEpisodes.add(observation.sourceEpisode);
      record.grounding += 1;
      novelEvidence = true;
    }

    if (novelEvidence) {
      const target = clampCredence(observation.confidence ?? 0.7);
      record.confidence = clampCredence(record.confidence + (target - record.confidence) / (1 + record.grounding));
      record.strength = clampUnit(record.strength + 0.1 / Math.sqrt(1 + record.grounding));
      // Durability follows grounding, derived rather than incremented so it
      // can never drift out of sync with the count it is supposed to reflect.
      record.entrenchment = entrenchmentFor(record.grounding);
      record.halfLife = Math.max(record.halfLife, this.#baseHalfLife * record.entrenchment);
    }

    record.lastAccessAt = this.#asTick();
    record.accessCount += 1;

    // The vector is refreshed so later retrieval sees the accumulated meaning.
    const merged = `${record.label} ${record.definition} ${record.aliases.join(' ')}`.trim();
    record.tokens = tokenize(merged);
    record.vector = embed(merged);
  }

  /**
   * Fold an observation's properties into a concept's beliefs.
   *
   * Disagreement is preserved. If two observations claim different values for
   * one key, both are stored and the concept is marked contested — a mind that
   * has noticed a contradiction is in a genuinely different state from one
   * that has not, and flattening that away would be a loss of information, not
   * a simplification.
   */
  #applyProperties(record: ConceptRecord, observation: ConceptObservation): void {
    let contradicted = false;

    for (const [key, raw] of Object.entries(observation.properties ?? {})) {
      const value = valueOf(raw);
      let belief = record.properties.get(key);
      if (belief === undefined) {
        belief = { key, values: new Map(), totalSupport: 0 };
        record.properties.set(key, belief);
      } else if (!belief.values.has(value) && belief.values.size > 0) {
        contradicted = true;
      }
      belief.values.set(value, (belief.values.get(value) ?? 0) + 1);
      belief.totalSupport += 1;
    }

    // Noticing a contradiction is itself evidence of uncertainty, so it
    // lowers confidence. This is what stops a mind from being equally sure of
    // a settled fact and a disputed one.
    if (contradicted) record.confidence = clampCredence(record.confidence * 0.85);
  }

  #nearestConcept(vector: SparseVector, tokens: readonly string[]): { record: ConceptRecord; score: number } | undefined {
    let best: { record: ConceptRecord; score: number } | undefined;
    for (const record of this.#concepts.values()) {
      const score = blendedSimilarity(vector, tokens, record.vector, record.tokens);
      if (best === undefined || score > best.score) best = { record, score };
    }
    return best;
  }

  /** Adjacency is rebuilt lazily because edges change far less often than reads. */
  #buildAdjacency(): Map<ConceptId, string[]> {
    if (this.#adjacency !== undefined) return this.#adjacency;
    const index = new Map<ConceptId, string[]>();
    for (const [key, edge] of this.#edges) {
      const list = index.get(edge.from);
      if (list === undefined) index.set(edge.from, [key]);
      else list.push(key);
    }
    // Sort each bucket by weight so `fanOut` keeps the strongest links.
    for (const [id, keys] of index) {
      keys.sort((a, b) => (this.#edges.get(b)?.weight ?? 0) - (this.#edges.get(a)?.weight ?? 0));
      index.set(id, keys);
    }
    this.#adjacency = index;
    return index;
  }

  #labelOf(id: ConceptId): string {
    return this.#concepts.get(id)?.label ?? String(id);
  }

  #enforceCapacity(): void {
    if (this.#concepts.size <= this.#capacity) return;

    // Least grounded first: when a full store must shed something, it should
    // shed the rumours and keep the knowledge.
    const ranked = [...this.#concepts.values()].sort(
      (a, b) => a.grounding - b.grounding || a.strength - b.strength,
    );
    const excess = this.#concepts.size - this.#capacity;
    for (const victim of ranked.slice(0, excess)) {
      this.forget(victim.label);
    }
  }

  #view(id: ConceptId): Concept | undefined {
    const record = this.#concepts.get(id);
    if (record === undefined) return undefined;

    const properties: Record<string, unknown> = {};
    for (const [key, belief] of record.properties) {
      const ranked = [...belief.values.entries()].sort((a, b) => b[1] - a[1]);
      const best = ranked[0];
      if (best === undefined) continue;
      properties[key] = isContested(belief) ? { value: best[0], contested: true, alternatives: ranked.slice(1).map((r) => r[0]) } : best[0];
    }

    return Object.freeze({
      id: record.id,
      kind: 'semantic' as const,
      content: record.definition.length > 0 ? `${record.label}: ${record.definition}` : record.label,
      tokens: record.tokens,
      vector: record.vector,
      strength: round(record.strength),
      confidence: record.confidence,
      intent: 'inferred' as const,
      affect: Object.freeze({ valence: 0, arousal: 0 }),
      encodedAt: record.encodedAt,
      lastAccessAt: record.lastAccessAt,
      accessCount: record.accessCount,
      label: record.label,
      definition: record.definition,
      aliases: Object.freeze([...record.aliases]),
      categories: Object.freeze([...record.categories]),
      properties: Object.freeze(properties),
      grounding: record.grounding,
      data: Object.freeze({ edges: this.#edges.size }),
    });
  }

  #asTick(): Tick {
    return this.#tick as Tick;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** A property is contested when no single value commands a clear majority. */
function isContested(belief: PropertyBelief): boolean {
  if (belief.values.size <= 1) return false;
  const ranked = [...belief.values.values()].sort((a, b) => b - a);
  const top = ranked[0] ?? 0;
  return belief.totalSupport > 0 && top / belief.totalSupport < 0.75;
}

/**
 * How much more durable a concept is for having been built from `grounding`
 * distinct episodes.
 *
 * A concept abstracted from twenty experiences is knowledge; one abstracted
 * from a single experience is a hypothesis, and it should be the first to go
 * when the store is under pressure. The logarithmic shape keeps the tenth
 * episode from mattering as much as the first.
 */
function entrenchmentFor(grounding: number): number {
  return 1 + 0.5 * Math.log1p(Math.max(0, grounding));
}

function hasProperties(
  record: ConceptRecord,
  wanted: Readonly<Record<string, unknown>>,
): boolean {
  for (const [key, value] of Object.entries(wanted)) {
    const belief = record.properties.get(key);
    if (belief === undefined) return false;
    const expected = valueOf(value);
    if (!belief.values.has(expected)) return false;
  }
  return true;
}

const clampUnit = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
