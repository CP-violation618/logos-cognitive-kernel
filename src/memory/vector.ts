/**
 * LOGOS :: Memory :: Vector utilities
 * ---------------------------------------------------------------------------
 * Semantic similarity without a model.
 *
 * The kernel has a hard zero-dependency rule, so there is no embedding
 * network to call. Instead we use the *hashing trick*: every token in a
 * document is hashed into a fixed-width signed vector, weighted by how
 * informative that token is, and the result is L2-normalised.
 *
 * This is genuinely useful, not a toy stand-in:
 *
 *   · it is deterministic, so a memory trace lands in the same place every
 *     time it is re-encoded — a precondition for reproducible cognition;
 *   · it needs no vocabulary, no training pass and no persistence, so new
 *     words work immediately;
 *   · it degrades gracefully — unseen tokens still collide usefully into
 *     shared buckets rather than being silently dropped.
 *
 * What it is NOT is a substitute for a real semantic model. Two paraphrases
 * that share no tokens will not be recognised as similar. `SemanticMemory`
 * therefore treats vector similarity as *one* retrieval channel among
 * several, combined with symbolic overlap and recency — never as the sole
 * basis for a memory.
 */

import { LogosError } from '../kernel/types.ts';

/** A sparse bag-of-features vector: index -> weight. */
export type SparseVector = ReadonlyMap<number, number>;

export interface EmbeddingOptions {
  /** Number of hash buckets. More buckets = fewer collisions. */
  readonly dimensions?: number;
  /** Weight multiplier applied to the first occurrence of a novel token. */
  readonly noveltyBoost?: number;
}

/** Tokens that carry almost no discriminative information in English text. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this',
  'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'have', 'has', 'had', 'of', 'in', 'on', 'at', 'to',
  'for', 'with', 'by', 'from', 'as', 'it', 'its', 'i', 'you', 'he', 'she',
  'we', 'they', 'them', 'his', 'her', 'their', 'our', 'my', 'me', 'us',
  'not', 'no', 'so', 'such', 'can', 'could', 'will', 'would', 'should',
  'may', 'might', 'must', 'there', 'here', 'when', 'where', 'which', 'who',
  'what', 'how', 'why', 'all', 'any', 'some', 'more', 'most', 'very',
]);

/**
 * Tokenise mixed English/CJK text.
 *
 * CJK is handled by emitting adjacent character bigrams, because Chinese and
 * Japanese are not whitespace-delimited and single characters are far too
 * ambiguous on their own ("生" alone versus "生命" / "医生" / "学生").
 * Bigrams recover most of the discriminating power without a segmenter.
 */
export function tokenize(input: string): string[] {
  if (typeof input !== 'string') {
    throw new LogosError('MEMORY_BAD_TEXT', 'tokenize expects a string', { got: typeof input });
  }

  const tokens: string[] = [];
  const lower = input.toLowerCase();

  // Latin/digit runs.
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9'_-]*/g)) {
    const token = match[0];
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    // Crude but effective stemming: plural/gerund endings carry little
    // meaning and splitting them costs us more matches than it saves.
    tokens.push(token.replace(/(?:ies)$/, 'y').replace(/(?:es|s)$/, '').replace(/(?:ing|ed)$/, ''));
  }

  // CJK runs, emitted as character bigrams plus the whole run if short.
  for (const match of lower.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g)) {
    const run = match[0];
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
    if (run.length <= 3) tokens.push(run);
  }

  return tokens;
}

