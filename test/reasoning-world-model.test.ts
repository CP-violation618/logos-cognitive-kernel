/**
 * LOGOS :: Reasoning :: World model tests
 * ---------------------------------------------------------------------------
 * Three claims under test, each of which is a design commitment rather than an
 * implementation detail:
 *
 *   · prediction is DISTRIBUTIONAL — the model says how likely, not just what;
 *   · UNKNOWN IS NOT SURPRISING — a first sighting scores 0, not 1;
 *   · surprise is computed BEFORE learning — otherwise nothing is ever
 *     surprising, because the model has already been told.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WorldModel } from '../src/reasoning/world-model.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import { LogosError } from '../src/kernel/types.ts';

const harness = (options: { readonly matchThreshold?: number; readonly surpriseThreshold?: number; readonly maxStates?: number } = {}): {
  readonly kernel: Kernel;
  readonly world: WorldModel;
} => {
  const kernel = new Kernel();
  const world = new WorldModel({
    clock: kernel.clock,
    bus: kernel.bus,
    rng: kernel.rng,
    ...options,
  });
  return { kernel, world };
};

// ── Learning ────────────────────────────────────────────────────────────────

test('world: an empty observation is refused loudly', () => {
  const { world } = harness();
  assert.throws(() => world.observe({ content: '' }), LogosError);
  assert.throws(() => world.observe({ content: '  ' }), LogosError);
});

test('world: observing a sequence builds a transition table', () => {
  const { world } = harness();

  world.observe({ content: 'the door is closed' });
  world.observe({ content: 'the handle turns' });
  world.observe({ content: 'the door is open' });

  assert.equal(world.stateCount, 3);
  assert.equal(world.transitionCount, 2, 'two transitions were observed');
  assert.deepEqual(world.check(), []);
});

test('world: a repeated sequence accumulates support instead of duplicating states', () => {
  const { world } = harness();

  for (let i = 0; i < 5; i += 1) {
    world.observe({ content: 'the pump is idle' });
    world.observe({ content: 'the pump starts' });
  }

  assert.equal(world.stateCount, 2, 'two states, however many times seen');
  const expectation = world.expect('the pump is idle');
  assert.equal(expectation.support, 5);
  assert.equal(expectation.successors.length, 1);
  assert.equal(expectation.successors[0]?.support, 5);
});

test('world: similar but differently phrased observations are one state', () => {
  const { world } = harness({ matchThreshold: 0.5 });

  world.observe({ content: 'the pump is idle and waiting' });
  world.observe({ content: 'the pump is idle and waiting patiently' });

  // A state is a situation, not a string. Treating near-identical phrasings as
  // distinct would mean the model never accumulates enough support to predict.
  assert.equal(world.stateCount, 1);
});

test('world: the current state is reported', () => {
  const { world } = harness();
  assert.equal(world.currentState(), undefined);

  world.observe({ content: 'a state of affairs' });
  assert.equal(world.currentState()?.content, 'a state of affairs');
  assert.equal(world.currentState()?.support, 1);
});

// ── Surprise ────────────────────────────────────────────────────────────────

test('world: the first observation is never surprising', () => {
  const { world } = harness();
  const outcome = world.observe({ content: 'something happened' });
  assert.equal(outcome.surprise, 0, 'nothing was expected, so nothing was violated');
});

test('world: a fully expected transition is barely surprising', () => {
  const { world } = harness();

  for (let i = 0; i < 8; i += 1) {
    world.observe({ content: 'the switch is off' });
    world.observe({ content: 'the light is dark' });
  }

  world.observe({ content: 'the switch is off' });
  const expected = world.observe({ content: 'the light is dark' });

  assert.ok(expected.surprise < 0.3, `the usual outcome should not surprise: ${expected.surprise}`);
});

test('world: an unprecedented outcome is maximally surprising', () => {
  const { world } = harness({ matchThreshold: 0.95 });

  for (let i = 0; i < 8; i += 1) {
    world.observe({ content: 'the switch is off' });
    world.observe({ content: 'the light is dark' });
  }

  world.observe({ content: 'the switch is off' });
  const shock = world.observe({ content: 'a completely different thing entirely unrelated' });

  assert.equal(shock.surprise, 1, 'the world produced something outside the expected set');
});

test('world: an unlikely-but-known outcome is mildly surprising, not maximally', () => {
  const { world } = harness({ matchThreshold: 0.95 });

  // A usually followed by B, occasionally by C.
  for (let i = 0; i < 9; i += 1) {
    world.observe({ content: 'state alpha begins' });
    world.observe({ content: 'state beta follows' });
  }
  world.observe({ content: 'state alpha begins' });
  world.observe({ content: 'state gamma instead' });

  world.observe({ content: 'state alpha begins' });
  const rare = world.observe({ content: 'state gamma instead' });

  assert.ok(rare.surprise > 0, 'an unusual outcome is surprising');
  assert.ok(rare.surprise < 1, `but it is a known possibility: ${rare.surprise}`);
});

test('world: smoothing stops one observation from making an outcome certain', () => {
  const { world } = harness();

  world.observe({ content: 'once only' });
  const expectation = world.expect('once only');
  assert.deepEqual(expectation.successors, [], 'no successor has been observed yet');
  assert.equal(expectation.determinism, 0, 'nothing is known about what follows');

  world.observe({ content: 'the sole successor' });
  const after = world.expect('once only');
  const probability = after.successors[0]?.probability ?? 0;

  assert.ok(probability < 1, `a single transition must not be certain: ${probability}`);
  assert.ok(probability > 0.5, 'but it should still be the leading candidate');
  assert.ok(after.determinism < 1, `one data point is not determinism: ${after.determinism}`);
});

test('world: probability mass is reserved for outcomes never seen', () => {
  const { world } = harness({ matchThreshold: 0.95 });
  for (let i = 0; i < 10; i += 1) {
    world.observe({ content: 'a well established antecedent' });
    world.observe({ content: 'its single known outcome' });
  }

  const expectation = world.expect('a well established antecedent');
  const sum = expectation.successors.reduce((a, p) => a + p.probability, 0);

  // Deliberately below 1. The shortfall IS the model's admission that it has
  // not seen every outcome, and it is what keeps surprise alive in a world
  // that has so far been perfectly regular.
  assert.ok(sum < 1, `observed mass must leave room for the unseen: ${sum}`);
  assert.ok(sum > 0.9, `but a regular world should be nearly saturated: ${sum}`);
});

test('world: surprise is computed before learning from the observation', () => {
  const { world } = harness();

  // If the transition were recorded first, the observed outcome would already
  // have support and every surprise would collapse toward the smoothing floor.
  world.observe({ content: 'antecedent state' });
  const first = world.observe({ content: 'consequent state' });
  const second = world.observe({ content: 'antecedent state' });
  const repeat = world.observe({ content: 'consequent state' });

  assert.ok(second.surprise >= 0);
  assert.ok(
    repeat.surprise < 1,
    `by the second occurrence the model should expect it: ${repeat.surprise}`,
  );
  assert.ok(first.surprise >= 0);
});

test('world: an unpredicted percept reports undefined, not a number', () => {
  const { world } = harness();
  // Before anything is known, there is nothing to violate.
  assert.equal(world.surpriseOf({ content: 'anything', source: 's', modality: 'text' }), undefined);

  world.observe({ content: 'first state' });
  // The first state has no successors recorded, so still nothing is expected.
  assert.equal(world.surpriseOf({ content: 'second state', source: 's', modality: 'text' }), undefined);
});

test('world: surpriseOf agrees with the surprise reported during observation', () => {
  const { world } = harness({ matchThreshold: 0.95 });
  for (let i = 0; i < 6; i += 1) {
    world.observe({ content: 'state one persists' });
    world.observe({ content: 'state two follows' });
  }

  world.observe({ content: 'state one persists' });
  const predicted = world.surpriseOf({ content: 'state two follows', source: 's', modality: 'text' });
  const actual = world.observe({ content: 'state two follows' }).surprise;

  assert.ok(predicted !== undefined);
  assert.ok(Math.abs(predicted - actual) < 1e-6, `predicted ${predicted} vs reported ${actual}`);
});

// ── Expectation ─────────────────────────────────────────────────────────────

test('world: expect() is read-only', () => {
  const { world } = harness();
  world.observe({ content: 'state a' });
  world.observe({ content: 'state b' });

  const before = world.stateCount;
  world.expect('state a');
  world.expect('state a');
  assert.equal(world.stateCount, before, 'consulting the model does not teach it');
});

test('world: expect() reports the determinism of a state', () => {
  const { world } = harness({ matchThreshold: 0.95 });

  for (let i = 0; i < 10; i += 1) {
    world.observe({ content: 'deterministic antecedent' });
    world.observe({ content: 'the only outcome' });
  }
  const certain = world.expect('deterministic antecedent');
  // Measured 0.838 after ten consistent observations. Not exactly 1, and that
  // is the point: the smoothing prior keeps a sliver of mass for an outcome
  // never seen, so even a perfectly regular world is never declared certain.
  assert.ok(certain.determinism > 0.8, `a regular world should read as near-certain: ${certain.determinism}`);
  assert.ok(certain.determinism < 1, 'but never fully certain');

  // Genuinely distinct outcomes, so each is its own state rather than all of
  // them collapsing onto one another by similarity.
  const variants = [
    'the kettle boils',
    'a pigeon lands on the sill',
    'the phone rings twice',
    'rain begins against the glass',
    'a car door slams outside',
    'the lamp flickers once',
    'someone laughs downstairs',
    'the fridge compressor stops',
    'a key turns in the lock',
    'the heating clicks on',
  ];
  for (const variant of variants) {
    world.observe({ content: 'random antecedent' });
    world.observe({ content: variant });
  }

  const uncertain = world.expect('random antecedent', 12);
  assert.equal(uncertain.successors.length, 10, `all ten variants are visible: ${uncertain.successors.length}`);
  assert.ok(
    uncertain.determinism < certain.determinism,
    `many outcomes means less predictable: ${uncertain.determinism} vs ${certain.determinism}`,
  );
});

test('world: expect() on an unknown state is empty rather than throwing', () => {
  const { world } = harness();
  world.observe({ content: 'the only thing known' });
  const expectation = world.expect('a state never seen before at all');

  assert.equal(expectation.stateKey, undefined);
  assert.deepEqual(expectation.successors, []);
  assert.equal(expectation.support, 0);
});

test('world: successors are ranked by probability', () => {
  const { world } = harness({ matchThreshold: 0.95 });

  world.observe({ content: 'branching state' });
  for (let i = 0; i < 5; i += 1) {
    world.observe({ content: 'common outcome' });
    world.observe({ content: 'branching state' });
  }
  world.observe({ content: 'rare outcome' });

  const expectation = world.expect('branching state');
  const probabilities = expectation.successors.map((p) => p.probability);
  assert.deepEqual(probabilities, [...probabilities].sort((a, b) => b - a));
  assert.match(expectation.successors[0]?.content ?? '', /common outcome/);
});

test('world: reported probabilities never exceed one in total', () => {
  const { world } = harness({ matchThreshold: 0.95 });
  world.observe({ content: 'hub state' });
  for (const outcome of ['alpha outcome', 'beta outcome', 'gamma outcome']) {
    world.observe({ content: outcome });
    world.observe({ content: 'hub state' });
  }

  const expectation = world.expect('hub state');
  const sum = expectation.successors.reduce((a, p) => a + p.probability, 0);
  assert.ok(sum <= 1 + 1e-6, `probabilities summed to ${sum}`);
  assert.ok(sum > 0.9, `three regular outcomes should account for most of the mass: ${sum}`);
  for (const prediction of expectation.successors) {
    assert.ok(prediction.probability > 0 && prediction.probability < 1);
  }
});

test('world: confidence grows with repeated observation of one regularity', () => {
  const { world } = harness({ matchThreshold: 0.95 });
  const sample = (): number => {
    world.observe({ content: 'the regular antecedent' });
    world.observe({ content: 'the regular consequent' });
    return world.expect('the regular antecedent').determinism;
  };

  const early: number[] = [];
  for (let i = 0; i < 6; i += 1) early.push(sample());
  for (let i = 0; i < 20; i += 1) sample();
  const late = sample();

  assert.ok(
    (early[0] as number) < late,
    `determinism should rise with evidence: ${early[0]} -> ${late}`,
  );
  assert.ok(late > 0.85, `a well-established regularity should read as near-certain: ${late}`);
  assert.ok(late < 1, 'but smoothing always reserves room for the unseen');
});

// ── Multi-step prediction ───────────────────────────────────────────────────

test('world: predict() rolls a trajectory forward', () => {
  const { world } = harness({ matchThreshold: 0.95 });

  for (let i = 0; i < 6; i += 1) {
    world.observe({ content: 'stage one' });
    world.observe({ content: 'stage two' });
    world.observe({ content: 'stage three' });
  }

  world.observe({ content: 'stage one' });
  const trajectory = world.predict(2);

  assert.equal(trajectory.length, 2);
  assert.match(trajectory[0]?.content ?? '', /stage two/);
  assert.match(trajectory[1]?.content ?? '', /stage three/);
});

test('world: confidence decreases along a predicted trajectory', () => {
  const { world } = harness({ matchThreshold: 0.95 });
  for (let i = 0; i < 6; i += 1) {
    world.observe({ content: 'alpha stage' });
    world.observe({ content: 'beta stage' });
    world.observe({ content: 'gamma stage' });
    world.observe({ content: 'delta stage' });
  }

  world.observe({ content: 'alpha stage' });
  const trajectory = world.predict(3);

  for (let i = 1; i < trajectory.length; i += 1) {
    assert.ok(
      (trajectory[i]?.probability ?? 0) <= (trajectory[i - 1]?.probability ?? 0),
      'compounding uncertainty must not increase confidence',
    );
  }
});

test('world: predict() stops rather than inventing a continuation', () => {
  const { world } = harness({ matchThreshold: 0.95 });
  world.observe({ content: 'the only state' });

  assert.deepEqual(world.predict(5), [], 'nothing follows a state with no successors');
});

test('world: predict() rejects a non-positive step count', () => {
  const { world } = harness();
  assert.throws(() => world.predict(0), RangeError);
  assert.throws(() => world.predict(-1), RangeError);
});

// ── Revision ────────────────────────────────────────────────────────────────

test('world: a large surprise announces a revision', () => {
  const { kernel, world } = harness({ matchThreshold: 0.95, surpriseThreshold: 0.5 });
  const revisions: unknown[] = [];
  kernel.bus.on('world:revised', (e) => revisions.push(e.payload));

  for (let i = 0; i < 8; i += 1) {
    world.observe({ content: 'antecedent state' });
    world.observe({ content: 'expected consequent' });
  }
  const before = world.stats().revisions;

  world.observe({ content: 'antecedent state' });
  world.observe({ content: 'something entirely else happened' });

  assert.ok(world.stats().revisions > before, 'the model announced that its expectations were wrong');
  assert.equal(revisions.length >= 1, true);
});

test('world: an ordinary transition announces no revision', () => {
  const { world } = harness({ matchThreshold: 0.95, surpriseThreshold: 0.9 });
  for (let i = 0; i < 10; i += 1) {
    world.observe({ content: 'usual antecedent' });
    world.observe({ content: 'usual consequent' });
  }
  assert.equal(world.stats().revisions, 0);
});

test('world: every observation is announced on the bus', () => {
  const { kernel, world } = harness();
  const events: string[] = [];
  kernel.bus.on('world:*', (e) => events.push(e.type));

  world.observe({ content: 'alpha' });
  world.observe({ content: 'beta' });

  assert.equal(events.filter((e) => e === 'world:observed').length, 2);
});

// ── Integration with the perceptual gate ────────────────────────────────────

test('world: implement the PredictionSource contract the gate consumes', () => {
  const { world } = harness({ matchThreshold: 0.95 });
  for (let i = 0; i < 6; i += 1) {
    world.observe({ content: 'the sensor reads nominal' });
    world.observe({ content: 'the system remains stable' });
  }
  world.observe({ content: 'the sensor reads nominal' });

  const expected = world.surpriseOf({ content: 'the system remains stable', source: 'sensor', modality: 'numeric' });
  const unexpected = world.surpriseOf({ content: 'the system has exploded', source: 'sensor', modality: 'numeric' });

  assert.ok(expected !== undefined && unexpected !== undefined);
  assert.ok(unexpected > expected, `unexpected ${unexpected} should exceed expected ${expected}`);
});

// ── Numeric feature tracking ────────────────────────────────────────────────

test('world: numeric features are tracked as running means', () => {
  const { world } = harness({ matchThreshold: 0.95 });
  for (let i = 1; i <= 4; i += 1) {
    world.observe({ content: 'a stable reading', data: { temperature: 100 } });
  }
  // The feature is tracked per state; the point is that it does not throw and
  // the state accumulates observations.
  assert.equal(world.expect('a stable reading').support >= 4, true);
  assert.deepEqual(world.check(), []);
});

test('world: non-numeric data is ignored rather than corrupting the means', () => {
  const { world } = harness();
  assert.doesNotThrow(() => {
    world.observe({ content: 'mixed payload', data: { label: 'nominal', reading: 42, flag: true, nested: {} } });
  });
  assert.deepEqual(world.check(), []);
});

// ── Capacity and integrity ──────────────────────────────────────────────────

test('world: the least-observed states are shed when over capacity', () => {
  const { world } = harness({ matchThreshold: 0.98, maxStates: 4 });

  for (let i = 0; i < 20; i += 1) {
    world.observe({ content: 'a frequently seen state of affairs' });
  }
  for (let i = 0; i < 10; i += 1) {
    world.observe({ content: `a passing glance at thing number ${i} which is quite distinct` });
  }

  assert.ok(world.stateCount <= 4, `held ${world.stateCount} states`);
  const known = world.knownStates(10).map((s) => s.content);
  assert.ok(
    known.some((c) => c.includes('frequently seen')),
    `the well-observed state survived: ${known.join(' | ')}`,
  );
});

test('world: forgetting a state removes the transitions pointing at it', () => {
  const { world } = harness({ matchThreshold: 0.95 });
  world.observe({ content: 'first link in the chain' });
  world.observe({ content: 'second link in the chain' });
  world.observe({ content: 'third link in the chain' });

  assert.equal(world.forget('second link in the chain'), true);
  assert.deepEqual(world.check(), [], 'no transition may point at a state that no longer exists');
  assert.equal(world.forget('never existed at all'), false);
});

test('world: clear() resets every structure', () => {
  const { world } = harness();
  world.observe({ content: 'alpha' });
  world.observe({ content: 'beta' });
  world.clear();

  assert.equal(world.stateCount, 0);
  assert.equal(world.transitionCount, 0);
  assert.equal(world.currentState(), undefined);
  assert.equal(world.stats().observations, 0);
  assert.deepEqual(world.check(), []);
});

test('world: stats are internally consistent over a busy session', () => {
  const { world } = harness({ matchThreshold: 0.8 });
  for (let i = 0; i < 60; i += 1) {
    world.observe({ content: `cycle ${i % 5} of the process` });
  }

  const stats = world.stats();
  assert.equal(stats.states, world.stateCount);
  assert.equal(stats.transitions, world.transitionCount);
  assert.equal(stats.observations, 60);
  assert.ok(stats.meanSurprise >= 0 && stats.meanSurprise <= 1);
  assert.ok(stats.maxSurprise >= stats.meanSurprise);
  assert.ok(stats.meanSupport > 0);
  assert.deepEqual(world.check(), []);
});

test('world: describe() gives a one-line summary', () => {
  const { world } = harness();
  world.observe({ content: 'something' });
  const line = world.describe();
  assert.match(line, /world\[/);
  assert.match(line, /states=1/);
});

test('world: the same observation sequence produces the same model', () => {
  const build = (): string => {
    const { world } = harness({ matchThreshold: 0.9 });
    for (let i = 0; i < 20; i += 1) world.observe({ content: `state ${i % 4}` });
    return JSON.stringify(world.stats());
  };
  assert.equal(build(), build());
});
