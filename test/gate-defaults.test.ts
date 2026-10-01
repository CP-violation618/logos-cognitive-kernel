/**
 * LOGOS :: An observation can actually get in
 * ---------------------------------------------------------------------------
 * This file exists because a whole class of defect was hiding in the gap
 * between two things that each looked fine.
 *
 * Every perception test passed an explicit `threshold`. Every configuration
 * test checked that thresholds were in range. Nothing checked the two
 * TOGETHER, and the shipped default was therefore
 *
 *     threshold 0.35   vs   ceiling for a maximally novel percept 0.35
 *
 * — exactly equal, and only reachable at intensity 1.0. In practice the gate
 * refused a first observation of anything at any intensity a caller would
 * plausibly use. The REPL, which feeds typed input at 0.8, could not admit a
 * single percept: you could type all day and watch nothing happen.
 *
 * The lesson is narrow and worth stating: a threshold and a distribution have
 * to be checked as a PAIR. Either one alone looks reasonable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Kernel } from '../src/kernel/kernel.ts';
import { WorkingMemory } from '../src/memory/working.ts';
import { PerceptionGate } from '../src/perception/gate.ts';
import { WorldModel } from '../src/reasoning/world-model.ts';

/** A gate built from the shipped defaults — no threshold override anywhere. */
const defaultGate = (): { readonly gate: PerceptionGate; readonly working: WorkingMemory; readonly threshold: number } => {
  const kernel = new Kernel();
  const working = new WorkingMemory({ capacity: kernel.config.memory.workingSlots });
  const world = new WorldModel({ clock: kernel.clock, bus: kernel.bus, rng: kernel.rng });
  const gate = new PerceptionGate({
    clock: kernel.clock,
    bus: kernel.bus,
    config: kernel.config,
    rng: kernel.rng,
    working,
    predictor: world,
  });
  return { gate, working, threshold: kernel.config.memory.attentionThreshold };
};

test('gate defaults: a novel observation at ordinary intensity is admitted', () => {
  const { gate, threshold } = defaultGate();

  // The exact case that was broken: something unprecedented, stated with the
  // intensity an interactive caller uses.
  const decision = gate.perceive({
    content: 'the primary database has stopped accepting writes',
    source: 'user',
    modality: 'text',
    intensity: 0.8,
  });

  assert.equal(
    decision.admitted,
    true,
    `a maximally novel percept scored ${decision.percept.salience.toFixed(4)} against a threshold of ${threshold}. ` +
      'If these are equal the gate only admits full-intensity input, which is not a gate — it is a closed door.',
  );
});

test('gate defaults: the novelty ceiling clears the threshold with room to spare', () => {
  const { gate, threshold } = defaultGate();

  // The arithmetic the defaults have to satisfy, asserted rather than assumed:
  // novelty alone, at zero intensity, must already be a meaningful fraction of
  // the threshold. Otherwise "novel" and "admissible" are unrelated.
  const bare = gate.perceive({
    content: 'a completely unprecedented observation about something else entirely',
    source: 'user',
    modality: 'text',
    intensity: 0,
  });

  const noveltyOnly = bare.percept.terms.novelty;
  assert.equal(noveltyOnly, 1, 'a first observation should be maximally novel');

  // A maximally novel percept at intensity 0 must still be within reach of the
  // threshold — reachable by adding intensity, not by maxing it out.
  const atZero = bare.percept.salience;
  assert.ok(
    atZero < threshold,
    `a novel but silent percept should NOT be admitted: ${atZero} vs ${threshold}`,
  );
  assert.ok(
    threshold - atZero <= 0.05,
    `a novel percept is ${(threshold - atZero).toFixed(4)} short of the threshold, so only ` +
      'loud input gets in and novelty is effectively ignored',
  );
});

test('gate defaults: a familiar observation is still refused', () => {
  const { gate, working } = defaultGate();

  // Lowering the threshold must not have turned the gate into a pass-through.
  // A repeat carries novelty near zero and cannot reach the threshold on
  // intensity, which is the property that makes the number safe to lower.
  gate.perceive({ content: 'heartbeat ok', source: 'monitor', modality: 'text', intensity: 1 });
  for (let i = 0; i < 10; i += 1) {
    gate.perceive({ content: 'heartbeat ok', source: 'monitor', modality: 'text', intensity: 0.2 });
    gate.step();
  }

  const decision = gate.perceive({
    content: 'heartbeat ok',
    source: 'monitor',
    modality: 'text',
    intensity: 0.2,
  });

  assert.equal(decision.admitted, false, 'the gate admits everything, so attention means nothing');
  assert.equal(decision.reason, 'habituated');
  assert.equal(working.size, 1, 'only the first one got in');
});

test('gate defaults: something surprising gets in even when it is quiet', () => {
  const kernel = new Kernel();
  const working = new WorkingMemory({ capacity: kernel.config.memory.workingSlots });
  const world = new WorldModel({ clock: kernel.clock, bus: kernel.bus, rng: kernel.rng });
  const gate = new PerceptionGate({
    clock: kernel.clock,
    bus: kernel.bus,
    config: kernel.config,
    rng: kernel.rng,
    working,
    predictor: world,
  });

  // Teach the world a regular pattern, so a departure from it is genuinely
  // surprising rather than merely new.
  for (let i = 0; i < 6; i += 1) {
    world.observe({ content: 'the cache is cold', source: 'monitor' });
    world.observe({ content: 'the latency is high', source: 'monitor' });
  }

  const quiet = gate.perceive({
    content: 'the datacentre is on fire and everything is offline',
    source: 'monitor',
    modality: 'text',
    intensity: 0.1,
  });

  // Surprise is what the gate weighs most heavily, and it carries the decision
  // here: a soft-spoken catastrophe should still get through.
  assert.ok(quiet.percept.terms.surprise > 0.5, 'the observation should be surprising');
  assert.equal(quiet.admitted, true, 'a quiet but genuinely surprising observation was refused');
});

test('gate defaults: an empty mind still has somewhere to put the first percept', () => {
  const { gate, working } = defaultGate();
  assert.equal(working.size, 0);

  const decision = gate.perceive({
    content: 'the very first thing this mind has ever encountered',
    source: 'user',
    modality: 'text',
    intensity: 0.8,
  });

  // If the first percept cannot get in, nothing ever can: there is no second
  // percept to be surprised by.
  assert.equal(decision.admitted, true);
  assert.equal(working.size, 1);
});
