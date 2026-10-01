/**
 * LOGOS :: Reasoning :: Model adapter
 * ---------------------------------------------------------------------------
 * How an external language model is allowed to influence the mind.
 *
 * The design premise is that a language model is NOT an oracle. It is a source
 * of percepts and hypotheses — a fluent, useful, and frequently wrong one — and
 * it should enter the architecture the same way anything else does: through the
 * attentional gate, subject to the same scrutiny, its claims calibrated like
 * anyone else's.
 *
 * Everything here follows from taking that seriously rather than treating it as
 * a slogan. Four commitments:
 *
 * 1. THE MODEL IS UNTRUSTED INPUT. Its output is parsed, validated against a
 *    declared shape, and admitted or refused. A response that does not parse is
 *    not an error condition to paper over — it is a percept that failed to be
 *    one, and it is recorded as such.
 *
 * 2. THE MODEL'S CONFIDENCE IS A CLAIM, NOT A FACT. When a model says it is
 *    90% sure, that number becomes a PREDICTION registered with the calibrator.
 *    If it turns out to be wrong, the model's self-reported confidence is
 *    measurably worthless on that kind of task, and the architecture can learn
 *    that instead of believing it. This is the single most valuable thing this
 *    file does: it makes a model's calibration a measured property rather than
 *    a rhetorical one.
 *
 * 3. THE MODEL NEVER ACTS. It produces text, claims, and candidate plans. Every
 *    effect on the world goes through the skill registry and the planner, which
 *    have their own preconditions and their own accounting. A model that could
 *    act directly would bypass every safety property the rest of the
 *    architecture spent its complexity establishing.
 *
 * 4. NO TRANSPORT IS BUNDLED. `ModelClient` is an interface. HTTP clients,
 *    local servers, and test doubles all satisfy it, and none of them are
 *    dependencies of this package. The zero-dependency rule survives contact
 *    with the feature most likely to have broken it.
 */

import type { Clock } from '../kernel/clock.ts';
import type { EventBus } from '../kernel/bus.ts';
import type { Rng } from '../kernel/rng.ts';
import type { Credence, Tick } from '../kernel/types.ts';
import { LogosError, clampCredence } from '../kernel/types.ts';
import type { PerceptionGate, PerceptInput } from '../perception/gate.ts';
import type { BeliefStore } from './beliefs.ts';
import type { Calibrator } from '../metacognition/calibration.ts';

/** One message in a conversation. */
export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** What a client is asked for. */
export interface CompletionRequest {
  readonly messages: readonly ModelMessage[];
  /** Upper bound on tokens, when the provider supports it. */
  readonly maxTokens?: number;
  /** Sampling temperature, when the provider supports it. */
  readonly temperature?: number;
  /** Ask the provider to constrain output to JSON, when it supports it. */
  readonly json?: boolean;
  readonly signal?: AbortSignal;
}

/** What a client returns. */
export interface CompletionResponse {
  readonly content: string;
  /** Provider's own confidence, if it offers one. Rarely meaningful; calibrated, not trusted. */
  readonly confidence?: number;
  readonly model?: string;
  /** Tokens consumed, when reported. Used for accounting, never for decisions. */
  readonly tokens?: number;
  readonly finishReason?: string;
}

/**
 * A transport to some model.
 *
 * Deliberately the smallest interface that can express the task. Everything
 * provider-specific — retries, streaming, tool-calling conventions — belongs on
 * the far side of this boundary, because every one of them would otherwise
 * become part of the architecture's surface area.
 */
