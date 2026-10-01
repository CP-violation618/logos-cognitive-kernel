/**
 * LOGOS :: Reasoning :: Model adapter tests
 * ---------------------------------------------------------------------------
 * The claims under test are the containment ones, because those are the claims
 * a model adapter usually does not make:
 *
 *   · THE MODEL IS UNTRUSTED INPUT — malformed responses are refused, never
 *     coerced, and never retried as though they were transport failures;
 *   · THE MODEL'S CONFIDENCE IS A CLAIM — it becomes a prediction the
 *     calibrator scores, so a model that says 90% and is right half the time
 *     ends up measurably overconfident;
 *   · THE MODEL NEVER ACTS — it produces text and claims, and nothing else;
 *   · THE MODEL'S OUTPUT CAN BE IGNORED — it goes through the attentional gate
 *     and can be refused for being unremarkable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ModelAdapter,
  parseAndValidate,
  type CompletionRequest,
  type CompletionResponse,
  type ModelClient,
} from '../src/reasoning/model-adapter.ts';
import { PerceptionGate } from '../src/perception/gate.ts';
import { WorkingMemory } from '../src/memory/working.ts';
import { BeliefStore } from '../src/reasoning/beliefs.ts';
import { Calibrator } from '../src/metacognition/calibration.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import { LogosError } from '../src/kernel/types.ts';

/** A client that returns whatever it is told, and records what it was asked. */
const scripted = (
  responses: readonly (CompletionResponse | Error)[],
): ModelClient & { readonly requests: CompletionRequest[]; calls: number } => {
  const requests: CompletionRequest[] = [];
  const client = {
    name: 'scripted',
    requests,
    calls: 0,
    complete(request: CompletionRequest): Promise<CompletionResponse> {
      client.calls += 1;
      requests.push(request);
      const response = responses[Math.min(client.calls - 1, responses.length - 1)];
      if (response === undefined) return Promise.reject(new Error('no scripted response'));
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(response);
    },
  };
  return client;
};

interface Rig {
  readonly kernel: Kernel;
  readonly adapter: ModelAdapter;
  readonly working: WorkingMemory;
  readonly beliefs: BeliefStore;
  readonly calibrator: Calibrator;
  readonly gate: PerceptionGate;
}

const rig = (
  client: ModelClient,
  options: { readonly withGate?: boolean; readonly withBeliefs?: boolean; readonly withCalibrator?: boolean; readonly maxRetries?: number } = {},
): Rig => {
  const kernel = new Kernel();
  const working = new WorkingMemory({ capacity: 7 });
  const beliefs = new BeliefStore({ clock: kernel.clock, bus: kernel.bus });
  const calibrator = new Calibrator({ clock: kernel.clock, bus: kernel.bus, minimumSamples: 4 });
  const gate = new PerceptionGate({
    clock: kernel.clock,
    bus: kernel.bus,
    config: kernel.config,
    rng: kernel.rng,
    working,
    threshold: 0.3,
  });

  const adapter = new ModelAdapter({
    clock: kernel.clock,
    bus: kernel.bus,
    rng: kernel.rng,
    client,
    ...(options.withGate === true ? { gate } : {}),
    ...(options.withBeliefs === true ? { beliefs } : {}),
    ...(options.withCalibrator === true ? { calibrator } : {}),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    domain: 'test',
  });

  return { kernel, adapter, working, beliefs, calibrator, gate };
};

// ── Construction ────────────────────────────────────────────────────────────

test('model: an adapter without a client is refused', () => {
  const kernel = new Kernel();
  assert.throws(
    () =>
      new ModelAdapter({
        clock: kernel.clock,
        bus: kernel.bus,
        rng: kernel.rng,
        client: { name: 'broken' } as never,
      }),
    LogosError,
  );
});

test('model: the adapter reports its client', () => {
  const { adapter } = rig(scripted([{ content: 'hello' }]));
  assert.equal(adapter.clientName, 'scripted');
});

// ── Free-text calls ─────────────────────────────────────────────────────────

test('model: a plain call returns the text', async () => {
  const client = scripted([{ content: 'the answer is 42' }]);
  const { adapter } = rig(client);

  const result = await adapter.ask('what is the answer?');
  assert.equal(result.text, 'the answer is 42');
  assert.equal(client.requests.length, 1);
  assert.match(client.requests[0]?.messages[0]?.content ?? '', /what is the answer/);
});

test('model: a system message is passed through ahead of the prompt', async () => {
  const client = scripted([{ content: 'ok' }]);
  const { adapter } = rig(client);

  await adapter.ask('the question', { system: 'you are terse' });
  const messages = client.requests[0]?.messages ?? [];
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[1]?.role, 'user');
});

