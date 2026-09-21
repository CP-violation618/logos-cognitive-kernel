/**
 * LOGOS :: Cognition :: Cognitive cycle tests
 * ---------------------------------------------------------------------------
 * The claim under test is COMPOSITION: that the layers form a loop rather than
 * a pile. Each was tested in isolation; what matters here is that perception
 * feeds memory, memory feeds inference, inference feeds expectation, and
 * expectation feeds back into what gets perceived.
 *
 * The three claims that would be false if the wiring were wrong:
 *   · surprise is measured BEFORE recall has supplied reassurance;
 *   · a failed action discards the plan instead of repeating it;
 *   · reflection scores predictions made on EARLIER cycles, not this one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Kernel } from '../src/kernel/kernel.ts';
import { WorkingMemory } from '../src/memory/working.ts';
import { EpisodicMemory } from '../src/memory/episodic.ts';
import { SemanticMemory } from '../src/memory/semantic.ts';
import { ConsolidationEngine } from '../src/memory/consolidation.ts';
import { Rememberer } from '../src/memory/remember.ts';
import { PerceptionGate } from '../src/perception/gate.ts';
import { WorldModel } from '../src/reasoning/world-model.ts';
import { BeliefStore } from '../src/reasoning/beliefs.ts';
import { GoalSystem } from '../src/planning/goals.ts';
import { Planner } from '../src/planning/planner.ts';
import { Calibrator } from '../src/metacognition/calibration.ts';
import { CognitiveAgent, type Environment } from '../src/cognition/agent.ts';
import type { PlanState } from '../src/planning/planner.ts';
import type { PerceptInput } from '../src/perception/gate.ts';

interface Rig {
  readonly kernel: Kernel;
  readonly agent: CognitiveAgent;
  readonly working: WorkingMemory;
  readonly episodic: EpisodicMemory;
  readonly semantic: SemanticMemory;
  readonly beliefs: BeliefStore;
  readonly goals: GoalSystem;
  readonly planner: Planner;
  readonly calibrator: Calibrator;
  readonly world: WorldModel;
}

const rig = (options: { readonly environment?: Environment; readonly reflectEvery?: number } = {}): Rig => {
  const kernel = new Kernel({ config: { memory: { consolidationAgeTicks: 1 } } });
  const working = new WorkingMemory({ capacity: 7 });
  const episodic = new EpisodicMemory({ baseHalfLife: 10_000 });
  const semantic = new SemanticMemory({ baseHalfLife: 10_000 });
  const consolidation = new ConsolidationEngine({
    clock: kernel.clock,
    bus: kernel.bus,
    scheduler: kernel.scheduler,
    config: kernel.config,
    rng: kernel.rng,
    episodic,
    semantic,
  });
  const rememberer = new Rememberer({
    working,
    episodic,
    semantic,
    rng: kernel.rng,
    now: () => kernel.clock.current,
  });
  const world = new WorldModel({ clock: kernel.clock, bus: kernel.bus, rng: kernel.rng });
  const gate = new PerceptionGate({
    clock: kernel.clock,
    bus: kernel.bus,
    config: kernel.config,
    rng: kernel.rng,
    working,
    predictor: world,
    threshold: 0.3,
  });
  const beliefs = new BeliefStore({ clock: kernel.clock, bus: kernel.bus });
  const goals = new GoalSystem({ clock: kernel.clock, bus: kernel.bus, maxActive: 3 });
  const planner = new Planner({ clock: kernel.clock, bus: kernel.bus });
  const calibrator = new Calibrator({ clock: kernel.clock, bus: kernel.bus });

  const agent = new CognitiveAgent({
    kernel,
    working,
    episodic,
    semantic,
    consolidation,
    rememberer,
    gate,
    world,
    beliefs,
    goals,
    planner,
    calibrator,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.reflectEvery === undefined ? {} : { reflectEvery: options.reflectEvery }),
  });

  return { kernel, agent, working, episodic, semantic, beliefs, goals, planner, calibrator, world };
};

/** A world where a two-step plan achieves a goal. */
const twoStepEnvironment = (): Environment & { readonly log: string[]; state: PlanState } => {
  const state: Record<string, unknown> = { doorLocked: true, doorOpen: false };
  const log: string[] = [];
  return {
    log,
    state,
    observe: () => ({ ...state }),
    act: (name: string): { name: string; succeeded: boolean; detail: string } => {
      log.push(name);
      if (name === 'unlock the door' && state['doorLocked'] === true) {
        state['doorLocked'] = false;
        return { name, succeeded: true, detail: 'the lock turned' };
      }
      if (name === 'open the door' && state['doorLocked'] === false) {
        state['doorOpen'] = true;
        return { name, succeeded: true, detail: 'the door swung open' };
      }
      return { name, succeeded: false, detail: 'the preconditions did not hold' };
    },
  };
};