export interface ModelClient {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/** A claim extracted from a model response, registered for calibration. */
export interface ModelClaim {
  readonly text: string;
  /** The model's stated confidence, or undefined if it stated none. */
  readonly statedConfidence: Credence | undefined;
  /** Identifier used to settle the claim later. Empty when uncalibratable. */
  readonly predictionId: string;
  /** What kind of problem this was recorded against. */
  readonly kind: string;
  readonly at: Tick;
}

export interface ModelCall {
  readonly client: string;
  readonly prompt: string;
  readonly response: string;
  /** True when the response parsed as the requested shape. */
  readonly parsed: boolean;
  readonly admitted: boolean;
  readonly confidence: Credence;
  readonly tokens: number;
  readonly ms: number;
  readonly at: Tick;
  readonly detail: string;
}

export interface ModelAdapterOptions {
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly rng: Rng;
  /** The transport. Required: with no client this is a no-op, and a no-op here is a bug. */
  readonly client: ModelClient;
  /**
   * The gate every response passes through.
   *
   * Optional because a caller may want the adapter purely for parsing and
   * calibration. When absent, no percept is formed and nothing reaches memory —
   * which is a useful mode for testing and a dangerous one for production, so
   * its absence is announced on the bus.
   */
  readonly gate?: PerceptionGate;
  /** Optional: claims become evidence for the propositions they name. */
  readonly beliefs?: BeliefStore;
  /** Optional: stated confidences become predictions. */
  readonly calibrator?: Calibrator;
  /** Default domain for calibration, when a call does not name one. */
  readonly domain?: string;
  /** Per-call timeout. A model that does not answer is a model that did not answer. */
  readonly timeoutMs?: number;
  /** Retries on transport failure. Never on a schema failure. */
  readonly maxRetries?: number;
  /** Retained call records. */
  readonly historyLimit?: number;
}

export interface AdapterStats {
  readonly calls: number;
  readonly failures: number;
  readonly transportFailures: number;
  readonly schemaFailures: number;
  readonly admitted: number;
  readonly refused: number;
  readonly tokens: number;
  /** Mean wall-clock milliseconds per call. */
  readonly meanLatencyMs: number;
  /** Proportion of responses that parsed as the requested shape. */
  readonly wellFormedRate: number;
  /** Mean stated confidence, among calls that stated one. */
  readonly meanStatedConfidence: number;
}

/** A declared shape for a structured response. */
export type FieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'number[]';

export interface ResponseSchema {
  readonly [field: string]: FieldType;
}

/** The result of asking a model for something structured. */
export type StructuredOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly call: ModelCall }
  | { readonly ok: false; readonly reason: string; readonly raw: string; readonly call: ModelCall };

export class ModelAdapter {
  readonly #clock: Clock;
  readonly #bus: EventBus;
  readonly #rng: Rng;
  readonly #client: ModelClient;
  #gate: PerceptionGate | undefined;
  #beliefs: BeliefStore | undefined;
  #calibrator: Calibrator | undefined;
  readonly #domain: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #historyLimit: number;

  #calls = 0;
  #failures = 0;
  #transportFailures = 0;
  #schemaFailures = 0;
  #admitted = 0;
  #refused = 0;
  #tokens = 0;
  #latencyTotal = 0;
  #confidenceSum = 0;
  #confidenceCount = 0;
  #history: ModelCall[] = [];

