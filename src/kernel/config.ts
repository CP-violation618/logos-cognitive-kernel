/**
 * LOGOS :: Kernel :: Configuration
 * ---------------------------------------------------------------------------
 * Every tunable constant in the architecture lives here, in one frozen tree.
 *
 * Two rules make this safe:
 *
 *   1. CONFIG IS IMMUTABLE AFTER CONSTRUCTION. Deep-frozen, recursively. A
 *      cognitive subsystem that can silently mutate global settings is a
 *      subsystem whose behaviour cannot be reproduced — and an architecture
 *      you cannot reproduce is one you cannot debug.
 *   2. PRESETS ARE PARTIAL OVERRIDES, NOT COPIES. A preset declares only what
 *      it changes; everything else is inherited. That keeps `Config` honest
 *      about which knob a preset actually turns.
 */

import { LogosError } from './types.ts';

export interface KernelConfig {
  /** Identity and observability. */
  readonly name: string;
  readonly seed: number;
  readonly debug: boolean;

  readonly clock: {
    /** Real-time ticks per second when the heartbeat is running. */
    readonly hz: number;
  };

  readonly scheduler: {
    /** Total units of cognitive effort available per logical tick. */
    readonly budgetPerTick: number;
    /** Maximum tasks admitted within one tick. */
    readonly maxTasksPerTick: number;
    /** Emit a tick report every N ticks; 0 disables reporting. */
    readonly reportEvery: number;
  };

  readonly bus: {
    /** Events retained for introspection; 0 disables history. */
    readonly historyLimit: number;
  };

  readonly memory: {
    /** Working-memory slot count — the classic "7 ± 2" bottleneck. */
    readonly workingSlots: number;
    /** Salience below which a perception never reaches working memory. */
    readonly attentionThreshold: number;
    /** Ticks after which unattended working items decay out. */
    readonly workingDecayTicks: number;
    /** Episodes older than this (in ticks) become consolidation candidates. */
    readonly consolidationAgeTicks: number;
    /**
     * Exponential forgetting rate applied to unused episodic/semantic traces,
     * as a half-life in ticks. Longer = more tenacious memory.
     */
    readonly forgettingHalfLifeTicks: number;
    /** Retrieval returns at most this many items per query. */
    readonly retrievalLimit: number;
  };

  readonly goals: {
    /** Simultaneously pursued goals. */
    readonly maxActive: number;
    /** Below this credence a goal is considered abandoned. */
    readonly abandonThreshold: number;
    /** Ticks without progress before a goal is reconsidered. */
    readonly stallTicks: number;
  };

  readonly cognition: {
    /** Ticks a single deliberation cycle may span before forced reflection. */
    readonly deliberationBudget: number;
    /** Predictions with error above this trigger a world-model revision. */
    readonly surpriseThreshold: number;
    /** Maximum planning depth before abstraction is forced. */
    readonly maxPlanDepth: number;
    /** Minimum credence for a belief to be usable as a premise. */
    readonly premiseThreshold: number;
  };

  readonly metacognition: {
    /** Calibration is recomputed over a window of this many predictions. */
    readonly calibrationWindow: number;
    /** Frequency, in ticks, of automatic self-reflection. */
    readonly reflectionIntervalTicks: number;
    /** Confidence below which the kernel escalates to deliberate reasoning. */
    readonly escalateBelow: number;
  };
}

/**
 * Deep-partial overrides, as accepted by `defineConfig` and the presets.
 *
 * Nested groups explicitly admit `undefined` in every field. That is not
 * looseness — it is the encoding of the documented rule that an `undefined`
 * value means "leave this knob alone". Without it, a caller doing
 *
 *     defineConfig({ name: maybeName, memory: { workingSlots: maybeSlots } })
 *
 * would be forced to build the object conditionally, and the merge semantics
 * and the type would disagree.
 */
export type ConfigOverrides = {
  readonly [K in keyof KernelConfig]?:
    | (KernelConfig[K] extends object
        ? { readonly [P in keyof KernelConfig[K]]?: KernelConfig[K][P] | undefined }
        : KernelConfig[K] | undefined)
    | undefined;
};