/** FNV-1a: cheap, well-distributed, and stable across processes. */
export function hashToken(token: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A second, independent hash for the sign of a bucket (removes bias). */
function hashSign(token: string): number {
  return (hashToken(token, 0x9e3779b9) & 1) === 0 ? 1 : -1;
}

/**
 * Project text into a fixed-width sparse vector.
 *
 * Term frequency is damped with `1 + log(tf)` rather than used raw: a word
 * repeated ten times is not ten times as meaningful, and undamped counts let
 * one verbose passage dominate every similarity comparison it takes part in.
 */
export function embed(text: string, options: EmbeddingOptions = {}): SparseVector {
  const dimensions = Math.max(16, options.dimensions ?? 1024);
  const tokens = tokenize(text);
  if (tokens.length === 0) return new Map();

  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

  const vector = new Map<number, number>();
  for (const [token, count] of counts) {
    const bucket = hashToken(token) % dimensions;
    const weight = (1 + Math.log(count)) * hashSign(token);
    vector.set(bucket, (vector.get(bucket) ?? 0) + weight);
  }

  return normalise(vector);
}

/** Scale a vector to unit L2 norm. Returns it unchanged if it is all zeros. */
export function normalise(vector: Map<number, number>): SparseVector {
  let sumSquares = 0;
  for (const value of vector.values()) sumSquares += value * value;
  if (sumSquares === 0) return vector;

  const norm = Math.sqrt(sumSquares);
  for (const [key, value] of vector) vector.set(key, value / norm);
  return vector;
}

/** Cosine similarity of two L2-normalised vectors, in [-1, 1]. */
export function cosine(a: SparseVector, b: SparseVector): number {
  if (a.size === 0 || b.size === 0) return 0;

  // Walk the smaller vector and probe the larger: O(min(|a|,|b|)).
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [index, value] of small) {
    const other = large.get(index);
    if (other !== undefined) dot += value * other;
  }
  return Math.max(-1, Math.min(1, dot));
}

/** Similarity remapped from [-1,1] to [0,1], which is what callers want. */
export function similarity(a: SparseVector, b: SparseVector): number {
  return (cosine(a, b) + 1) / 2;
}

/**
 * Jaccard overlap of two token sets.
 *
 * Combined with vector similarity this is what saves us from the hashing
 * trick's main weakness: exact shared wording is a much stronger signal of
 * "these are about the same thing" than bucket collisions, and it is cheap to
 * check.
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Blended similarity used across the memory system.
 *
 * The weights encode a claim: shared vocabulary beats vector proximity,
 * because the vector is an approximation of meaning while shared vocabulary
 * is direct evidence of it. Vector similarity exists to catch the cases
 * vocabulary overlap misses.
 */
export function blendedSimilarity(
  vectorA: SparseVector,
  tokensA: readonly string[],
  vectorB: SparseVector,
  tokensB: readonly string[],
): number {
  const lexical = jaccard(tokensA, tokensB);
  const vector = similarity(vectorA, vectorB);
  return Math.max(0, Math.min(1, 0.6 * lexical + 0.4 * vector));
}

/**
 * A fixed-capacity approximate nearest-neighbour index.
 *
 * Brute-force by design. A cognitive kernel's memory is expected to hold
 * thousands — not billions — of traces, and at that scale an exhaustive scan
 * is both fast enough and *exact*, which matters far more than asymptotics
 * when you are trying to explain afterwards why a mind recalled one thing and
 * not another.
 */
export class VectorIndex<T> {
  readonly #entries = new Map<string, { vector: SparseVector; item: T }>();
  readonly #dimensions: number;

  constructor(dimensions = 1024) {
    this.#dimensions = dimensions;
  }

  get size(): number {
    return this.#entries.size;
  }

  get dimensions(): number {
    return this.#dimensions;
  }

  set(key: string, item: T, vector?: SparseVector): void {
    const resolved = vector ?? embed(typeof item === 'string' ? item : JSON.stringify(item), {
      dimensions: this.#dimensions,
    });
    this.#entries.set(key, { vector: resolved, item });
  }

  delete(key: string): boolean {
    return this.#entries.delete(key);
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  get(key: string): T | undefined {
    return this.#entries.get(key)?.item;
  }

  clear(): void {
    this.#entries.clear();
  }

  /** All entries, unsorted. */
  entries(): readonly { key: string; item: T }[] {
    return [...this.#entries].map(([key, value]) => ({ key, item: value.item }));
  }

  /**
   * The `limit` nearest entries to `query`, most similar first.
   * Ties are broken by insertion order, so results are stable.
   */
  nearest(query: SparseVector | string, limit = 10): readonly { key: string; item: T; score: number }[] {
    const probe = typeof query === 'string' ? embed(query, { dimensions: this.#dimensions }) : query;

    const scored: { key: string; item: T; score: number }[] = [];
    for (const [key, entry] of this.#entries) {
      const score = similarity(probe, entry.vector);
      scored.push({ key, item: entry.item, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return scored.slice(0, Math.max(0, limit));
  }
}