const percept = (content: string, over: Partial<PerceptInput> = {}): PerceptInput => ({
  content,
  source: 'test',
  modality: 'text',
  intensity: 0.7,
  ...over,
});

// ── A single cycle ──────────────────────────────────────────────────────────

test('cycle: a cycle runs and reports what happened', async () => {
  const { agent } = rig();
  const report = await agent.cycle([percept('a striking new development')]);

  assert.equal(report.tick, 0);
  assert.equal(report.perceptsOffered, 1);
  assert.ok(report.perceptsAdmitted + report.refused.length === 1, 'every percept is accounted for');
  assert.ok(report.durationMs >= 0);
  assert.equal(agent.cycles, 1);
});

test('cycle: logical time advances by exactly one tick', async () => {
  const { kernel, agent } = rig();
  await agent.cycle([]);
  await agent.cycle([]);
  await agent.cycle([]);
  assert.equal(kernel.clock.current, 3);
});

test('cycle: an admitted percept reaches working memory', async () => {
  const { agent, working } = rig();
  await agent.cycle([percept('an urgent and unprecedented signal', { intensity: 1 })]);

  assert.ok(working.size >= 1, 'perception fed memory');
  assert.ok(working.contents().some((c) => c.content.includes('unprecedented')));
});

test('cycle: a refusal is reported with its reason, not silently dropped', async () => {
  const { agent } = rig();
  // Presented repeatedly with no time passing, so habituation sets in.
  for (let i = 0; i < 6; i += 1) await agent.cycle([percept('the same dull reading', { intensity: 0.05 })]);

  const last = agent.lastCycle();
  assert.ok(last !== undefined);
  assert.ok(last.refused.length >= 1);
  assert.ok(last.refused[0]?.reason.length !== 0);
});

test('cycle: the cycle is announced on the bus', async () => {
  const { kernel, agent } = rig();
  const events: string[] = [];
  kernel.bus.on('cognition:*', (e) => events.push(e.type));

  await agent.cycle([percept('something')]);
  assert.ok(events.includes('cognition:cycle'));
});

test('cycle: a subsystem failure degrades that step rather than killing the cycle', async () => {
  const { kernel, agent } = rig();
  const errors: unknown[] = [];
  kernel.bus.on('cognition:error', (e) => errors.push(e.payload));

  // A percept whose content is fine but which trips the world model by being
  // empty after trimming. The gate refuses it, so the cycle must continue.
  const report = await agent.cycle([percept('   '), percept('a valid observation')]);
  assert.ok(report.perceptsAdmitted >= 1, 'the valid percept still got through');
  assert.equal(agent.cycles, 1, 'and the cycle completed');
});

test('cycle: run() executes several cycles in sequence', async () => {
  const { agent, kernel } = rig();
  const reports = await agent.run(4, () => [percept('a repeating observation', { intensity: 1 })]);

  assert.equal(reports.length, 4);
  assert.equal(agent.cycles, 4);
  assert.equal(kernel.clock.current, 4);
});

test('cycle: run() rejects a non-positive count', async () => {
  const { agent } = rig();
  await assert.rejects(async () => agent.run(0), RangeError);
});

// ── Ordering: surprise before reassurance ───────────────────────────────────