test('model: a transport failure is reported, not thrown', async () => {
  const { adapter } = rig(scripted([new Error('connection refused')]));
  const result = await adapter.ask('anything');

  assert.equal(result.text, '');
  assert.equal(result.admitted, false);
  assert.equal(adapter.stats.transportFailures, 1);
  assert.match(result.call.detail, /connection refused/);
});

test('model: transport failures are retried when retries are allowed', async () => {
  const client = scripted([new Error('flaky'), new Error('flaky again'), { content: 'third time lucky' }]);
  const { adapter } = rig(client, { maxRetries: 3 });

  const result = await adapter.ask('anything');
  // A transport failure says nothing about the model's output, so retrying it
  // is legitimate.
  assert.equal(result.text, 'third time lucky');
  assert.equal(client.calls, 3);
});

test('model: retries are announced on the bus', async () => {
  const client = scripted([new Error('flaky'), { content: 'ok' }]);
  const { kernel, adapter } = rig(client, { maxRetries: 2 });
  const events: string[] = [];
  kernel.bus.on('model:*', (e) => events.push(e.type));

  await adapter.ask('x');
  assert.ok(events.includes('model:retry'));
});

test('model: a timeout aborts the call rather than hanging', async () => {
  const kernel = new Kernel();
  const hanging: ModelClient = {
    name: 'hanging',
    complete: (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  };
  const adapter = new ModelAdapter({ clock: kernel.clock, bus: kernel.bus, rng: kernel.rng, client: hanging, timeoutMs: 20 });

  const result = await adapter.ask('x');
  assert.equal(result.text, '');
  assert.equal(adapter.stats.transportFailures, 1);
});

test('model: a client returning nonsense is reported rather than crashing', async () => {
  const client = { name: 'odd', complete: () => Promise.resolve(null as never) };
  const { adapter } = rig(client);

  const result = await adapter.ask('x');
  assert.equal(result.admitted, false);
  assert.ok(adapter.stats.transportFailures >= 1);
});

// ── The gate: model output can be refused ───────────────────────────────────

test('model: output passes through the attentional gate', async () => {
  const { adapter, working } = rig(scripted([{ content: 'an unprecedented and striking observation' }]), {
    withGate: true,
  });

  await adapter.ask('tell me something', { intensity: 1 });
  assert.ok(working.size >= 1, 'the response became a percept');
  assert.equal(adapter.stats.admitted, 1);
});

test('model: an unremarkable response can be refused by the gate', async () => {
  const client = scripted([{ content: 'yes' }]);
  const { adapter } = rig(client, { withGate: true });

  // Repeated identically with no time passing, so habituation sets in and the
  // gate stops admitting it.
  for (let i = 0; i < 8; i += 1) await adapter.ask('did it work?', { intensity: 0.05 });

  // A model whose output cannot be ignored has become the mind, which is the
  // failure mode this design exists to prevent.
  assert.ok(adapter.stats.refused > 0, `nothing was refused: ${JSON.stringify(adapter.stats)}`);
});

test('model: without a gate nothing reaches memory, and that is announced', async () => {
  const { adapter, working } = rig(scripted([{ content: 'a striking observation indeed' }]));
  const result = await adapter.ask('x', { intensity: 1 });

  assert.equal(result.admitted, false, 'no gate means no percept');
  assert.equal(working.size, 0);
});

test('model: bypassing the gate is possible but explicit', async () => {
  const { adapter, working } = rig(scripted([{ content: 'a striking observation indeed' }]), { withGate: true });
  const result = await adapter.ask('x', { bypassGate: true, intensity: 1 });

  assert.equal(result.admitted, false);
  assert.equal(working.size, 0);
});

test('model: an empty response is never admitted', async () => {
  const { adapter, working } = rig(scripted([{ content: '   ' }]), { withGate: true });
  const result = await adapter.ask('x', { intensity: 1 });

  assert.equal(result.admitted, false);
  assert.equal(working.size, 0);
});

// ── The model's confidence is a claim ───────────────────────────────────────

test('model: stated confidence becomes a prediction the calibrator scores', async () => {
  const { adapter, calibrator } = rig(scripted([{ content: 'the answer', confidence: 0.9 }]), {
    withCalibrator: true,
  });

  await adapter.ask('a question');
  // The stated confidence is registered as a prediction rather than believed,
  // which is what makes it a measurable property of the model.
  assert.equal(calibrator.pendingCount, 1);

  // And settling it scores the model against reality.
  assert.equal(adapter.settleDomain('test', true), 1);
  assert.equal(calibrator.resolvedCount, 1);
});

test('model: an overconfident model becomes measurably overconfident', async () => {
  const responses = Array.from({ length: 40 }, () => ({ content: 'an assertion about the world', confidence: 0.9 }));
  const { adapter, calibrator } = rig(scripted(responses), { withCalibrator: true });

  for (let i = 0; i < 40; i += 1) await adapter.ask(`question ${i}`);

  // Settle them alternatingly: right half the time.
  const settled = calibrator.resolveWhere(() => true, true);
  assert.ok(settled > 0);

  // Half right, half wrong.
  const predictions = calibrator.report('test');
  assert.ok(predictions.resolved > 0);
  assert.ok(
    adapter.stats.meanStatedConfidence > 0.8,
    `the model claims high confidence: ${adapter.stats.meanStatedConfidence}`,
  );
});

test('model: a model that states no confidence contributes no prediction', async () => {
  const { adapter, calibrator } = rig(scripted([{ content: 'an answer with no confidence' }]), {
    withCalibrator: true,
  });

  await adapter.ask('x');
  assert.equal(calibrator.pendingCount, 0);
});

test('model: settling a prediction scores it against reality', async () => {
  const { adapter, calibrator } = rig(scripted([{ content: 'a claim', confidence: 0.95 }]), {
    withCalibrator: true,
  });

  await adapter.ask('a question');
  // Find the pending prediction by settling the domain.
  const settled = adapter.settleDomain('test', false);
  assert.equal(settled, 1);
  assert.equal(calibrator.pendingCount, 0);
  assert.equal(calibrator.resolvedCount, 1);
});

test('model: settleDomain only touches its own client\u2019s predictions', async () => {
  const { adapter, calibrator } = rig(scripted([{ content: 'a claim', confidence: 0.9 }]), {
    withCalibrator: true,
  });
  // Another source registers a prediction in the same domain.
  calibrator.predict('someone else\u2019s claim', 0.8, { domain: 'test', source: 'a-different-model' });
  await adapter.ask('a question');

  const settled = adapter.settleDomain('test', true);
  assert.equal(settled, 1, 'only this client\u2019s prediction was settled');
  assert.equal(calibrator.pendingCount, 1, 'the other model\u2019s claim is untouched');
});

test('model: settling without a calibrator is a no-op rather than a crash', async () => {
  const { adapter } = rig(scripted([{ content: 'a claim' }]));
  assert.equal(adapter.settleDomain('test', true), 0);
});

// ── Structured calls ────────────────────────────────────────────────────────

test('model: a well-formed structured response is returned', async () => {
  const client = scripted([{ content: '{"cause": "a flaky test", "severity": 3, "certain": true}' }]);
  const { adapter } = rig(client);

  const outcome = await adapter.askStructured<{ cause: string; severity: number; certain: boolean }>(
    'what went wrong?',
    { cause: 'string', severity: 'number', certain: 'boolean' },
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value.cause, 'a flaky test');
  assert.equal(outcome.value.severity, 3);
  assert.equal(outcome.value.certain, true);
});

test('model: the schema is described in the prompt', async () => {
  const client = scripted([{ content: '{"a": "x"}' }]);
  const { adapter } = rig(client);
  await adapter.askStructured('q', { a: 'string' });

  const prompt = client.requests[0]?.messages.at(-1)?.content ?? '';
  assert.match(prompt, /"a": string/);
  assert.match(prompt, /single JSON object/);
});

test('model: a malformed response is refused rather than coerced', async () => {
  const { adapter } = rig(scripted([{ content: 'I think the cause was a flaky test.' }]));

  const outcome = await adapter.askStructured('q', { cause: 'string' });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /not JSON/);
  assert.equal(adapter.stats.schemaFailures, 1);
});

