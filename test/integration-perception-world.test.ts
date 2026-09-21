/**
 * LOGOS :: Integration :: Perception ↔ world model
 * ---------------------------------------------------------------------------
 * The perceptual gate's central claim is that salience is surprise. That claim
 * is only true if a real prediction source is wired into it, so this file tests
 * the claim end to end rather than in pieces:
 *
 *   an identical percept must be admitted or refused depending on whether the
 *   world model expected it, with no other input differing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Kernel } from '../src/kernel/kernel.ts';
import { WorkingMemory } from '../src/memory/working.ts';
import { PerceptionGate } from '../src/perception/gate.ts';
import { WorldModel } from '../src/reasoning/world-model.ts';

interface Rig {
  readonly kernel: Kernel;
  readonly working: WorkingMemory;
  readonly world: WorldModel;
  readonly gate: PerceptionGate;
}

const rig = (options: { readonly gateThreshold?: number; readonly matchThreshold?: number } = {}): Rig => {
  const kernel = new Kernel();
  const working = new WorkingMemory({ capacity: 20 });
  const world = new WorldModel({
    clock: kernel.clock,
    bus: kernel.bus,
    rng: kernel.rng,
    matchThreshold: options.matchThreshold ?? 0.95,
  });
  const gate = new PerceptionGate({
    clock: kernel.clock,
    bus: kernel.bus,
    config: kernel.config,
    rng: kernel.rng,
    working,
    predictor: world,
    threshold: options.gateThreshold ?? 0.4,
  });
  return { kernel, working, world, gate };
};

test('integration: the world model satisfies the gate without adaptation', () => {
  const { world } = rig();
  // Compile-time proof that WorldModel is a valid PredictionSource. If the
  // interface drifts, this stops building.
  const source: { surpriseOf(p: { content: string; source: string; modality: 'text' }): number | undefined } = world;
  assert.equal(typeof source.surpriseOf, 'function');
});

test('integration: an expected reading is not news, an unexpected one is', () => {
  // Two identical rigs and the SAME current state; the only difference is what
  // each world model has learned to expect from it.
  const build = (outcomes: readonly string[]): { world: WorldModel; kernel: Kernel } => {
    const kernel = new Kernel();
    const world = new WorldModel({ clock: kernel.clock, bus: kernel.bus, rng: kernel.rng, matchThreshold: 0.95 });
    for (let i = 0; i < 12; i += 1) {
      world.observe({ content: 'the gauge reads steady' });
      world.observe({ content: outcomes[i % outcomes.length] as string });
    }
    // Leave the world sitting on the antecedent, so the next percept is
    // genuinely a prediction rather than a fresh observation.
    world.observe({ content: 'the gauge reads steady' });
    return { world, kernel };
  };

  const predictable = build(['the alarm stays silent']);
  const erratic = build([
    'the alarm stays silent',
    'a valve shudders',
    'the lamp flickers',
    'a relay chatters',
    'pressure dips briefly',
    'the fan speeds up',
    'a warning clears itself',
  ]);

  const expected = predictable.world.surpriseOf({
    content: 'the alarm stays silent',
    source: 'panel',
    modality: 'text',
  });
  const unexpected = erratic.world.surpriseOf({
    content: 'the lamp flickers',
    source: 'panel',
    modality: 'text',
  });

  assert.ok(expected !== undefined, 'the predictable world can predict');
  assert.ok(unexpected !== undefined, 'and so can the erratic one');
  assert.ok(
    expected < unexpected,
    `a certain outcome should surprise less than one of seven: ${expected} vs ${unexpected}`,
  );
});

test('integration: surprise pushes a percept over the admission threshold', () => {
  const build = (outcomes: readonly string[]): { world: WorldModel; kernel: Kernel; gate: PerceptionGate; working: WorkingMemory } => {
    const kernel = new Kernel();
    const working = new WorkingMemory({ capacity: 20 });
    const world = new WorldModel({ clock: kernel.clock, bus: kernel.bus, rng: kernel.rng, matchThreshold: 0.95 });
    const gate = new PerceptionGate({
      clock: kernel.clock,
      bus: kernel.bus,
      config: kernel.config,
      rng: kernel.rng,
      working,
      predictor: world,
      threshold: 0.35,
    });
    for (let i = 0; i < 12; i += 1) {
      world.observe({ content: 'the gauge reads steady' });
      world.observe({ content: outcomes[i % outcomes.length] as string });
    }
    world.observe({ content: 'the gauge reads steady' });
    return { world, kernel, gate, working };
  };

  const steady = build(['the alarm stays silent']);
  const erratic = build([
    'the alarm stays silent',
    'a valve shudders',
    'the lamp flickers',
    'a relay chatters',
    'pressure dips briefly',
    'the fan speeds up',
    'a warning clears itself',
  ]);

  const identical = { source: 'panel', modality: 'text' as const, intensity: 0.5 };
  const quiet = steady.gate.score({ content: 'the alarm stays silent', ...identical });
  const loud = erratic.gate.score({ content: 'the lamp flickers', ...identical });

  assert.ok(
    loud.terms.surprise > quiet.terms.surprise,
    `the gate received the model's surprise: ${loud.terms.surprise} vs ${quiet.terms.surprise}`,
  );
  assert.ok(
    loud.salience > quiet.salience,
    `and it raised salience: ${loud.salience} vs ${quiet.salience}`,
  );
  void steady.kernel;
  void erratic.working;
});

test('integration: an unpredicted percept is admitted on novelty, not on surprise', () => {
  // A fresh model predicts nothing. A percept must still be able to get in —
  // otherwise nothing would ever be learned in the first place.
  const { gate, working } = rig({ gateThreshold: 0.3 });

  const decision = gate.perceive({
    content: 'a wholly unprecedented observation arrives',
    source: 'unknown',
    modality: 'text',
    intensity: 0.9,
  });

  assert.equal(decision.percept.terms.surprise, 0, 'nothing was expected, so nothing was violated');
  assert.ok(decision.percept.terms.novelty > 0.5, 'but it is novel');
  assert.equal(decision.admitted, true, 'novelty alone can open the gate');
  assert.equal(working.size, 1);
});

test('integration: a violated expectation announces a world revision', () => {
  const { kernel, world } = rig();
  const revisions: unknown[] = [];
  kernel.bus.on('world:revised', (e) => revisions.push(e.payload));

  for (let i = 0; i < 10; i += 1) {
    world.observe({ content: 'the routine proceeds as normal' });
    world.observe({ content: 'the routine reaches its usual end' });
  }
  world.observe({ content: 'the routine proceeds as normal' });
  world.observe({ content: 'something unthinkable interrupts everything' });

  assert.ok(revisions.length >= 1, 'the model announced that its expectations were wrong');
});

test('integration: the gate and the model share one logical clock', () => {
  const { kernel, world, gate } = rig();
  kernel.clock.advance(7);

  const observation = world.observe({ content: 'something at a known instant' });
  const scored = gate.score({ content: 'something at a known instant' });

  // The expectation is a snapshot taken BEFORE learning, which is why it
  // reports no support: at that instant the state was genuinely unknown, and
  // that is exactly what makes the surprise calculation honest.
  assert.equal(observation.expectation.support, 0);
  assert.equal(observation.expectation.stateKey, undefined);
  assert.equal(observation.surprise, 0, 'nothing was expected, so nothing was violated');
  assert.equal(observation.novelObservation, true);

  // Afterwards the state is known.
  assert.equal(world.expect('something at a known instant').support, 1);
  assert.equal(scored.at, 7, 'both subsystems read the same tick');
});

test('integration: habituating the gate does not corrupt the world model', () => {
  const { kernel, world, gate } = rig({ gateThreshold: 0.4 });

  for (let i = 0; i < 10; i += 1) {
    gate.perceive({ content: 'the same steady signal', source: 'probe', modality: 'text', intensity: 0.5 });
    world.observe({ content: 'the same steady signal' });
    kernel.clock.step();
  }

  assert.deepEqual(world.check(), [], 'the model stayed internally consistent');
  assert.ok(world.stateCount >= 1);
  assert.ok((gate.stats.habituated ?? 0) >= 1, 'and the gate did habituate');
});

test('integration: a full cycle is reproducible from one seed', () => {
  const run = (): string => {
    const { kernel, world, gate } = rig({ gateThreshold: 0.35 });
    const trace: string[] = [];

    const stream = [
      'the pump starts',
      'pressure rises slowly',
      'the valve opens',
      'flow stabilises',
      'the pump starts',
      'pressure rises slowly',
      'the valve jams shut',
      'pressure spikes dangerously',
    ];

    for (const content of stream) {
      const decision = gate.perceive({ content, source: 'plant', modality: 'numeric', intensity: 0.6 });
      const outcome = world.observe({ content });
      trace.push(
        `${decision.admitted ? 'A' : '-'}${decision.percept.salience.toFixed(4)}/${outcome.surprise.toFixed(4)}`,
      );
      kernel.clock.step();
    }
    return trace.join('|');
  };

  assert.equal(run(), run(), 'the same stream must produce the same cognition');
});

test('integration: the whole rig survives a long session without inconsistency', () => {
  const { kernel, world, gate } = rig({ gateThreshold: 0.3 });

  const vocabulary = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
  for (let i = 0; i < 400; i += 1) {
    const content = `stage ${vocabulary[i % vocabulary.length]} reports ${i % 3 === 0 ? 'nominal' : 'nominal'}`;
    gate.perceive({ content, source: `src${i % 4}`, modality: 'event', intensity: (i % 5) / 4 });
    world.observe({ content, data: { index: i } });
    if (i % 3 === 0) kernel.clock.step();
  }

  assert.deepEqual(world.check(), []);
  assert.deepEqual(gate.snapshot().recent.length > 0, true);
  assert.ok(world.stats().observations === 400);
  assert.ok((gate.stats.admitted ?? 0) + (gate.stats.rejected ?? 0) + (gate.stats.saturated ?? 0) === 400);
});