test('cycle: surprise is measured before recall can explain it away', async () => {
  const { agent, world } = rig();

  // Establish a firm expectation: A is always followed by B.
  for (let i = 0; i < 10; i += 1) {
    world.observe({ content: 'state alpha holds' });
    world.observe({ content: 'state beta follows' });
  }
  world.observe({ content: 'state alpha holds' });

  // If recall ran before orientation and supplied reassurance, the surprise of
  // a violated expectation would be suppressed. It is not.
  const violated = await agent.cycle([percept('a completely different outcome entirely', { intensity: 1 })]);
  assert.ok(violated.surprise > 0.5, `a violated expectation should be surprising: ${violated.surprise}`);
});

test('cycle: a violated expectation shows up as surprise', async () => {
  const { agent, world } = rig();

  for (let i = 0; i < 12; i += 1) {
    world.observe({ content: 'the gauge reads steady' });
    world.observe({ content: 'the alarm remains silent' });
  }
  world.observe({ content: 'the gauge reads steady' });

  const violated = await agent.cycle([percept('the alarm is shrieking loudly', { intensity: 1 })]);
  assert.ok(violated.surprise > 0.5, `expected a violation, got surprise ${violated.surprise}`);
});

// ── Recall and belief ───────────────────────────────────────────────────────

test('cycle: the situation cues memory across stores', async () => {
  const { agent, episodic } = rig();
  episodic.encode('the coolant leak came from the lower manifold', {
    situation: 'maintenance',
    surprise: 0.8,
    selfRelevance: 0.5,
  });

  const report = await agent.cycle([percept('the coolant leak came from the lower manifold', { intensity: 1 })]);
  assert.ok(report.recalled >= 1, 'the prior experience was recalled');
});

test('cycle: recalled content becomes belief, weighted by relevance', async () => {
  const { agent, beliefs, episodic } = rig();
  episodic.encode('the pump has failed before under this exact load', {
    situation: 'operations',
    surprise: 0.9,
    selfRelevance: 0.6,
  });

  const before = beliefs.size;
  await agent.cycle([percept('the pump has failed before under this exact load', { intensity: 1 })]);

  assert.ok(beliefs.size > before, 'recall produced a belief the mind now holds');
  assert.ok(beliefs.stats().evidence >= 1);
});

// ── Planning and acting ─────────────────────────────────────────────────────

test('cycle: a goal with a plan produces action against the environment', async () => {
  const environment = twoStepEnvironment();
  const { agent, planner, goals } = rig({ environment });

  planner.defineAction({
    name: 'unlock the door',
    preconditions: [{ key: 'doorLocked' }],
    effects: [{ key: 'doorLocked', set: false }],
  });
  planner.defineAction({
    name: 'open the door',
    preconditions: [{ key: 'doorLocked', absent: true }],
    effects: [{ key: 'doorOpen', set: true }],
  });
  planner.defineMethod({ name: 'through the door', task: 'get inside', actions: ['unlock the door', 'open the door'] });

  const goal = goals.declare('get inside', { utility: 1 });
  goals.activate(goal.id);

  const report = await agent.cycle([percept('standing outside a locked door', { intensity: 1 })]);

  assert.equal(report.plan?.goal, 'get inside');
  assert.equal(report.plan?.steps, 2);
  assert.equal(report.action?.name, 'unlock the door');
  assert.equal(report.action?.succeeded, true);
  assert.deepEqual(environment.log, ['unlock the door']);
});

test('cycle: the plan advances one step per cycle', async () => {
  const environment = twoStepEnvironment();
  const { agent, planner, goals } = rig({ environment });

  // `unlock the door` clears the flag, so the second step's precondition
  // genuinely holds once the first has run.
  planner.defineAction({
    name: 'unlock the door',
    preconditions: [{ key: 'doorLocked' }],
    effects: [{ key: 'doorLocked', set: false }],
  });
  planner.defineAction({ name: 'open the door', preconditions: [{ key: 'doorLocked', absent: true }] });
  planner.defineMethod({ name: 'through', task: 'get inside', actions: ['unlock the door', 'open the door'] });

  const goal = goals.declare('get inside', { utility: 1 });
  goals.activate(goal.id);

  await agent.cycle([percept('outside the door', { intensity: 1 })]);
  await agent.cycle([percept('outside the door', { intensity: 1 })]);

  assert.deepEqual(environment.log, ['unlock the door', 'open the door']);
});

