/**
 * LOGOS :: Kernel :: Core types
 * ---------------------------------------------------------------------------
 * The vocabulary every other layer speaks. Kept dependency-free on purpose:
 * everything in `src/` may import this file, this file imports nothing.
 */

// ── Branded identifiers ─────────────────────────────────────────────────────
//
// A `BeliefId` and an `EpisodeId` are both strings at runtime, but confusing
// them is a class of bug that a cognitive architecture cannot afford: memory
// corruption in an agent is not a typo, it is a mis-remembered life. Brands
// make the compiler refuse the swap.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type GoalId = Brand<string, 'GoalId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type EpisodeId = Brand<string, 'EpisodeId'>;
export type ConceptId = Brand<string, 'ConceptId'>;
export type BeliefId = Brand<string, 'BeliefId'>;
export type SkillId = Brand<string, 'SkillId'>;
export type PerceptionId = Brand<string, 'PerceptionId'>;
export type PlanId = Brand<string, 'PlanId'>;
export type ReflectionId = Brand<string, 'ReflectionId'>;

/** Monotonic logical instant. Not a wall clock — see `Clock`. */
export type Tick = Brand<number, 'Tick'>;

export const tick = (n: number): Tick => n as Tick;

// Identifier factories. Short random suffix keeps ids unique across process
// restarts and across persisted/replayed sessions without a central counter.
let idCounter = 0;
const nextId = (prefix: string): string => {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${idCounter.toString(36)}${rand}`;
};

export const newGoalId = (): GoalId => nextId('goal') as GoalId;
export const newTaskId = (): TaskId => nextId('task') as TaskId;
export const newEpisodeId = (): EpisodeId => nextId('ep') as EpisodeId;
export const newConceptId = (): ConceptId => nextId('con') as ConceptId;
export const newBeliefId = (): BeliefId => nextId('bel') as BeliefId;
export const newSkillId = (): SkillId => nextId('skl') as SkillId;
export const newPerceptionId = (): PerceptionId => nextId('per') as PerceptionId;
export const newPlanId = (): PlanId => nextId('plan') as PlanId;
export const newReflectionId = (): ReflectionId => nextId('refl') as ReflectionId;

// ── Confidence & uncertainty ────────────────────────────────────────────────
//
// This is the single most important type in the codebase.
//
// Classic software deals in booleans. A mind cannot: every proposition it
// holds is held *to some degree*, and the entire point of metacognition is to
// reason about those degrees. So confidence is a first-class, always-present
// number in [0, 1] — never an afterthought, never `undefined`, never a
// "probably fine" comment.
//
// `Credence` is just a documented alias. It exists so signatures read like
// epistemology rather than like floating-point plumbing.

/** A subjective probability in [0, 1]. 0 = impossible, 1 = certain. */
export type Credence = number;

/** One bit of memory decay information, tracked per belief. */
export interface Confident {
  readonly confidence: Credence;
}

/** Clamp any number into a legal credence. NaN is treated as total ignorance. */
export const clampCredence = (value: number): Credence => {
  if (Number.isNaN(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

/**
 * Log-odds representation of a credence — the form in which evidence
 * accumulates linearly (Bayes' rule is addition in log-odds).
 */
export const toLogOdds = (p: Credence): number => {
  const c = clampCredence(p);
  // +6/-6 is ~0.9975/0.0025; beyond that we are past double precision's
  // useful resolution for the products we compute downstream.
  const EPS = 1e-6;
  return Math.log(Math.min(1 - EPS, Math.max(EPS, c)) / (1 - Math.min(1 - EPS, Math.max(EPS, c))));
};

export const fromLogOdds = (lo: number): Credence => 1 / (1 + Math.exp(-lo));

/** How much two credences disagree. 0 = identical, 1 = maximally opposed. */
export const credenceDistance = (a: Credence, b: Credence): number =>
  Math.abs(clampCredence(a) - clampCredence(b));

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Base class for every error LOGOS raises deliberately.
 *
 * A cognitive kernel must distinguish "the world surprised me" (a normal,
 * informative event) from "the code is broken" (a defect). Only the latter
 * throws.
 */
export class LogosError extends Error {
  readonly code: string;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LogosError';
    this.code = code;
    this.context = Object.freeze({ ...context });
    Object.setPrototypeOf(this, new.target.prototype);
  }

  override toString(): string {
    const keys = Object.keys(this.context);
    const detail = keys.length > 0 ? ` ${JSON.stringify(this.context)}` : '';
    return `[${this.code}] ${this.message}${detail}`;
  }
}

/** Raised when a subsystem is used before it has been started. */
export class LifecycleError extends LogosError {
  constructor(subsystem: string, attempted: string, state: string) {
    super('LIFECYCLE', `${subsystem} cannot ${attempted} while ${state}`, { subsystem, state });
    this.name = 'LifecycleError';
  }
}

/** Raised when a budget (time, tokens, steps) is exhausted. Informative. */
export class BudgetExhaustedError extends LogosError {
  constructor(kind: string, limit: number) {
    super('BUDGET_EXHAUSTED', `${kind} budget of ${limit} exhausted`, { kind, limit });
    this.name = 'BudgetExhaustedError';
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export type Phase = 'created' | 'running' | 'paused' | 'stopped';

export interface Startable {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface HealthReport {
  readonly subsystem: string;
  readonly phase: Phase;
  readonly ok: boolean;
  readonly detail: string;
  readonly metrics: Readonly<Record<string, number>>;
}

// ── Utility types ───────────────────────────────────────────────────────────

/** Deep-readonly view, for values handed to plugins. */
export type Immutable<T> = {
  readonly [K in keyof T]: T[K] extends (...args: never[]) => unknown ? T[K] : Immutable<T[K]>;
};

export type Awaitable<T> = T | Promise<T>;

/** A result that may fail without throwing — used on hot cognitive paths. */
export type Outcome<T, E = LogosError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const fail = <T = never, E = LogosError>(error: E): Outcome<T, E> => ({ ok: false, error });