const BASE: KernelConfig = {
  name: 'logos',
  seed: 0x5eed,
  debug: false,

  clock: { hz: 20 },

  scheduler: { budgetPerTick: 8, maxTasksPerTick: 4, reportEvery: 0 },

  bus: { historyLimit: 256 },

  memory: {
    workingSlots: 7,
    /**
     * Salience a percept must reach to enter working memory.
     *
     * 0.28 rather than 0.35, and the arithmetic is the reason. The gate weights
     * are surprise .35, novelty .25, relevance .20, intensity .10, affect .10,
     * so an observation that is MAXIMALLY NOVEL and nothing else scores
     * 0.25 + 0.10·intensity — at most 0.35, and only if it is also as loud as
     * the scale allows.
     *
     * At the old 0.35 the ceiling and the threshold were exactly equal, which
     * meant a first observation of anything was admitted only at full
     * intensity. Anything typed into the REPL at the documented 0.8 scored
     * 0.33 and was silently refused, so the interactive mode could not admit a
     * single percept. Worse, the gate was rejecting precisely the case it
     * exists to admit: something wholly unexpected.
     *
     * 0.28 admits a maximally novel observation at intensity >= 0.3 while still
     * refusing a familiar one, because a repeat carries novelty near 0 and
     * cannot reach the threshold on intensity alone.
     */
    attentionThreshold: 0.28,
    workingDecayTicks: 12,
    consolidationAgeTicks: 40,
    forgettingHalfLifeTicks: 500,
    retrievalLimit: 8,
  },

  goals: {
    maxActive: 3,
    abandonThreshold: 0.15,
    stallTicks: 24,
  },

  cognition: {
    deliberationBudget: 64,
    surpriseThreshold: 0.4,
    maxPlanDepth: 6,
    premiseThreshold: 0.3,
  },

  metacognition: {
    calibrationWindow: 128,
    reflectionIntervalTicks: 40,
    escalateBelow: 0.45,
  },
};

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/** Merge a partial override tree over a base without mutating either. */
function merge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    const bothPlain =
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value);
    out[key] = bothPlain
      ? merge(current as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return out as T;
}

/**
 * Validate the invariants the rest of the kernel assumes.
 *
 * Configuration errors are the worst class of bug in a cognitive system: they
 * do not crash, they just make the mind subtly wrong. So we refuse them loudly
 * at construction.
 */
function validate(config: KernelConfig): void {
  const problems: string[] = [];

  const positiveInt = (path: string, v: number, min = 1): void => {
    if (!Number.isInteger(v) || v < min) problems.push(`${path} must be an integer >= ${min}, got ${v}`);
  };
  const unitInterval = (path: string, v: number): void => {
    if (!Number.isFinite(v) || v < 0 || v > 1) problems.push(`${path} must be in [0,1], got ${v}`);
  };

  positiveInt('clock.hz', config.clock.hz);
  positiveInt('scheduler.budgetPerTick', config.scheduler.budgetPerTick);
  positiveInt('scheduler.maxTasksPerTick', config.scheduler.maxTasksPerTick);
  if (!Number.isInteger(config.scheduler.reportEvery) || config.scheduler.reportEvery < 0) {
    problems.push(`scheduler.reportEvery must be an integer >= 0, got ${config.scheduler.reportEvery}`);
  }
  if (!Number.isInteger(config.bus.historyLimit) || config.bus.historyLimit < 0) {
    problems.push(`bus.historyLimit must be an integer >= 0, got ${config.bus.historyLimit}`);
  }

  positiveInt('memory.workingSlots', config.memory.workingSlots);
  unitInterval('memory.attentionThreshold', config.memory.attentionThreshold);
  positiveInt('memory.workingDecayTicks', config.memory.workingDecayTicks);
  positiveInt('memory.consolidationAgeTicks', config.memory.consolidationAgeTicks);
  positiveInt('memory.forgettingHalfLifeTicks', config.memory.forgettingHalfLifeTicks);
  positiveInt('memory.retrievalLimit', config.memory.retrievalLimit);

  positiveInt('goals.maxActive', config.goals.maxActive);
  unitInterval('goals.abandonThreshold', config.goals.abandonThreshold);
  positiveInt('goals.stallTicks', config.goals.stallTicks);

  positiveInt('cognition.deliberationBudget', config.cognition.deliberationBudget);
  unitInterval('cognition.surpriseThreshold', config.cognition.surpriseThreshold);
  positiveInt('cognition.maxPlanDepth', config.cognition.maxPlanDepth);
  unitInterval('cognition.premiseThreshold', config.cognition.premiseThreshold);

  positiveInt('metacognition.calibrationWindow', config.metacognition.calibrationWindow);
  positiveInt('metacognition.reflectionIntervalTicks', config.metacognition.reflectionIntervalTicks);
  unitInterval('metacognition.escalateBelow', config.metacognition.escalateBelow);

  // Cross-field invariants: individually valid numbers can still describe an
  // incoherent mind.
  if (config.memory.attentionThreshold === 0) {
    problems.push('memory.attentionThreshold of exactly 0 admits every percept; attention would be meaningless');
  }
  if (config.scheduler.maxTasksPerTick > config.scheduler.budgetPerTick) {
    problems.push('scheduler.maxTasksPerTick exceeds budgetPerTick; most admitted tasks would get an empty slice');
  }
  if (config.metacognition.escalateBelow >= 1) {
    problems.push('metacognition.escalateBelow >= 1 would escalate on every decision, including certain ones');
  }
  if (config.cognition.premiseThreshold >= 1) {
    problems.push('cognition.premiseThreshold >= 1 would reject every belief, including certain ones');
  }

  if (problems.length > 0) {
    throw new LogosError('CONFIG_INVALID', `invalid configuration:\n  - ${problems.join('\n  - ')}`, {
      problemCount: problems.length,
    });
  }
}