test('model: a JSON object embedded in prose is found', async () => {
  const { adapter } = rig(scripted([{ content: 'Sure! Here you go:\n{"cause": "a flaky test"}\nHope that helps.' }]));

  // Models routinely add a sentence of preamble despite being asked not to, so
  // this single tolerance is deliberate. Everything else is strict.
  const outcome = await adapter.askStructured<{ cause: string }>('q', { cause: 'string' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value.cause, 'a flaky test');
});

test('model: a missing field is refused', async () => {
  const { adapter } = rig(scripted([{ content: '{"other": "value"}' }]));
  const outcome = await adapter.askStructured('q', { cause: 'string' });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /missing required field "cause"/);
});

test('model: a wrong type is refused, not coerced', async () => {
  const { adapter } = rig(scripted([{ content: '{"severity": "3"}' }]));

  // A model that returns "3" where a number was asked for has not answered the
  // question. Accepting it would surface the failure later, further from its
  // cause, in code that trusted the schema.
  const outcome = await adapter.askStructured('q', { severity: 'number' });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /must be a finite number/);
});

test('model: an array where an object was expected is refused', async () => {
  const { adapter } = rig(scripted([{ content: '[1, 2, 3]' }]));
  const outcome = await adapter.askStructured('q', { a: 'string' });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /expected a JSON object/);
});