  constructor(options: ModelAdapterOptions) {
    this.#clock = options.clock;
    this.#bus = options.bus;
    this.#rng = options.rng;
    this.#client = options.client;
    this.#gate = options.gate;
    this.#beliefs = options.beliefs;
    this.#calibrator = options.calibrator;
    this.#domain = options.domain ?? 'model';
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
    this.#maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 0));
    this.#historyLimit = Math.max(0, Math.floor(options.historyLimit ?? 128));

    if (typeof options.client?.complete !== 'function') {
      throw new LogosError('MODEL_NO_CLIENT', 'a model adapter needs a client with a complete() method', {
        client: options.client?.name,
      });
    }
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  setGate(gate: PerceptionGate | undefined): void {
    this.#gate = gate;
  }

  setBeliefs(beliefs: BeliefStore | undefined): void {
    this.#beliefs = beliefs;
  }

  setCalibrator(calibrator: Calibrator | undefined): void {
    this.#calibrator = calibrator;
  }

  get clientName(): string {
    return this.#client.name;
  }

  get history(): readonly ModelCall[] {
    return [...this.#history];
  }

  get stats(): AdapterStats {
    // Proportion of calls whose response parsed as the requested shape.
    //
    // Computed over ALL calls rather than over some "parsed" subset, with no
    // guard for the empty case. An earlier version returned 1 when nothing had
    // parsed successfully — a fallback that turned total failure into a perfect
    // score, which is the one direction a statistic must never lean.
    const wellFormedRate = this.#calls === 0 ? 1 : (this.#calls - this.#schemaFailures - this.#transportFailures) / this.#calls;

    return Object.freeze({
      calls: this.#calls,
      failures: this.#failures,
      transportFailures: this.#transportFailures,
      schemaFailures: this.#schemaFailures,
      admitted: this.#admitted,
      refused: this.#refused,
      tokens: this.#tokens,
      meanLatencyMs: this.#calls === 0 ? 0 : round(this.#latencyTotal / this.#calls),
      wellFormedRate: round(Math.max(0, Math.min(1, wellFormedRate))),
      meanStatedConfidence: this.#confidenceCount === 0 ? 0 : round(this.#confidenceSum / this.#confidenceCount),
    });
  }

  describe(): string {
    const s = this.stats;
    return (
      `model[${this.#client.name} calls=${s.calls} wellFormed=${(s.wellFormedRate * 100).toFixed(0)}% ` +
      `admitted=${s.admitted} refused=${s.refused} tokens=${s.tokens}]`
    );
  }

  // ── asking ────────────────────────────────────────────────────────────────

  /**
   * Ask the model for free text, as a percept.
   *
   * The response is routed through the attentional gate when one is attached,
   * which means it can be REFUSED — for being unremarkable, for being familiar,
   * or because the mind is busy. A model whose output cannot be ignored is a
   * model that has become the mind, and that is the failure mode this whole
   * design exists to prevent.
   */
  async ask(
    prompt: string,
    options: {
      readonly system?: string;
      readonly domain?: string;
      /** Intensity handed to the gate. Model output is not inherently urgent. */
      readonly intensity?: number;
      /** Skip the gate entirely, for callers that will handle the text themselves. */
      readonly bypassGate?: boolean;
    } = {},
  ): Promise<{ readonly text: string; readonly call: ModelCall; readonly admitted: boolean }> {
    const started = Date.now();
    const messages: ModelMessage[] = [];
    if (options.system !== undefined) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: prompt });

    const outcome = await this.#invoke({ messages }, prompt, started);
    if (!outcome.ok) {
      return { text: '', call: outcome.call, admitted: false };
    }

    // The model's own confidence, when it offers one, is registered as a
    // PREDICTION rather than believed. That is what turns "the model says it is
    // 90% sure" from a claim into a measurable property of the model.
    const stated = outcome.confidence;
    if (stated !== undefined && this.#calibrator !== undefined) {
      this.#calibrator.predict(`the model's answer to: ${prompt.slice(0, 100)}`, stated, {
        domain: options.domain ?? this.#domain,
        source: this.#client.name,
      });
    }

    const admitted = this.#admit(
      outcome.text,
      options.domain ?? this.#domain,
      options.intensity ?? 0.5,
      options.bypassGate === true,
    );

    const call = this.#record(outcome.call, admitted, stated);
    return { text: outcome.text, call, admitted };
  }

  /**
   * Ask for a structured response, and refuse anything that does not match.
   *
   * Validation is not a formality. A model asked for `{ "cause": "string" }`
   * will sometimes return prose, sometimes a nested object, and occasionally a
   * different field name entirely — and a caller that trusted the shape would
   * propagate that failure into the mind as though it were a belief. A schema
   * failure is recorded, announced, and returned as a failure, never coerced.
   */
  async askStructured<T extends Record<string, unknown>>(
    prompt: string,
    schema: ResponseSchema,
    options: { readonly system?: string; readonly domain?: string; readonly intensity?: number } = {},
  ): Promise<StructuredOutcome<T>> {
    const started = Date.now();
    const fields = Object.entries(schema);
    const instruction =
      `${prompt}\n\nRespond with a single JSON object and nothing else. ` +
      `The object must have exactly these fields:\n` +
      fields.map(([name, type]) => `  "${name}": ${describeType(type)}`).join('\n');

    const messages: ModelMessage[] = [];
    if (options.system !== undefined) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: instruction });

    const outcome = await this.#invoke({ messages, json: true }, prompt, started);
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason, raw: '', call: outcome.call };
    }

    const parsed = parseAndValidate(outcome.text, schema);
    if (!parsed.ok) {
      this.#schemaFailures += 1;
      this.#failures += 1;
      this.#bus.publish(
        'model:malformed',
        { client: this.#client.name, reason: parsed.reason, excerpt: outcome.text.slice(0, 200) },
        this.#clock.current,
      );
      const call = this.#record(outcome.call, false, outcome.confidence, parsed.reason);
      return { ok: false, reason: parsed.reason, raw: outcome.text, call };
    }

    // Claims become evidence, weighted by whether the model stated a confidence
    // and how much. A model that offers no confidence is treated as weak
    // evidence, because an unstated confidence is not the same as certainty.
    const stated = outcome.confidence;
    if (this.#beliefs !== undefined) {
      for (const [key, value] of Object.entries(parsed.value)) {
        if (typeof value !== 'string' || value.trim().length === 0) continue;
        try {
          this.#beliefs.addEvidence(`${key}: ${value}`.slice(0, 200), {
            content: `asserted by ${this.#client.name}`,
            source: `model:${this.#client.name}`,
            strength: stated === undefined ? 2 : 1 + stated * 4,
            // Deliberately below 1: a model is one source among many, and its
            // assertions should not be able to move a belief as much as a
            // direct observation.
            reliability: stated === undefined ? 0.4 : 0.5,
          });
        } catch {
          // A proposition that cannot be declared is not a reason to fail the
          // whole call; the structured value is still useful to the caller.
        }
      }
    }

    const admitted = this.#admit(
      Object.entries(parsed.value)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join('; '),
      options.domain ?? this.#domain,
      options.intensity ?? 0.45,
      false,
    );

    const call = this.#record(outcome.call, admitted, stated);
    return { ok: true, value: parsed.value as T, call };
  }

  /**
   * Settle a model's earlier prediction with what actually happened.
   *
   * This is how a model's self-reported confidence becomes a measured property
   * rather than a rhetorical one. A model that says 90% and is right half the
   * time ends up in the calibrator's record as overconfident on that kind of
   * task, and `adjustedConfidence` will discount it from then on without anyone
   * having to encode that judgement by hand.
   */
  settle(predictionId: string, wasCorrect: boolean): number | undefined {
    return this.#calibrator?.resolve(predictionId, wasCorrect);
  }

  /**
   * Settle every outstanding prediction this adapter registered for a domain.
   *
   * Useful when an outcome resolves a whole batch at once: a plan either worked
   * or did not, and every claim the model made in support of it settles
   * together. Only this client's predictions are touched, so one model's
   * failures never mark another's claims.
   */
  settleDomain(domain: string, wasCorrect: boolean): number {
    const calibrator = this.#calibrator;
    if (calibrator === undefined) return 0;
    const client = this.#client.name;
    return calibrator.resolveWhere(
      (prediction) => prediction.domain === domain && prediction.source === client,
      wasCorrect,
    );
  }

  clear(): void {
    this.#history = [];
    this.#calls = 0;
    this.#failures = 0;
    this.#transportFailures = 0;
    this.#schemaFailures = 0;
    this.#admitted = 0;
    this.#refused = 0;
    this.#tokens = 0;
    this.#latencyTotal = 0;
    this.#confidenceSum = 0;
    this.#confidenceCount = 0;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Call the transport, with retries only for transport failures.
   *
   * A response that arrives and does not parse is NEVER retried. Retrying a
   * schema failure would ask the same question again in the hope of a different
   * shape, which is both expensive and a way of hiding a model's real
   * unreliability behind a retry loop that makes the statistics look better
   * than the model is.
   */
  async #invoke(
    request: CompletionRequest,
    prompt: string,
    started: number,
  ): Promise<
    | { readonly ok: true; readonly text: string; readonly confidence: number | undefined; readonly call: PendingCall }
    | { readonly ok: false; readonly reason: string; readonly call: ModelCall }
  > {
    this.#calls += 1;

    let lastError = '';
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      try {
        const response = await this.#withTimeout(request);
        const ms = Date.now() - started;
        this.#latencyTotal += ms;
        this.#tokens += response.tokens ?? 0;

        const text = typeof response.content === 'string' ? response.content : String(response.content ?? '');
        const confidence = response.confidence === undefined ? undefined : clampCredence(response.confidence);
        if (confidence !== undefined) {
          this.#confidenceSum += confidence;
          this.#confidenceCount += 1;
        }

        return {
          ok: true,
          text,
          confidence,
          call: {
            client: this.#client.name,
            prompt: prompt.slice(0, 200),
            response: text.slice(0, 500),
            parsed: true,
            confidence: confidence ?? 0.5,
            tokens: response.tokens ?? 0,
            ms,
            at: this.#clock.current,
            detail: response.finishReason ?? 'completed',
          },
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        // Only retry while attempts remain. A transport failure is worth
        // retrying because it says nothing about the model's output.
        if (attempt < this.#maxRetries) {
          this.#bus.publish(
            'model:retry',
            { client: this.#client.name, attempt: attempt + 1, error: lastError },
            this.#clock.current,
          );
        }
      }
    }

    this.#transportFailures += 1;
    this.#failures += 1;
    const ms = Date.now() - started;
    this.#latencyTotal += ms;

    const call: ModelCall = Object.freeze({
      client: this.#client.name,
      prompt: prompt.slice(0, 200),
      response: '',
      parsed: false,
      admitted: false,
      confidence: 0,
      tokens: 0,
      ms,
      at: this.#clock.current,
      detail: `transport failure: ${lastError}`,
    });

    this.#bus.publish(
      'model:failed',
      { client: this.#client.name, error: lastError, attempts: this.#maxRetries + 1 },
      this.#clock.current,
    );

    this.#push(call);
    return { ok: false, reason: lastError, call };
  }

  async #withTimeout(request: CompletionRequest): Promise<CompletionResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('model call timed out')), this.#timeoutMs);

    // NO `unref()` HERE. The timer must keep the event loop alive for as long as
    // the call it is guarding is outstanding, which is the opposite of what
    // unref does. With it, a caller whose only pending work is this call — a
    // plain `await` in a test, for instance — lets the loop drain, and Node
    // abandons the promise with "Promise resolution is still pending but the
    // event loop has already resolved". Forty-five tests were cancelled this
    // way on Node 22 while passing on Node 24, because the newer test runner
    // happened to keep the loop alive on its own. The timer is cleared in the
    // `finally` below, so it cannot outlive the call either way.
    try {
      const response = await this.#client.complete({ ...request, signal: controller.signal });
      if (response === null || typeof response !== 'object') {
        throw new LogosError('MODEL_BAD_RESPONSE', 'the client returned something that is not a response', {
          client: this.#client.name,
        });
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Push a response through the gate, if there is one. */
  #admit(text: string, domain: string, intensity: number, bypass: boolean): boolean {
    const gate = this.#gate;
    if (bypass || gate === undefined || text.trim().length === 0) return false;

    try {
      const percept: PerceptInput = {
        content: text.slice(0, 600),
        modality: 'text',
        source: `model:${this.#client.name}`,
        intensity,
        data: { domain, model: this.#client.name },
      };
      const decision = gate.perceive(percept);
      if (decision.admitted) this.#admitted += 1;
      else this.#refused += 1;
      return decision.admitted;
    } catch (error) {
      this.#bus.publish(
        'model:error',
        { stage: 'admit', error: error instanceof Error ? error.message : String(error) },
        this.#clock.current,
      );
      return false;
    }
  }

  #record(pending: PendingCall, admitted: boolean, stated: number | undefined, detail?: string): ModelCall {
    const call: ModelCall = Object.freeze({
      ...pending,
      admitted,
      detail: detail ?? pending.detail,
    });
    this.#push(call);
    this.#bus.publish(
      'model:responded',
      {
        client: this.#client.name,
        admitted,
        confidence: stated ?? null,
        ms: call.ms,
        tokens: call.tokens,
      },
      this.#clock.current,
    );
    return call;
  }

  #push(call: ModelCall): void {
    if (this.#historyLimit === 0) return;
    this.#history.push(call);
    if (this.#history.length > this.#historyLimit) this.#history.shift();
  }
}

