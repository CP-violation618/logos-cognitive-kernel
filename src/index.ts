/**
 * LOGOS — a cognitive kernel for AGI research.
 * ===========================================================================
 *
 * A layered architecture, in the strict sense: each layer may depend on the
 * ones beneath it and on nothing beside it. Cross-layer communication happens
 * on the event bus, which is what keeps a ten-module cognitive architecture
 * from becoming a ten-way tangle.
 *
 *   0. KERNEL          clock · event bus · scheduler · RNG · configuration
 *   1. MEMORY          working · episodic · semantic · consolidation · recall
 *   2. PERCEPTION      salience · habituation · the attentional gate
 *   3. REASONING       world model · beliefs · inference
 *   4. PLANNING        goals · hierarchical task networks
 *   5. METACOGNITION   calibration · reflection · self-model      (in progress)
 *
 * WHAT THIS IS. A substrate for minds: the machinery of memory, attention,
 * inference and intention, with no dependence on any particular model or
 * model provider. It runs on Node with zero runtime dependencies.
 *
 * WHAT THIS IS NOT. It is not an LLM wrapper, and it is not an AGI. Nobody has
 * built one of those. What this is, is the engineering substrate that the gap
 * between "agent" and "general intelligence" is actually made of — memory that
 * forgets, attention that is scarce, beliefs that can be revised, plans that
 * can fail.
 *
 * Everything is deterministic under a seed. The same inputs produce the same
 * mental trajectory, which is what makes any of it testable.
 *
 * @example
 * ```ts
 * import { Kernel, WorkingMemory, EpisodicMemory, PerceptionGate } from 'logos-cognitive-kernel';
 *
 * const kernel = new Kernel({ config: { seed: 0x5eed } });
 * await kernel.start();
 * await kernel.tick();
 * ```
 *
 * @packageDocumentation
 */

// ── Layer 0: the kernel ─────────────────────────────────────────────────────
export * from './kernel/index.ts';

// ── Layer 1: memory ─────────────────────────────────────────────────────────
export * from './memory/index.ts';

// ── Layer 2: perception ─────────────────────────────────────────────────────
export * from './perception/index.ts';

// ── Layer 3: reasoning ──────────────────────────────────────────────────────
export * from './reasoning/index.ts';

// ── Layer 4: planning ───────────────────────────────────────────────────────
export * from './planning/index.ts';

// ── Layer 5: metacognition ──────────────────────────────────────────────────
export * from './metacognition/index.ts';

// ── The integrated cycle ────────────────────────────────────────────────────
export * from './cognition/index.ts';

/** Package version, mirrored from package.json for runtime introspection. */
export const VERSION = '0.1.0';

/**
 * The architecture's layer order, lowest first.
 *
 * Exported rather than documented only, because a plugin or a test can assert
 * against it — and a layering rule that is not checkable is a layering rule
 * that will be broken.
 */
export const LAYERS = Object.freeze([
  { level: 0, name: 'kernel', purpose: 'time, events, attention budget, randomness' },
  { level: 1, name: 'memory', purpose: 'what is held, what happened, what is true' },
  { level: 2, name: 'perception', purpose: 'what gets in' },
  { level: 3, name: 'reasoning', purpose: 'what follows, and what to believe' },
  { level: 4, name: 'planning', purpose: 'what is wanted, and how to get it' },
  { level: 5, name: 'metacognition', purpose: 'how well any of the above is going' },
] as const);
