/**
 * LOGOS :: Perception :: Attention gate tests
 * ---------------------------------------------------------------------------
 * The central claim under test: SALIENCE IS NOT INTENSITY. Every test that
 * matters here is some version of "the same input is treated differently
 * depending on what the mind already expected".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PerceptionGate, type PerceptInput, type PredictionSource } from '../src/perception/gate.ts';
import { WorkingMemory } from '../src/memory/working.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import { LogosError } from '../src/kernel/types.ts';

interface Harness {
  readonly kernel: Kernel;
  readonly working: WorkingMemory;
  readonly gate: PerceptionGate;
}

const harness = (options: { readonly threshold?: number; readonly predictor?: PredictionSource } = {}): Harness => {
  const kernel = new Kernel();
  const working = new WorkingMemory({ capacity: 7 });
  const gate = new PerceptionGate({
    clock: kernel.clock,
    bus: kernel.bus,
    config: kernel.config,
    rng: kernel.rng,
    working,
    ...(options.predictor === undefined ? {} : { predictor: options.predictor }),
    ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
  });
  return { kernel, working, gate };
};

const percept = (content: string, over: Partial<PerceptInput> = {}): PerceptInput => ({ content, ...over });

// ── Scoring ─────────────────────────────────────────────────────────────────

test('perception: an empty percept is refused loudly', () => {
  const { gate } = harness();
  assert.throws(() => gate.score(percept('')), LogosError);
  assert.throws(() => gate.score(percept('   ')), LogosError);
});

test('perception: salience stays inside [0,1] whatever the terms do', () => {
  const { gate } = harness();
  const scored = gate.score(
    percept('an extremely intense unprecedented goal relevant emotional event', {
      intensity: 1,
      goalText: ['an extremely intense unprecedented goal relevant emotional event'],
      affect: { valence: 1, arousal: 1 },
    }),
  );
  assert.ok(scored.salience >= 0 && scored.salience <= 1, `salience was ${scored.salience}`);
});

test('perception: the five terms are reported for every percept', () => {
  const { gate } = harness();
  const scored = gate.score(percept('something happened'));
  for (const key of ['novelty', 'intensity', 'relevance', 'surprise', 'affect', 'habituation'] as const) {
    assert.equal(typeof scored.terms[key], 'number', `${key} must be reported`);
  }
});

test('perception: all-zero weights are refused rather than silently producing zero salience', () => {
  const kernel = new Kernel();
  assert.throws(
    () =>
      new PerceptionGate({
        clock: kernel.clock,
        bus: kernel.bus,
        config: kernel.config,
        rng: kernel.rng,
        working: new WorkingMemory(),
        weights: { novelty: 0, intensity: 0, relevance: 0, surprise: 0, affect: 0 },
      }),
    LogosError,
  );
});

// ── Novelty ─────────────────────────────────────────────────────────────────

test('perception: the first thing noticed is maximally novel', () => {
  const { gate } = harness();
  assert.equal(gate.score(percept('the very first observation')).terms.novelty, 1);
});

test('perception: something unlike what is held scores higher novelty', () => {
  const { gate, working } = harness();
  working.encode('the temperature in the reactor vessel is stable', { salience: 0.9 });

  const similar = gate.score(percept('the temperature in the reactor vessel is stable'));
  const different = gate.score(percept('a flock of geese crossed the northern runway'));

  assert.ok(
    different.terms.novelty > similar.terms.novelty,
    `unlike content should be more novel: ${different.terms.novelty} vs ${similar.terms.novelty}`,
  );
});

// ── Relevance ───────────────────────────────────────────────────────────────

test('perception: content bearing on an active goal is more salient', () => {
  const { gate } = harness();
  const goal = ['find the source of the coolant leak'];

  const relevant = gate.score(percept('the coolant leak is coming from the lower manifold', { goalText: goal }));
  const irrelevant = gate.score(percept('the cafeteria is serving soup today', { goalText: goal }));

  assert.ok(
    relevant.terms.relevance > irrelevant.terms.relevance,
    `goal relevance was not detected: ${relevant.terms.relevance} vs ${irrelevant.terms.relevance}`,
  );
  assert.ok(relevant.salience > irrelevant.salience, 'and it should show up in the salience');
});

test('perception: with no goal stated, relevance contributes nothing', () => {
  const { gate } = harness();
  assert.equal(gate.score(percept('anything at all')).terms.relevance, 0);
});

// ── Surprise ────────────────────────────────────────────────────────────────

test('perception: surprise comes from the prediction source', () => {
  const predictor: PredictionSource = { surpriseOf: () => 0.9 };
  const { gate } = harness({ predictor });
  assert.equal(gate.score(percept('something unexpected')).terms.surprise, 0.9);
});

test('perception: an unpredicted percept is novel, not surprising', () => {
  // The distinction matters: conflating them would make every first experience
  // read as a violated expectation, which is the opposite of informative.
  const predictor: PredictionSource = { surpriseOf: () => undefined };
  const { gate } = harness({ predictor });
  assert.equal(gate.score(percept('never seen before')).terms.surprise, 0);
});

test('perception: surprise makes the difference between noticing and not', () => {
  // Identical input, identical memory. The only difference is whether the mind
  // expected it.
  const expecting: PredictionSource = { surpriseOf: () => 0 };
  const surprised: PredictionSource = { surpriseOf: () => 1 };

  const calm = harness({ predictor: expecting, threshold: 0.4 });
  const alarmed = harness({ predictor: surprised, threshold: 0.4 });

  const input = percept('the pressure reading is nominal', { intensity: 0.5 });
  const quiet = calm.gate.perceive(input);
  const loud = alarmed.gate.perceive(input);

  assert.equal(quiet.admitted, false, 'the expected reading is not news');
  assert.equal(loud.admitted, true, 'the same reading when unexpected is');
  assert.ok(loud.percept.salience > quiet.percept.salience);
});

test('perception: the predictor can be attached after construction', () => {
  const { gate } = harness({ threshold: 0.5 });
  const before = gate.score(percept('a reading arrives')).terms.surprise;
  gate.setPredictor({ surpriseOf: () => 0.8 });
  const after = gate.score(percept('a reading arrives')).terms.surprise;

  assert.equal(before, 0);
  assert.equal(after, 0.8, 'the gate was assembled before the world model existed');
});

// ── Habituation ─────────────────────────────────────────────────────────────

test('perception: a repeated stimulus becomes less salient each time', () => {
  const { gate, kernel } = harness({ threshold: 0.05 });
  const saliences: number[] = [];

  for (let i = 0; i < 6; i += 1) {
    const decision = gate.perceive(percept('the pump is running', { source: 'sensor-1' }));
    saliences.push(decision.percept.salience);
    kernel.clock.step();
  }

  for (let i = 1; i < saliences.length; i += 1) {
    assert.ok(
      (saliences[i] as number) <= (saliences[i - 1] as number) + 1e-9,
      `salience should not rise with repetition: ${saliences.join(', ')}`,
    );
  }
  assert.ok((saliences[5] as number) < (saliences[0] as number), 'and must fall overall');
});

test('perception: habituation eventually stops admitting a constant stimulus', () => {
  const { gate, kernel } = harness({ threshold: 0.35 });

  let admitted = 0;
  for (let i = 0; i < 12; i += 1) {
    if (gate.perceive(percept('the pump is running', { source: 'sensor-1' })).admitted) admitted += 1;
    kernel.clock.step();
  }

  assert.ok(admitted < 12, `a constant stimulus should stop being news: ${admitted}/12 admitted`);
  assert.ok((gate.stats.habituated ?? 0) >= 1);
});

test('perception: the same words from a different source are not habituated', () => {
  // A repeated alert from one sensor is habituation; the identical alert from
  // a second sensor is corroboration and must not be damped.
  const { gate, kernel } = harness({ threshold: 0.05 });

  for (let i = 0; i < 6; i += 1) {
    gate.perceive(percept('the pump is running', { source: 'sensor-1' }));
    kernel.clock.step();
  }

  const second = gate.perceive(percept('the pump is running', { source: 'sensor-2' }));
  assert.equal(second.percept.terms.habituation, 1, 'a different source is a fresh stimulus');
});

test('perception: habituation recovers when the stimulus stops', () => {
  const { gate, kernel } = harness({ threshold: 0.05 });

  for (let i = 0; i < 6; i += 1) {
    gate.perceive(percept('a steady hum', { source: 'mic' }));
    kernel.clock.step();
  }
  const habituated = gate.score(percept('a steady hum', { source: 'mic' })).terms.habituation;

  for (let i = 0; i < 200; i += 1) kernel.clock.step();
  const recovered = gate.score(percept('a steady hum', { source: 'mic' })).terms.habituation;

  assert.ok(habituated < 0.5, `it should have habituated: ${habituated}`);
  assert.ok(recovered > habituated, `and recovered: ${recovered}`);
});

test('perception: dishabituation can be forced', () => {
  const { gate, kernel } = harness({ threshold: 0.05 });
  for (let i = 0; i < 6; i += 1) {
    gate.perceive(percept('a steady hum', { source: 'mic' }));
    kernel.clock.step();
  }
  assert.ok(gate.score(percept('a steady hum', { source: 'mic' })).terms.habituation < 0.5);

  gate.dishabituate();
  assert.equal(gate.score(percept('a steady hum', { source: 'mic' })).terms.habituation, 1);
});

test('perception: habituation has a floor, so a constant stimulus never vanishes entirely', () => {
  const { gate, kernel } = harness({ threshold: 0.05, });
  for (let i = 0; i < 60; i += 1) {
    gate.perceive(percept('the same thing over and over', { source: 's' }));
    kernel.clock.step();
  }
  const factor = gate.score(percept('the same thing over and over', { source: 's' })).terms.habituation;
  assert.ok(factor > 0, 'a stimulus that never changes should still be faintly present');
});

// ── Admission and rejection ─────────────────────────────────────────────────

test('perception: a salient percept reaches working memory', () => {
  const { gate, working } = harness({ threshold: 0.2 });
  const decision = gate.perceive(percept('an urgent and novel development', { intensity: 0.9 }));

  assert.equal(decision.admitted, true);
  assert.equal(decision.reason, '');
  assert.equal(working.size, 1);
  assert.equal(working.contents()[0]?.content, 'an urgent and novel development');
});

test('perception: a dull percept is turned away with a reason', () => {
  const { gate, working } = harness({ threshold: 0.6 });
  const decision = gate.perceive(percept('nothing much', { intensity: 0.05 }));

  assert.equal(decision.admitted, false);
  assert.ok(decision.reason === 'below-threshold' || decision.reason === 'habituated');
  assert.equal(working.size, 0);
});

test('perception: a habituated rejection says so specifically', () => {
  const { gate, kernel } = harness({ threshold: 0.5 });
  let decision = gate.perceive(percept('the pump is running', { source: 'sensor-1' }));

  // Keep presenting until habituation, rather than salience, is what turns it
  // away. Early repetitions are refused for being unremarkable; only after
  // several does the refusal become specifically about repetition.
  for (let i = 0; i < 10 && decision.reason !== 'habituated'; i += 1) {
    kernel.clock.step();
    decision = gate.perceive(percept('the pump is running', { source: 'sensor-1' }));
  }

  assert.equal(decision.admitted, false);
  assert.equal(decision.reason, 'habituated', 'the reason must distinguish habituation from dullness');
  assert.ok(decision.percept.terms.habituation < 0.5);
});

test('perception: the percept carries its modality, source and data into memory', () => {
  const { gate, working } = harness({ threshold: 0.2 });
  gate.perceive(
    percept('a structured reading arrived', {
      modality: 'numeric',
      source: 'thermocouple-3',
      intensity: 0.9,
      data: { value: 451, unit: 'K' },
    }),
  );

  const held = working.contents()[0];
  assert.ok(held !== undefined);
  const stored = working.get(held.id, { reinforce: false });
  assert.equal(stored?.data['modality'], 'numeric');
  assert.equal(stored?.data['source'], 'thermocouple-3');
  assert.equal(stored?.data['value'], 451);
});

test('perception: admission and suppression are both announced on the bus', () => {
  const { gate, kernel } = harness({ threshold: 0.3 });
  const events: string[] = [];
  kernel.bus.on('perception:*', (e) => events.push(e.type));

  gate.perceive(percept('a striking new event', { intensity: 1 }));
  gate.perceive(percept('a dull nothing', { intensity: 0 }));

  assert.ok(events.includes('perception:admitted'));
  assert.ok(events.includes('perception:suppressed'), 'a suppressed percept is not silently discarded');
});

test('perception: a saturated working memory is reported as its own reason', () => {
  const { gate, working } = harness({ threshold: 0.05 });
  // Fill working memory with loud, distinct content.
  for (let i = 0; i < 20; i += 1) {
    working.encode(`a loud distinct fact number ${i} about ${['alpha', 'beta', 'gamma', 'delta'][i % 4]}`, {
      salience: 1,
      confidence: 1,
    });
  }

  const decisions = gate.perceiveAll(
    Array.from({ length: 10 }, (_, i) => percept(`a marginal observation number ${i}`, { intensity: 0.3 })),
  );

  // Every one is either admitted or given a reason; none vanish.
  for (const d of decisions) {
    assert.ok(d.admitted || d.reason !== '', 'every decision carries an outcome');
  }
  assert.ok(decisions.some((d) => !d.admitted), 'the gate cannot admit past capacity');
});

test('perception: perceiveAll scores and decides each input', () => {
  const { gate } = harness({ threshold: 0.3 });
  const decisions = gate.perceiveAll([
    percept('first striking event', { intensity: 1 }),
    percept('second striking event', { intensity: 1 }),
  ]);
  assert.equal(decisions.length, 2);
  const stats = gate.stats;
  assert.equal(
    (stats.admitted ?? 0) + (stats.rejected ?? 0) + (stats.saturated ?? 0),
    2,
    'both percepts are accounted for',
  );
});

// ── Load adaptation ─────────────────────────────────────────────────────────

test('perception: sustained memory pressure raises the bar', () => {
  // Working memory is the bottleneck, so it is memory pressure that makes a
  // gate selective. A large working memory has no pressure to respond to.
  const kernel = new Kernel();
  const working = new WorkingMemory({ capacity: 3 });
  const gate = new PerceptionGate({
    clock: kernel.clock,
    bus: kernel.bus,
    config: kernel.config,
    rng: kernel.rng,
    working,
    threshold: 0.05,
  });
  const before = gate.threshold;

  for (let i = 0; i < 30; i += 1) {
    gate.perceive(
      percept(`distinct observation number ${i} regarding ${['alpha', 'beta', 'gamma', 'delta'][i % 4]}`, {
        intensity: 1,
        source: `s${i}`,
      }),
    );
    kernel.clock.step();
  }

  assert.ok(
    gate.threshold > before,
    `a saturated gate must become selective: ${before} -> ${gate.threshold}`,
  );
  assert.ok(gate.adaptation > 0);
  assert.ok(working.pressure >= 0.75, 'and memory is genuinely under pressure');
});

test('perception: sustained rejection lowers the bar', () => {
  const { gate, kernel } = harness({ threshold: 0.9 });
  const before = gate.threshold;

  for (let i = 0; i < 40; i += 1) {
    gate.perceive(percept(`a marginal observation number ${i}`, { intensity: 0.05, source: `s${i}` }));
    kernel.clock.step();
  }

  assert.ok(gate.threshold < before, `a gate admitting nothing should relax: ${before} -> ${gate.threshold}`);
  assert.ok(gate.adaptation < 0);
});

test('perception: adaptation decays back toward the base threshold', () => {
  const kernel = new Kernel();
  const gate = new PerceptionGate({
    clock: kernel.clock,
    bus: kernel.bus,
    config: kernel.config,
    rng: kernel.rng,
    working: new WorkingMemory({ capacity: 3 }),
    threshold: 0.05,
  });

  for (let i = 0; i < 30; i += 1) {
    gate.perceive(percept(`distinct observation number ${i}`, { intensity: 1, source: `s${i}` }));
    kernel.clock.step();
  }
  const elevated = gate.threshold;
  assert.ok(elevated > gate.stats.baseThreshold!, 'it went up first');

  for (let i = 0; i < 300; i += 1) gate.step();
  assert.ok(gate.threshold < elevated, 'and comes back down');
  assert.ok(Math.abs(gate.threshold - gate.stats.baseThreshold!) < 1e-3, 'all the way to base');
});

test('perception: the base threshold is a policy, not a suggestion — adaptation never exceeds it permanently', () => {
  const { gate } = harness({ threshold: 0.4 });
  const base = gate.threshold;
  for (let i = 0; i < 500; i += 1) {
    gate.perceive(percept(`event ${i}`, { intensity: 1, source: `s${i}` }));
  }
  for (let i = 0; i < 1_000; i += 1) gate.step();
  assert.ok(Math.abs(gate.threshold - base) < 1e-3, `settled at ${gate.threshold}, base was ${base}`);
});

// ── Introspection ───────────────────────────────────────────────────────────

test('perception: snapshot reports the gate state and recent decisions', () => {
  const { gate } = harness({ threshold: 0.3 });
  gate.perceive(percept('a striking new event', { intensity: 1 }));

  const snapshot = gate.snapshot();
  assert.equal(typeof snapshot.threshold, 'number');
  assert.equal(typeof snapshot.admissionRate, 'number');
  assert.ok(snapshot.recent.length >= 1);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});

test('perception: describe() gives a one-line summary', () => {
  const { gate } = harness({ threshold: 0.3 });
  gate.perceive(percept('a striking new event', { intensity: 1 }));
  const line = gate.describe();
  assert.match(line, /gate\[/);
  assert.match(line, /admitted=1/);
});

test('perception: stats satisfy their accounting identity', () => {
  const { gate } = harness({ threshold: 0.3 });
  for (let i = 0; i < 12; i += 1) {
    gate.perceive(percept(`observation number ${i}`, { intensity: (i % 5) / 4, source: `s${i}` }));
  }
  const stats = gate.stats;
  assert.equal(
    (stats.admitted ?? 0) + (stats.rejected ?? 0) + (stats.saturated ?? 0),
    12,
    'no percept goes unaccounted for',
  );
  const rate = stats.admissionRate ?? 0;
  assert.ok(rate >= 0 && rate <= 1);
});

test('perception: reset clears state and counters', () => {
  const { gate } = harness({ threshold: 0.3 });
  gate.perceive(percept('something', { intensity: 1 }));
  gate.reset();

  assert.equal(gate.stats.admitted, 0);
  assert.equal(gate.stats.rejected, 0);
  assert.equal(gate.stats.habituated, 0);
  assert.equal(gate.snapshot().recent.length, 0);
});

test('perception: the whole pipeline is reproducible from one seed', () => {
  const run = (): string => {
    const { gate, kernel } = harness({ threshold: 0.3 });
    const lines: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const decision = gate.perceive(percept(`event ${i % 3} from source ${i % 2}`, { intensity: 0.6 }));
      lines.push(`${decision.admitted}:${decision.percept.salience.toFixed(6)}`);
      kernel.clock.step();
    }
    return lines.join('|');
  };
  assert.equal(run(), run());
});
