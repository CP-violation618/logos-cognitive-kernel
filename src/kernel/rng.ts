/**
 * LOGOS :: Kernel :: Randomness
 * ---------------------------------------------------------------------------
 * All stochastic behaviour in the kernel flows through one seeded generator.
 *
 * This is a hard requirement, not a nicety. Cognitive architectures make
 * random choices constantly — which memory to probe first, which goal to
 * pursue when two tie, which hypothesis to sample. If those choices come from
 * `Math.random()`, then a bug report cannot be reproduced, a benchmark cannot
 * be compared across commits, and a regression test cannot assert on anything
 * that depends on ordering.
 *
 * The generator is xoshiro128** — small, fast, and with a well-characterised
 * period (2^128 - 1) that comfortably exceeds any session length. It is not
 * cryptographic and must never be used for anything security-relevant.
 */

import { LogosError } from './types.ts';

/** Deterministic uniform/normal/exponential source. */
export class Rng {
  #s0: number;
  #s1: number;
  #s2: number;
  #s3: number;
  #spare: number | undefined;

  constructor(seed: number) {
    if (!Number.isFinite(seed)) {
      throw new LogosError('RNG_BAD_SEED', `seed must be a finite number, got ${seed}`, { seed });
    }
    // SplitMix32 keying: turns any 32-bit seed, including 0, into a
    // well-distributed non-zero state vector.
    let x = (Math.floor(seed) >>> 0) || 0x9e3779b9;
    const next = (): number => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.#s0 = next();
    this.#s1 = next();
    this.#s2 = next();
    this.#s3 = next();
  }

  /** Derive an independent stream. Useful to give each subsystem its own. */
  fork(label: string): Rng {
    let h = 0x811c9dc5;
    for (let i = 0; i < label.length; i += 1) {
      h ^= label.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return new Rng((h ^ this.uint32()) >>> 0);
  }

  /** Uniform 32-bit unsigned integer. */
  uint32(): number {
    const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;
    const result = Math.imul(rotl(Math.imul(this.#s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.#s1 << 9) >>> 0;

    this.#s2 = (this.#s2 ^ this.#s0) >>> 0;
    this.#s3 = (this.#s3 ^ this.#s1) >>> 0;
    this.#s1 = (this.#s1 ^ this.#s2) >>> 0;
    this.#s0 = (this.#s0 ^ this.#s3) >>> 0;
    this.#s2 = (this.#s2 ^ t) >>> 0;
    this.#s3 = rotl(this.#s3, 11);

    return result;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.uint32() / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    if (max <= min) return min;
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** Pick one element, or undefined for an empty list. */
  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[Math.floor(this.next() * items.length)];
  }

  /** Normal distribution (Box–Muller), with the usual cached spare value. */
  normal(mean = 0, stdDev = 1): number {
    if (this.#spare !== undefined) {
      const z = this.#spare;
      this.#spare = undefined;
      return mean + z * stdDev;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    this.#spare = v * factor;
    return mean + u * factor * stdDev;
  }

  /** Exponential with the given mean. Used for memory-trace lifetimes. */
  exponential(mean = 1): number {
    if (mean <= 0) return 0;
    let u = this.next();
    if (u === 0) u = Number.EPSILON;
    return -mean * Math.log(u);
  }

  /**
   * Weighted choice. Weights need not sum to 1 and need not be sorted; a
   * non-positive total falls back to uniform selection.
   */
  weighted<T>(items: readonly T[], weights: readonly number[]): T | undefined {
    if (items.length === 0) return undefined;
    if (items.length !== weights.length) {
      throw new LogosError('RNG_WEIGHT_MISMATCH', 'items and weights must be the same length', {
        items: items.length,
        weights: weights.length,
      });
    }
    let total = 0;
    for (const w of weights) if (w > 0) total += w;
    if (total <= 0) return this.pick(items);

    let roll = this.next() * total;
    for (let i = 0; i < items.length; i += 1) {
      const w = weights[i] ?? 0;
      if (w <= 0) continue;
      roll -= w;
      if (roll <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** In-place Fisher–Yates shuffle. Returns the same array for chaining. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = items[i] as T;
      const b = items[j] as T;
      items[i] = b;
      items[j] = a;
    }
    return items;
  }

  /** A copy of the internal state, so a run can be forked and replayed. */
  saveState(): readonly [number, number, number, number] {
    return [this.#s0, this.#s1, this.#s2, this.#s3];
  }

  restoreState(state: readonly [number, number, number, number]): void {
    this.#s0 = state[0] >>> 0;
    this.#s1 = state[1] >>> 0;
    this.#s2 = state[2] >>> 0;
    this.#s3 = state[3] >>> 0;
    this.#spare = undefined;
  }
}

/** Convenience: a generator seeded from a string, for named scenarios. */
export function rngFromString(label: string, salt = 0): Rng {
  let h = 0x811c9dc5 ^ (salt >>> 0);
  for (let i = 0; i < label.length; i += 1) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return new Rng(h);
}