interface PendingCall {
  readonly client: string;
  readonly prompt: string;
  readonly response: string;
  readonly parsed: boolean;
  readonly confidence: number;
  readonly tokens: number;
  readonly ms: number;
  readonly at: Tick;
  readonly detail: string;
}

// ── parsing and validation ──────────────────────────────────────────────────

/**
 * Extract and validate a JSON object against a declared shape.
 *
 * Deliberately strict, and deliberately tolerant in exactly one respect: it
 * will find a JSON object embedded in surrounding prose, because models
 * routinely add a sentence of preamble despite being asked not to. Everything
 * else — missing fields, wrong types, extra nesting — is a failure.
 *
 * Coercion is refused. A model that returns `"5"` where a number was asked for
 * has not answered the question, and silently accepting it would mean the
 * failure surfaced later, further from its cause, in code that trusted the
 * schema.
 */
export function parseAndValidate(
  raw: string,
  schema: ResponseSchema,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: 'the response was empty' };

  // Try the whole thing first, then the outermost braces.
  let candidate: unknown;
  let parsedOk = false;

  try {
    candidate = JSON.parse(text);
    parsedOk = true;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        candidate = JSON.parse(text.slice(start, end + 1));
        parsedOk = true;
      } catch {
        parsedOk = false;
      }
    }
  }

  if (!parsedOk) return { ok: false, reason: 'the response was not JSON' };
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: `expected a JSON object, got ${Array.isArray(candidate) ? 'an array' : typeof candidate}` };
  }

  const object = candidate as Record<string, unknown>;
  for (const [field, type] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(object, field)) {
      return { ok: false, reason: `missing required field "${field}"` };
    }
    const value = object[field];
    const problem = typeProblem(field, value, type);
    if (problem !== undefined) return { ok: false, reason: problem };
  }

  return { ok: true, value: object };
}

function typeProblem(field: string, value: unknown, type: FieldType): string | undefined {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? undefined : `field "${field}" must be a string, got ${describe(value)}`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? undefined
        : `field "${field}" must be a finite number, got ${describe(value)}`;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `field "${field}" must be a boolean, got ${describe(value)}`;
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? undefined
        : `field "${field}" must be an array of strings, got ${describe(value)}`;
    case 'number[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'number' && Number.isFinite(v))
        ? undefined
        : `field "${field}" must be an array of finite numbers, got ${describe(value)}`;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return typeof value;
}

function describeType(type: FieldType): string {
  return type;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