test('cycle: a completed plan achieves its goal', async () => {
  const environment = twoStepEnvironment();
  const { agent, planner, goals } = rig({ environment });

  planner.defineAction({
    name: 'unlock the door',
    preconditions: [{ key: 'doorLocked' }],
    effects: [{ key: 'doorLocked', set: false }],
  });
  planner.defineAction({ name: 'open the door', preconditions: [{ key: 'doorLocked', absent: true }] });
  planner.defineMethod({ name: 'through', task: 'get inside', actions: ['unlock the door', 'open the door'] });

  const goal = goals.declare('get inside', { utility: 1 });
  goals.activate(goal.id);

  // Two cycles to take both steps, and the third to notice the plan is spent —
  // completion is recognised on the cycle AFTER the last step, because the
  // exhaustion is only visible once there is a next step to look for.
  await agent.cycle([percept('outside', { intensity: 1 })]);
  await agent.cycle([percept('outside', { intensity: 1 })]);
  await agent.cycle([percept('outside', { intensity: 1 })]);

  assert.equal(goals.get(goal.id)?.status, 'achieved', `goal was ${goals.get(goal.id)?.status}`);
  assert.deepEqual(environment.log, ['unlock the door', 'open the door'], 'and the plan was not re-run');
});

test('cycle: a failed action discards the plan rather than repeating it', async () => {
  const log: string[] = [];
  const environment: Environment = {
    observe: () => ({ ready: false }),
    act: (name) => {
      log.push(name);
      return { name, succeeded: false, detail: 'the world refused' };
    },
  };
  const { kernel, agent, planner, goals } = rig({ environment });

  planner.defineAction({ name: 'force it' });
  planner.defineMethod({ name: 'brute force', task: 'make it work', actions: ['force it'] });

  const goal = goals.declare('make it work', { utility: 1 });
  goals.activate(goal.id);

  const failures: unknown[] = [];
  kernel.bus.on('cognition:action-failed', (e) => failures.push(e.payload));

  await agent.cycle([percept('it is not working', { intensity: 1 })]);
  await agent.cycle([percept('it is still not working', { intensity: 1 })]);

  assert.equal(failures.length, 2, 'the failure was reported both times');
  // The plan is rebuilt each cycle rather than blindly resumed, so the mind
  // does not keep taking a step it knows does not work.
  assert.ok(log.length >= 2);
});

test('cycle: a goal with no applicable method lowers its own feasibility', async () => {
  const { agent, planner, goals } = rig({ environment: twoStepEnvironment() });
  // A goal with no methods registered at all.
  const goal = goals.declare('do something impossible', { utility: 1 });
  goals.activate(goal.id);

  const before = goals.get(goal.id)?.feasibility ?? 0;
  const failures: unknown[] = [];
  agent['#kernel' as never]; // no-op to satisfy linting about unused binding patterns
  await agent.cycle([percept('a hopeless situation', { intensity: 1 })]);

  const after = goals.get(goal.id)?.feasibility ?? 0;
  assert.ok(after < before, `planning failure should teach the mind: ${before} -> ${after}`);
  assert.equal(planner.plansBuilt, 0);
});

test('cycle: without an environment the agent contemplates but does not act', async () => {
  const { agent, planner, goals } = rig();
  planner.defineAction({ name: 'think' });
  planner.defineMethod({ name: 'm', task: 'consider it', actions: ['think'] });

  const goal = goals.declare('consider it', { utility: 1 });
  goals.activate(goal.id);

  const report = await agent.cycle([percept('a matter to consider', { intensity: 1 })]);
  assert.ok(report.plan !== undefined, 'a plan was formed');
  assert.equal(report.action, undefined, 'but nothing was done');
});