/** Build a frozen, validated configuration from a partial override tree. */
export function defineConfig(overrides: ConfigOverrides = {}): KernelConfig {
  const merged = merge(
    BASE as unknown as Record<string, unknown>,
    overrides as unknown as Record<string, unknown>,
  ) as unknown as KernelConfig;
  validate(merged);
  return deepFreeze(merged);
}

/**
 * Named operating profiles.
 *
 * These are not marketing presets — each one is a coherent stance on the
 * tradeoff between deliberateness and responsiveness, and each is the
 * recommended configuration for a real mode of use.
 */
export type PresetName = 'default' | 'reflective' | 'reactive' | 'research' | 'minimal';

const PRESETS: Record<Exclude<PresetName, 'default'>, ConfigOverrides> = {
  /**
   * Slow, careful, second-guesses itself. Fewer thoughts per tick, more
   * metacognition, longer memory. For problems where being wrong is expensive.
   */
  reflective: {
    clock: { hz: 10 },
    scheduler: { budgetPerTick: 16, maxTasksPerTick: 2 },
    memory: { workingSlots: 9, forgettingHalfLifeTicks: 2000, consolidationAgeTicks: 24 },
    goals: { maxActive: 2, stallTicks: 40 },
    cognition: { deliberationBudget: 256, maxPlanDepth: 10, surpriseThreshold: 0.25 },
    metacognition: { reflectionIntervalTicks: 16, escalateBelow: 0.6, calibrationWindow: 256 },
  },

  /**
   * Fast and reflexive. Wide attention, shallow deliberation, rapid decay.
   * For environments that change faster than they can be reasoned about.
   */
  reactive: {
    clock: { hz: 60 },
    scheduler: { budgetPerTick: 12, maxTasksPerTick: 8 },
    memory: { workingSlots: 5, attentionThreshold: 0.5, workingDecayTicks: 6, retrievalLimit: 4 },
    goals: { maxActive: 5, stallTicks: 8 },
    cognition: { deliberationBudget: 24, surpriseThreshold: 0.6, maxPlanDepth: 3 },
    metacognition: { reflectionIntervalTicks: 120, escalateBelow: 0.25 },
  },

  /**
   * Full instrumentation. Keeps a deep event history and reports every tick,
   * because the point is to watch the mind work, not to get work done.
   */
  research: {
    debug: true,
    scheduler: { budgetPerTick: 24, maxTasksPerTick: 8, reportEvery: 1 },
    bus: { historyLimit: 100_000 },
    memory: { workingSlots: 12, retrievalLimit: 32 },
    metacognition: { calibrationWindow: 1024, reflectionIntervalTicks: 8 },
  },

  /**
   * The smallest coherent mind: one goal, four slots of attention, no
   * background reflection. Useful as a baseline to measure what the extra
   * machinery in the other presets actually buys.
   */
  minimal: {
    scheduler: { budgetPerTick: 4, maxTasksPerTick: 1 },
    bus: { historyLimit: 32 },
    memory: { workingSlots: 4, retrievalLimit: 3, consolidationAgeTicks: 1_000_000 },
    goals: { maxActive: 1 },
    cognition: { deliberationBudget: 16, maxPlanDepth: 2 },
    metacognition: { reflectionIntervalTicks: 1_000_000, escalateBelow: 0 },
  },
};

export function preset(name: PresetName, extra: ConfigOverrides = {}): KernelConfig {
  if (name === 'default') return defineConfig(extra);
  const base = PRESETS[name];
  if (base === undefined) {
    throw new LogosError('CONFIG_UNKNOWN_PRESET', `unknown preset: ${String(name)}`, {
      available: ['default', ...Object.keys(PRESETS)],
    });
  }
  return defineConfig(merge(base as Record<string, unknown>, extra as Record<string, unknown>) as ConfigOverrides);
}

export const availablePresets = (): PresetName[] => ['default', ...(Object.keys(PRESETS) as Exclude<PresetName, 'default'>[])];