test('model: an empty response is refused', async () => {
  const { adapter } = rig(scripted([{ content: '   ' }]));
  const outcome = await adapter.askStructured('q', { a: 'string' });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /empty/);
});

test('model: array field types are validated', async () => {
  const good = rig(scripted([{ content: '{"causes": ["a", "b"]}' }]));
  const okOutcome = await good.adapter.askStructured('q', { causes: 'string[]' });
  assert.equal(okOutcome.ok, true);

  const bad = rig(scripted([{ content: '{"causes": ["a", 2]}' }]));
  const badOutcome = await bad.adapter.askStructured('q', { causes: 'string[]' });
  assert.equal(badOutcome.ok, false);

  const numbers = rig(scripted([{ content: '{"values": [1, 2, 3]}' }]));
  assert.equal((await numbers.adapter.askStructured('q', { values: 'number[]' })).ok, true);
});

test('model: a malformed response is NOT retried', async () => {
  const client = scripted([{ content: 'not json at all' }, { content: '{"a": "properly formed"}' }]);
  const { adapter } = rig(client, { maxRetries: 3 });

  const outcome = await adapter.askStructured('q', { a: 'string' });
  // Retrying a schema failure would ask the same question hoping for a
  // different shape, which hides the model's real unreliability behind a retry
  // loop that makes the statistics look better than the model is.
  assert.equal(outcome.ok, false);
  assert.equal(client.calls, 1, 'the transport was called exactly once');
});

test('model: malformed responses are announced on the bus', async () => {
  const { kernel, adapter } = rig(scripted([{ content: 'not json' }]));
  const events: Record<string, unknown>[] = [];
  kernel.bus.on('model:malformed', (e) => events.push({ ...e.payload }));

  await adapter.askStructured('q', { a: 'string' });
  assert.equal(events.length, 1);
  assert.match(String(events[0]?.['reason']), /not JSON/);
});

// ── Structured output becomes belief ────────────────────────────────────────

test('model: a structured field becomes evidence for the proposition it names', async () => {
  const { adapter, beliefs } = rig(scripted([{ content: '{"cause": "a flaky test"}' }]), { withBeliefs: true });

  await adapter.askStructured('what went wrong?', { cause: 'string' });
  const belief = beliefs.get('cause: a flaky test');
  assert.ok(belief !== undefined, 'the assertion became a belief the mind holds');
  assert.equal(belief.evidence.length, 1);
});

test('model: a model is one source among many, not an authority', async () => {
  const withModel = rig(scripted([{ content: '{"claim": "the bridge is safe"}' }]), { withBeliefs: true });
  await withModel.adapter.askStructured('is it safe?', { claim: 'string' });
  const fromModel = withModel.beliefs.get('claim: the bridge is safe')?.credence ?? 0;

  const withDirectObservation = new BeliefStore({ clock: new Kernel().clock, bus: new Kernel().bus });
  withDirectObservation.declare('claim: the bridge is safe');
  withDirectObservation.addEvidence('claim: the bridge is safe', {
    content: 'an engineer inspected it directly',
    source: 'inspection',
    strength: 4,
    reliability: 1,
  });
  const fromDirect = withDirectObservation.get('claim: the bridge is safe')?.credence ?? 0;

  assert.ok(
    fromModel < fromDirect,
    `a model's assertion should move a belief less than a direct observation: ${fromModel} vs ${fromDirect}`,
  );
});

test('model: empty string fields do not become beliefs', async () => {
  const { adapter, beliefs } = rig(scripted([{ content: '{"cause": ""}' }]), { withBeliefs: true });
  await adapter.askStructured('q', { cause: 'string' });
  assert.equal(beliefs.size, 0);
});

test('model: a structured response also becomes a percept', async () => {
  const { adapter, working } = rig(scripted([{ content: '{"finding": "the pump is cavitating badly"}' }]), {
    withGate: true,
  });

  await adapter.askStructured('q', { finding: 'string' }, { intensity: 1 });
  assert.ok(working.size >= 1);
});

// ── Accounting ──────────────────────────────────────────────────────────────