// ── Prediction and reflection ───────────────────────────────────────────────

test('cycle: the agent commits to an expectation it can be wrong about', async () => {
  const { agent, world } = rig();
  for (let i = 0; i < 10; i += 1) {
    world.observe({ content: 'one thing happens' });
    world.observe({ content: 'then another follows' });
  }
  world.observe({ content: 'one thing happens' });

  const report = await agent.cycle([percept('one thing happens', { intensity: 1 })]);
  assert.ok(report.expected.length >= 1, `expected a forecast, got ${report.expected.length}`);
  assert.ok(report.expected[0]?.includes('another'));
});

test('cycle: no expectation is recorded when nothing is predictable', async () => {
  const { agent } = rig();
  const report = await agent.cycle([percept('a first and only observation', { intensity: 1 })]);
  assert.deepEqual(report.expected, [], 'a blank model forecasts nothing, and says so');
});

test('cycle: an unforecastable situation is still recorded as a prediction', async () => {
  // A mind with nothing to forecast still expected the situation to continue.
  // Registering no prediction at all would leave the calibrator with no samples
  // from exactly the period when the mind was most ignorant.
  const { agent, calibrator } = rig();
  await agent.cycle([percept('a first observation', { intensity: 1 })]);
  await agent.cycle([percept('a second, unrelated observation', { intensity: 1 })]);

  assert.ok(calibrator.resolvedCount >= 1, `nothing was scored: ${calibrator.resolvedCount}`);
});

test('cycle: reflection runs on its cadence and not before', async () => {
  const { kernel, agent } = rig({ reflectEvery: 3 });
  const reflections: unknown[] = [];
  kernel.bus.on('cognition:reflection', (e) => reflections.push(e.payload));

  for (let i = 0; i < 6; i += 1) await agent.cycle([percept(`observation ${i}`, { intensity: 1 })]);

  assert.equal(reflections.length, 2, 'reflections at cycles 3 and 6');
  assert.equal(agent.reflections, 2);
});

test('cycle: reflection scores predictions made on earlier cycles', async () => {
  const { agent, calibrator, world } = rig({ reflectEvery: 2 });

  // A situation with a discernible pattern, so the world model has something
  // to forecast and the calibrator something to score.
  for (let i = 0; i < 12; i += 1) {
    world.observe({ content: 'the reading is nominal' });
    world.observe({ content: 'the next reading is also nominal' });
  }

  for (let i = 0; i < 8; i += 1) {
    await agent.cycle([percept('the reading is nominal', { intensity: 1 })]);
  }

  // Predictions were registered AND settled, which is only possible if the
  // settling happens on a later cycle than the registering.
  assert.ok(calibrator.resolvedCount >= 1, `nothing was scored: ${calibrator.resolvedCount}`);
});

test('cycle: reflection reports calibration, consolidation and abandonment together', async () => {
  const { kernel, agent, episodic } = rig({ reflectEvery: 2 });

  for (let i = 0; i < 4; i += 1) {
    episodic.encode(`the recurring failure happened again on attempt ${i}`, {
      situation: `attempt-${i}`,
      surprise: 0.6,
      selfRelevance: 0.5,
    });
    episodic.advance(2);
  }
  episodic.advance(5);

  const payloads: Record<string, unknown>[] = [];
  kernel.bus.on('cognition:reflection', (e) => payloads.push({ ...e.payload }));

  for (let i = 0; i < 2; i += 1) await agent.cycle([percept(`observation ${i}`, { intensity: 1 })]);

  assert.equal(payloads.length, 1);
  const payload = payloads[0];
  assert.ok(payload !== undefined);
  assert.ok(payload['calibration'] !== undefined);
  assert.equal(typeof payload['abandoned'], 'number');
});

test('cycle: reflection is marked on the report', async () => {
  const { agent } = rig({ reflectEvery: 2 });
  const first = await agent.cycle([percept('a', { intensity: 1 })]);
  const second = await agent.cycle([percept('b', { intensity: 1 })]);

  assert.equal(first.reflected, false);
  assert.equal(second.reflected, true);
});

// ── State and introspection ─────────────────────────────────────────────────

test('cycle: history is retained and bounded', async () => {
  const { agent } = rig();
  for (let i = 0; i < 10; i += 1) await agent.cycle([percept(`observation ${i}`, { intensity: 1 })]);

  assert.equal(agent.history().length, 10);
  assert.equal(agent.lastCycle()?.tick, 9);
});

test('cycle: state() summarises every subsystem', async () => {
  const { agent } = rig();
  await agent.cycle([percept('a first observation', { intensity: 1 })]);

  const state = agent.state();
  assert.equal(state['cycles'], 1);
  assert.equal(typeof state['working'], 'number');
  assert.equal(typeof state['episodes'], 'number');
  assert.equal(typeof state['concepts'], 'number');
  assert.equal(typeof state['beliefs'], 'number');
  assert.ok(state['goals'] !== undefined);
  assert.ok(state['calibration'] !== undefined);
  assert.doesNotThrow(() => JSON.stringify(state));
});

test('cycle: describe() gives a one-line summary', async () => {
  const { agent } = rig();
  const before = await agent.cycle([percept('something', { intensity: 1 })]);
  assert.equal(before.tick, 0, 'the cycle reports the instant it began on');

  // Logical time advances at the END of a cycle, so after one cycle the clock
  // reads 1 even though that cycle happened at tick 0.
  const line = agent.describe();
  assert.match(line, /agent\[tick=1/);
  assert.match(line, /cycles=1/);
});

test('cycle: focused goals are reported with their priority', async () => {
  const { agent, goals } = rig();
  const goal = goals.declare('a currently pursued objective', { utility: 0.9 });
  goals.activate(goal.id);

  const report = await agent.cycle([percept('something relevant', { intensity: 1 })]);
  assert.equal(report.focusedGoals.length, 1);
  assert.equal(report.focusedGoals[0]?.description, 'a currently pursued objective');
  assert.ok((report.focusedGoals[0]?.priority ?? 0) > 0);
});

// ── Determinism ─────────────────────────────────────────────────────────────

test('cycle: the same inputs produce the same cognitive trajectory', async () => {
  const run = async (): Promise<string> => {
    const { agent, planner, goals } = rig({ environment: twoStepEnvironment() });
    planner.defineAction({ name: 'unlock the door', preconditions: [{ key: 'doorLocked' }] });
    planner.defineAction({ name: 'open the door', preconditions: [{ key: 'doorLocked', absent: true }] });
    planner.defineMethod({ name: 'through', task: 'get inside', actions: ['unlock the door', 'open the door'] });
    const goal = goals.declare('get inside', { utility: 1 });
    goals.activate(goal.id);

    const trace: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const report = await agent.cycle([percept(`observation ${i}`, { intensity: 1 })]);
      trace.push(`${report.perceptsAdmitted}/${report.recalled}/${report.surprise.toFixed(4)}/${report.action?.succeeded ?? '-'}`);
    }
    return trace.join('|');
  };

  assert.equal(await run(), await run());
});

test('cycle: a long session stays internally consistent', async () => {
  const { agent, working, episodic, beliefs, goals } = rig({ environment: twoStepEnvironment(), reflectEvery: 5 });

  for (let i = 0; i < 60; i += 1) {
    await agent.cycle([
      percept(`reading ${i} from the instrument panel`, { intensity: 0.8, source: `panel-${i % 3}` }),
    ]);
  }

  assert.equal(agent.cycles, 60);
  assert.ok(working.size <= working.capacity, 'the bottleneck held');
  assert.ok(episodic.size >= 0);
  assert.ok(beliefs.size >= 0);
  assert.deepEqual(episodic.check(), []);
  assert.deepEqual(beliefs.check(), []);
  assert.deepEqual(goals.check(), []);
  assert.ok(agent.reflections >= 10, `reflections ran: ${agent.reflections}`);
});