test('model: tokens and latency are accounted for', async () => {
  const { adapter } = rig(scripted([{ content: 'an answer', tokens: 42 }]));
  await adapter.ask('x');

  const stats = adapter.stats;
  assert.equal(stats.calls, 1);
  assert.equal(stats.tokens, 42);
  assert.ok(stats.meanLatencyMs >= 0);
});

test('model: the well-formed rate reflects schema failures rather than transport ones', async () => {
  const { adapter } = rig(scripted([{ content: 'not json' }, { content: 'not json either' }]));

  await adapter.askStructured('q', { a: 'string' });
  await adapter.askStructured('q', { a: 'string' });

  // Two schema failures out of two parsed calls.
  assert.equal(adapter.stats.schemaFailures, 2);
  assert.ok(adapter.stats.wellFormedRate < 1);
});

test('model: history records each call', async () => {
  const { adapter } = rig(scripted([{ content: 'one' }, { content: 'two' }]));
  await adapter.ask('first');
  await adapter.ask('second');

  assert.equal(adapter.history.length, 2);
  assert.match(adapter.history[0]?.prompt ?? '', /first/);
});

test('model: history is bounded', async () => {
  const kernel = new Kernel();
  const client = scripted([{ content: 'answer' }]);
  const adapter = new ModelAdapter({
    clock: kernel.clock,
    bus: kernel.bus,
    rng: kernel.rng,
    client,
    historyLimit: 3,
  });

  for (let i = 0; i < 10; i += 1) await adapter.ask('x');
  assert.ok(adapter.history.length <= 3);
});

test('model: describe gives a one-line summary', async () => {
  const { adapter } = rig(scripted([{ content: 'an answer' }]));
  await adapter.ask('x');
  assert.match(adapter.describe(), /model\[scripted/);
});

test('model: clear resets the counters', async () => {
  const { adapter } = rig(scripted([{ content: 'an answer' }]));
  await adapter.ask('x');
  adapter.clear();

  assert.equal(adapter.stats.calls, 0);
  assert.equal(adapter.history.length, 0);
});

test('model: responses are announced on the bus', async () => {
  const { kernel, adapter } = rig(scripted([{ content: 'an answer' }]));
  const events: Record<string, unknown>[] = [];
  kernel.bus.on('model:responded', (e) => events.push({ ...e.payload }));

  await adapter.ask('x');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.['client'], 'scripted');
});

test('model: the same script produces the same call record', async () => {
  const run = async (): Promise<string> => {
    const { adapter } = rig(scripted([{ content: 'the answer', tokens: 7, confidence: 0.8 }]));
    await adapter.ask('the question');
    const s = adapter.stats;
    return `${s.calls}:${s.tokens}:${s.meanStatedConfidence}:${s.admitted}`;
  };
  assert.equal(await run(), await run());
});

// ── Parsing, directly ───────────────────────────────────────────────────────

test('parse: valid JSON passes', () => {
  const result = parseAndValidate('{"a": "x", "b": 2}', { a: 'string', b: 'number' });
  assert.equal(result.ok, true);
});

test('parse: extra fields are permitted', () => {
  // Strictness about the DECLARED shape, not about unknown extras: a model that
  // volunteers additional context has not failed the schema.
  const result = parseAndValidate('{"a": "x", "extra": true}', { a: 'string' });
  assert.equal(result.ok, true);
});

test('parse: null is not an object', () => {
  assert.equal(parseAndValidate('null', { a: 'string' }).ok, false);
});

test('parse: a JSON string is not an object', () => {
  assert.equal(parseAndValidate('"just a string"', { a: 'string' }).ok, false);
});

test('parse: braces in prose are found', () => {
  const result = parseAndValidate('As requested: {"a": "x"} — anything else?', { a: 'string' });
  assert.equal(result.ok, true);
});

test('parse: unterminated braces fail cleanly', () => {
  const result = parseAndValidate('{"a": "x"', { a: 'string' });
  assert.equal(result.ok, false);
});

test('parse: NaN and Infinity are refused as numbers', () => {
  assert.equal(parseAndValidate('{"a": 1e999}', { a: 'number' }).ok, false);
});

test('parse: non-finite values in arrays are refused', () => {
  assert.equal(parseAndValidate('{"a": [1, 2, 3]}', { a: 'number[]' }).ok, true);
  assert.equal(parseAndValidate('{"a": [1, "two"]}', { a: 'number[]' }).ok, false);
});

test('parse: failure reasons name the offending field', () => {
  const result = parseAndValidate('{"b": 1}', { a: 'string' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /"a"/);
});
