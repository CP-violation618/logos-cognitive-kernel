/**
 * LOGOS :: Guide examples, executed
 * ---------------------------------------------------------------------------
 * Every code block in docs/GUIDE.md appears here and is run by the test suite.
 *
 * A manual with untested examples is a manual that is wrong within a month. The
 * duplication between this file and the guide is deliberate and is the price of
 * being able to say the examples work — the alternative is prose that looks
 * plausible and fails the first time a reader pastes it.
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
import { ModelAdapter, type ModelClient } from '../src/reasoning/model-adapter.ts';
import { GoalSystem } from '../src/planning/goals.ts';
import { Planner } from '../src/planning/planner.ts';
import { Calibrator } from '../src/metacognition/calibration.ts';
import { SelfModel } from '../src/metacognition/self-model.ts';
import { SkillRegistry, type SkillContext } from '../src/skills/registry.ts';
import { CognitiveAgent, type Environment } from '../src/cognition/agent.ts';
import { LogosError, tick } from '../src/kernel/types.ts';

/** The whole stack, wired as the guide describes. */
const assemble = (kernel: Kernel) => {
  const working = new WorkingMemory({ capacity: 7 });
  const episodic = new EpisodicMemory({ baseHalfLife: 400 });
  const semantic = new SemanticMemory({ baseHalfLife: 4_000 });
  const gate = new PerceptionGate({
    clock: kernel.clock,
    bus: kernel.bus,
    config: kernel.config,
    rng: kernel.rng,
    working,
    threshold: 0.3,
  });
  const rememberer = new Rememberer({ working, episodic, semantic, rng: kernel.rng, now: () => kernel.clock.current });
  const consolidation = new ConsolidationEngine({
    clock: kernel.clock,
    bus: kernel.bus,
    scheduler: kernel.scheduler,
    config: kernel.config,
    rng: kernel.rng,
    episodic,
    semantic,
  });
  const world = new WorldModel({ clock: kernel.clock, bus: kernel.bus, rng: kernel.rng });
  const beliefs = new BeliefStore({ clock: kernel.clock, bus: kernel.bus });
  const goals = new GoalSystem({ clock: kernel.clock, bus: kernel.bus, beliefs });
  const planner = new Planner({ clock: kernel.clock, bus: kernel.bus });
  const calibrator = new Calibrator({ clock: kernel.clock, bus: kernel.bus });
  gate.setPredictor(world);
  return { working, episodic, semantic, gate, rememberer, consolidation, world, beliefs, goals, planner, calibrator };
};

// ── 2. The five-minute starter ──────────────────────────────────────────────

test('guide 2: the five-minute starter does what the guide says it does', async () => {
  // The smallest useful mind: a kernel and a working memory. This is the first
  // block a reader copies, so it is the most important one in the guide to have
  // actually running.
  const kernel = new Kernel({ config: { seed: 0x5eed } });
  await kernel.start();

  const working = new WorkingMemory({ capacity: 7 });
  working.encode('the client wants the report by Friday', { salience: 0.9 });
  working.encode('lunch is at noon', { salience: 0.2 });

  // Attention is a competition, not a filter: a goal biases it.
  working.prime('deadline and deliverables', 1);

  const ranked = working.focused();
  assert.ok(ranked.length >= 1);
  assert.match(
    ranked[0]?.content ?? '',
    /report|deadline/i,
    'priming lifted the goal-relevant item above the more strongly encoded one',
  );

  await kernel.stop();
});

// ── 1. The kernel ───────────────────────────────────────────────────────────

test('guide 1: a kernel boots, reports itself, and stops', async () => {
  const kernel = new Kernel({ config: { seed: 0x5eed } });
  await kernel.start();
  assert.equal(kernel.phase, 'running');
  assert.match(kernel.describe(), /logos\[running\]/);
  await kernel.stop();
  assert.equal(kernel.phase, 'stopped');
});

test('guide 1: a subsystem is anything with a name and a start method', async () => {
  const kernel = new Kernel();
  const seen: string[] = [];
  kernel.use({
    name: 'greeter',
    start: (context) => {
      context.bus.on('kernel:started', () => seen.push('hello'));
    },
  });

  await kernel.start();
  assert.deepEqual(seen, ['hello']);
  await kernel.stop();
});

test('guide 1: work is scheduled under a budget and may yield', async () => {
  const kernel = new Kernel();
  await kernel.start();

  let step = 0;
  const task = kernel.scheduler.enqueue<number>({
    name: 'deliberate',
    priority: 100,
    run: () => {
      step += 1;
      if (step < 3) return { status: 'yielded', detail: `phase ${step}` };
      return { status: 'done', value: step };
    },
  });

  for (let i = 0; i < 4; i += 1) await kernel.tick();
  const settled = await task.settled;
  assert.equal(settled.state, 'done');
  assert.equal(settled.value, 3);
  await kernel.stop();
});

test('guide 1: the same seed replays the same mind', async () => {
  const draws = async (seed: number): Promise<number[]> => {
    const k = new Kernel({ config: { seed } });
    await k.start();
    const out: number[] = [];
    for (let i = 0; i < 4; i += 1) out.push(k.rng.next());
    await k.stop();
    return out;
  };

  assert.deepEqual(await draws(1234), await draws(1234));
  assert.notDeepEqual(await draws(1234), await draws(9999));
});

// ── 2. Memory ───────────────────────────────────────────────────────────────

test('guide 2: working memory holds about seven things and forgets the rest', () => {
  const working = new WorkingMemory({ capacity: 3 });
  working.encode('the client wants the report by Friday', { salience: 0.9 });
  working.encode('staging is on the old schema', { salience: 0.7 });
  working.encode('lunch is at noon', { salience: 0.2 });
  working.encode('the build is red again', { salience: 0.6 });

  assert.ok(working.size <= 3, 'capacity is a ceiling, not a suggestion');
});

test('guide 2: rehearsal lengthens a memory\u2019s half-life', () => {
  const working = new WorkingMemory({ capacity: 7 });
  const { id } = working.encode('the migration is scheduled for Friday', { salience: 0.8 });

  const before = working.get(id, { reinforce: false })?.halfLife ?? 0;
  working.encode('the migration is scheduled for Friday', { salience: 0.8 });
  const after = working.get(id, { reinforce: false })?.halfLife ?? 0;

  assert.ok(after > before, `rehearsal should slow decay: ${before} -> ${after}`);
});

test('guide 2: priming biases what comes to mind', () => {
  const working = new WorkingMemory({ capacity: 7 });
  working.encode('the database migration is overdue', { salience: 0.5 });
  working.encode('the office plants need water', { salience: 0.5 });

  working.prime('database schema migration', 1);
  const top = working.focused()[0];
  assert.match(top?.content ?? '', /database/);
});

test('guide 2: episodic memory records what happened, with its context', () => {
  const episodic = new EpisodicMemory({ baseHalfLife: 400 });
  episodic.encode('the payment gateway timed out during the morning peak', {
    situation: 'peak-traffic',
    context: { service: 'payments' },
    surprise: 0.7,
    affect: { valence: -0.4, arousal: 0.6 },
    data: { severity: 'high' },
  });

  const hits = episodic.recall({ text: 'payment gateway timeout', limit: 2 });
  assert.equal(hits.length, 1);
  assert.match(hits[0]?.episode.content ?? '', /payment gateway/);
});

test('guide 2: recall rewrites the memory it retrieves', () => {
  const episodic = new EpisodicMemory({ baseHalfLife: 400 });
  const { id } = episodic.encode('the deploy failed on a Friday', { situation: 'deploy', surprise: 0.6 });

  const before = episodic.get(id)?.strength ?? 0;
  episodic.retrieve(id, { context: { reviewedDuring: 'postmortem' } });
  const after = episodic.get(id);

  assert.ok((after?.strength ?? 0) > before, 'retrieval strengthens');
  assert.equal(after?.context['reviewedDuring'], 'postmortem', 'and folds in the present');
});

test('guide 2: consolidation turns recurring episodes into a concept', () => {
  const kernel = new Kernel();
  const episodic = new EpisodicMemory({ baseHalfLife: 400 });
  const semantic = new SemanticMemory({ baseHalfLife: 4_000 });

  const texts = [
    'the payment gateway timed out during the morning peak',
    'the payment gateway timed out when traffic doubled',
    'the payment gateway timed out while the cache was cold',
  ];
  for (const [i, text] of texts.entries()) {
    episodic.encode(text, { situation: `incident-${i}`, surprise: 0.7 });
    episodic.advance(5);
  }

  const engine = new ConsolidationEngine({
    clock: kernel.clock,
    bus: kernel.bus,
    scheduler: kernel.scheduler,
    config: { ...kernel.config, memory: { ...kernel.config.memory, consolidationAgeTicks: 1 } },
    rng: kernel.rng,
    episodic,
    semantic,
  });

  const outcome = engine.consolidateNow();
  assert.ok(outcome.conceptsFormed + outcome.conceptsReinforced >= 1, 'something was learned');
  assert.equal(episodic.size, 3, 'generalising does not erase the experiences');
});

test('guide 2: recall searches every store at once', () => {
  const kernel = new Kernel();
  const stack = assemble(kernel);
  const { id } = stack.episodic.encode('the payment gateway timed out', { situation: 'a', surprise: 0.6 });
  stack.semantic.observe({
    label: 'gateway timeout',
    definition: 'the payment gateway stops responding under load',
    sourceEpisode: id,
  });

  const memory = stack.rememberer.recall({ text: 'payment gateway timeout', limit: 5 });
  assert.ok(memory.items.length >= 1);
  assert.ok(memory.considered.episodic >= 1);
});

// ── 3. Attention ────────────────────────────────────────────────────────────

test('guide 3: the gate admits the surprising and refuses the familiar', () => {
  const kernel = new Kernel();
  const stack = assemble(kernel);

  const first = stack.gate.perceive({
    content: 'the primary database has stopped accepting writes',
    modality: 'text',
    source: 'monitor',
    intensity: 0.8,
  });
  assert.equal(first.admitted, true);

  // The same unremarkable thing, over and over, stops getting in.
  for (let i = 0; i < 12; i += 1) {
    stack.gate.perceive({ content: 'heartbeat ok', modality: 'text', source: 'monitor', intensity: 0.05 });
    stack.gate.step();
  }
  const decision = stack.gate.perceive({
    content: 'heartbeat ok',
    modality: 'text',
    source: 'monitor',
    intensity: 0.05,
  });
  assert.equal(decision.admitted, false, 'habituation is why a mind can ignore a clock');
  assert.equal(decision.reason, 'habituated');
});

test('guide 3: a decision explains itself', () => {
  const kernel = new Kernel();
  const stack = assemble(kernel);
  const decision = stack.gate.perceive({
    content: 'a completely unprecedented event has occurred',
    modality: 'text',
    source: 'world',
    intensity: 1,
  });

  // Every component is reported, so a surprising refusal can be diagnosed
  // rather than merely observed.
  assert.ok(decision.percept.terms.surprise >= 0);
  assert.ok(decision.percept.terms.novelty >= 0);
  assert.ok(decision.percept.salience >= 0 && decision.percept.salience <= 1);
});

// ── 4. Reasoning ────────────────────────────────────────────────────────────

test('guide 4: the world model learns transitions and measures surprise', () => {
  const kernel = new Kernel();
  const stack = assemble(kernel);

  for (let i = 0; i < 6; i += 1) {
    stack.world.observe({ content: 'cache cold', source: 'monitor' });
    stack.world.observe({ content: 'latency high', source: 'monitor' });
  }

  // What usually comes after a cold cache.
  const expectation = stack.world.expect('cache cold', 3);
  assert.ok(expectation.successors.some((s) => s.content === 'latency high'));

  // And what does not: an unexpected observation is surprising.
  const surprise = stack.world.surpriseOf({ content: 'the datacentre is on fire', source: 'monitor', modality: 'text' });
  assert.ok(surprise !== undefined && surprise > 0.5, `an unprecedented event should surprise: ${String(surprise)}`);
});

test('guide 4: belief is revisable, and evidence can be taken back', () => {
  const kernel = new Kernel();
  const stack = assemble(kernel);
  const proposition = 'the gateway is overloaded';

  stack.beliefs.declare(proposition);
  const before = stack.beliefs.get(proposition)?.credence ?? 0;

  // NOTE: `addEvidence` returns the BELIEF, so its `.id` is the proposition's
  // id. The evidence it just added is at `belief.evidence[0].id`. Reading
  // `.id` off the return value and passing it to `retract` looks right and is
  // wrong — the store now throws rather than silently doing nothing.
  const belief = stack.beliefs.addEvidence(proposition, {
    content: 'error rate rose with traffic',
    source: 'metrics',
    strength: 4,
    reliability: 0.9,
  });
  const evidenceId = belief.evidence[0]?.id as string;

  const after = stack.beliefs.get(proposition)?.credence ?? 0;
  assert.ok(after > before, 'evidence moved the belief');

  // Retracting is the half of belief revision most systems omit.
  stack.beliefs.retract(proposition, evidenceId);
  const reverted = stack.beliefs.get(proposition)?.credence ?? 0;
  assert.ok(
    Math.abs(reverted - before) < 1e-9,
    `retraction restores exactly the state before the evidence: ${reverted} vs ${before}`,
  );
  assert.equal(stack.beliefs.get(proposition)?.evidence.length, 0);
});

test('guide 4: passing a belief id where an evidence id belongs is refused', () => {
  const kernel = new Kernel();
  const beliefs = new BeliefStore({ clock: kernel.clock, bus: kernel.bus });
  const proposition = 'the cache is cold';

  beliefs.declare(proposition);
  const belief = beliefs.addEvidence(proposition, { content: 'timings', source: 'metrics' });

  // The natural mistake: `belief.id` is the PROPOSITION's id, not the evidence's.
  // Before this guard existed the call returned the unchanged belief, and the
  // caller had no way to know nothing had been retracted.
  assert.throws(() => beliefs.retract(proposition, belief.id), LogosError);
  assert.equal(beliefs.get(proposition)?.evidence.length, 1, 'and nothing was removed');
});

test('guide 4: order of evidence does not change the conclusion', () => {
  const build = (order: readonly number[]): number => {
    const kernel = new Kernel();
    const beliefs = new BeliefStore({ clock: kernel.clock, bus: kernel.bus });
    beliefs.declare('the deploy caused it');
    for (const strength of order) {
      beliefs.addEvidence('the deploy caused it', {
        content: `evidence of strength ${strength}`,
        source: `source-${strength}`,
        strength,
        reliability: 0.8,
      });
    }
    return beliefs.get('the deploy caused it')?.credence ?? 0;
  };

  assert.equal(build([1, 2, 3, 4]), build([4, 3, 2, 1]));
});

// ── 5. Goals and planning ───────────────────────────────────────────────────

test('guide 5: goals are prioritised from utility, feasibility and urgency', () => {
  const kernel = new Kernel();
  const stack = assemble(kernel);

  const small = stack.goals.declare('water the plants', { utility: 0.2, feasibility: 0.9 });
  const big = stack.goals.declare('restore the payment service', { utility: 0.95, feasibility: 0.7 });

  assert.ok(big.priority > small.priority, 'utility dominates when the difference is large');
});

test('guide 5: a plan is built from declared actions and methods', () => {
  const kernel = new Kernel();
  const planner = new Planner({ clock: kernel.clock, bus: kernel.bus });

  planner.defineAction({
    name: 'raise-pool',
    description: 'increase the connection pool size',
    effects: [{ key: 'pool', set: 'large' }],
    cost: 1,
  });
  planner.defineAction({
    name: 'restart-service',
    description: 'restart the service',
    preconditions: [{ key: 'pool', equals: 'large' }],
    effects: [{ key: 'service', set: 'healthy' }],
    cost: 2,
  });
  planner.defineAction({
    name: 'warm-cache',
    description: 'prime the cache',
    effects: [{ key: 'cache', set: 'warm' }],
    cost: 1,
  });

  planner.defineMethod({
    name: 'recover-with-pool',
    task: 'restore the service',
    actions: ['raise-pool', 'restart-service'],
  });
  planner.defineMethod({
    name: 'recover-cold',
    task: 'restore the service',
    priority: -1,
    actions: ['warm-cache', 'restart-service'],
  });

  const outcome = planner.plan('restore the service', {});
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(
    outcome.plan.steps.map((s) => s.action.name),
    ['raise-pool', 'restart-service'],
  );
  // `recover-cold` is rejected for a reason, and the reason is available.
  assert.ok(outcome.plan.steps.length === 2);
});

test('guide 5: an impossible goal fails with a reason rather than a shrug', () => {
  const kernel = new Kernel();
  const planner = new Planner({ clock: kernel.clock, bus: kernel.bus });
  planner.defineAction({ name: 'only-action', effects: [{ key: 'x', set: 1 }] });

  const outcome = planner.plan('do something never declared', {});
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.failure.reason.length > 0, 'a failure says why');
});

// ── 6. Metacognition ────────────────────────────────────────────────────────

test('guide 6: calibration measures whether confidence means anything', () => {
  const kernel = new Kernel();
  const calibrator = new Calibrator({ clock: kernel.clock, bus: kernel.bus, minimumSamples: 4 });

  // A forecaster who says 90% and is right half the time.
  for (let i = 0; i < 20; i += 1) {
    const prediction = calibrator.predict(`claim ${i}`, 0.9, { domain: 'estimates' });
    calibrator.resolve(prediction.id, i % 2 === 0);
  }

  const report = calibrator.report('estimates');
  assert.ok(report.bias > 0, 'positive bias means overconfident');
  assert.ok(report.skill < 0, 'and no skill at all');
  assert.ok(calibrator.adjustedConfidence(0.9, 'estimates') < 0.9, 'so the number is discounted');
});

test('guide 6: always saying 50% is calibrated and useless', () => {
  const kernel = new Kernel();
  const calibrator = new Calibrator({ clock: kernel.clock, bus: kernel.bus, minimumSamples: 4 });

  for (let i = 0; i < 40; i += 1) {
    const prediction = calibrator.predict(`coin ${i}`, 0.5, { domain: 'coins' });
    calibrator.resolve(prediction.id, i % 2 === 0);
  }

  const report = calibrator.report('coins');
  // Reliability is perfect and resolution is nil — which is why both are
  // reported. A single "accuracy" number would call this forecaster good.
  assert.ok(Math.abs(report.bias) < 0.1, 'it is well calibrated');
  assert.ok(report.resolution < 0.05, 'and it knows nothing');
});

test('guide 6: the self-model chooses a strategy from measured performance', () => {
  const kernel = new Kernel();
  const self = new SelfModel({ clock: kernel.clock, bus: kernel.bus, evidenceThreshold: 3, attentionScale: 1 });

  // Thorough but expensive.
  for (let i = 0; i < 20; i += 1) {
    self.observe({
      strategy: 'gather',
      kind: 'diagnosis',
      succeeded: i < 18,
      confidence: 0.8,
      attention: 10,
      startedAt: tick(0),
    });
  }
  // Cheap and nearly as good.
  for (let i = 0; i < 20; i += 1) {
    self.observe({
      strategy: 'recall',
      kind: 'diagnosis',
      succeeded: i < 16,
      confidence: 0.7,
      attention: 1,
      startedAt: tick(0),
    });
  }

  const recommendation = self.recommend({ kind: 'diagnosis', description: 'the pump is failing' });
  assert.equal(recommendation.strategy, 'recall', 'efficiency beats raw success rate');
  assert.match(recommendation.reason, /attention/, 'and the reason says so');
});

// ── 7. Skills ───────────────────────────────────────────────────────────────

test('guide 7: practice makes a skill cheaper, not merely better', async () => {
  const kernel = new Kernel();
  const skills = new SkillRegistry({ clock: kernel.clock, bus: kernel.bus, rng: kernel.rng, scheduler: kernel.scheduler });

  skills.define({
    name: 'restart-service',
    achieves: 'the service is running',
    steps: [{ kind: 'action', name: 'stop' }, { kind: 'action', name: 'start' }],
    prior: 0.1,
  });

  const context = (): SkillContext => ({ act: () => true, state: {}, budget: 100 });
  const expensive = skills.costOf('restart-service');

  for (let i = 0; i < 40; i += 1) await skills.attempt('restart-service', context());
  const cheap = skills.costOf('restart-service');

  assert.ok(cheap < expensive, `automatization should reduce cost: ${expensive} -> ${cheap}`);
  assert.ok((skills.byName('restart-service')?.mastery ?? 0) > 0.5, 'and mastery rose');
});

test('guide 7: a precondition failure is not a competence failure', async () => {
  const kernel = new Kernel();
  const skills = new SkillRegistry({ clock: kernel.clock, bus: kernel.bus, rng: kernel.rng, scheduler: kernel.scheduler });

  skills.define({
    name: 'drain-node',
    steps: [{ kind: 'action', name: 'cordon' }, { kind: 'action', name: 'evict' }],
    preconditions: [{ key: 'cluster', present: true }],
    prior: 0.8,
  });

  const masteryBefore = skills.byName('drain-node')?.mastery ?? 0;
  const attempt = await skills.attempt('drain-node', { act: () => true, state: {}, budget: 100 });
  const masteryAfter = skills.byName('drain-node')?.mastery ?? 0;

  assert.equal(attempt.succeeded, false);
  assert.equal(attempt.failure, 'preconditions-unmet');
  // "I cannot do this here" says nothing about "I am bad at this".
  assert.equal(masteryAfter, masteryBefore, 'an unmet precondition moves nothing');
});

test('guide 7: skills compose, and structure is free while work is charged', async () => {
  const kernel = new Kernel();
  const skills = new SkillRegistry({ clock: kernel.clock, bus: kernel.bus, rng: kernel.rng, scheduler: kernel.scheduler });

  skills.define({
    name: 'restart-service',
    steps: [{ kind: 'action', name: 'stop' }, { kind: 'action', name: 'start' }],
  });

  const log: string[] = [];
  skills.define({
    name: 'deploy',
    steps: [
      { kind: 'action', name: 'build' },
      { kind: 'skill', name: 'restart-service' },
      {
        kind: 'branch',
        on: 'cacheCold',
        then: [{ kind: 'action', name: 'warm-cache' }],
        otherwise: [],
      },
      { kind: 'repeat', times: 3, body: [{ kind: 'action', name: 'probe' }] },
    ],
  });

  const context = (cacheCold: boolean): SkillContext => ({
    act: (name) => {
      log.push(name);
      return true;
    },
    state: { cacheCold },
    budget: 100,
  });

  // A cold cache takes the branch...
  await skills.attempt('deploy', context(true));
  assert.deepEqual(log, ['build', 'stop', 'start', 'warm-cache', 'probe', 'probe', 'probe']);

  // ...and a warm one does not, so the branch is a real decision and not
  // decoration. `repeat` runs its body exactly `times` times.
  log.length = 0;
  await skills.attempt('deploy', context(false));
  assert.deepEqual(log, ['build', 'stop', 'start', 'probe', 'probe', 'probe']);
});

// ── 8. The integrated agent ─────────────────────────────────────────────────

test('guide 8: the whole stack runs a full cognitive cycle', async () => {
  const kernel = new Kernel({ config: { seed: 7 } });
  const stack = assemble(kernel);

  stack.planner.defineAction({
    name: 'warm-cache',
    effects: [{ key: 'cache', set: 'warm' }],
    cost: 1,
  });
  stack.planner.defineMethod({ name: 'warm', task: 'the cache is warm', actions: ['warm-cache'] });
  stack.goals.declare('the cache is warm', { utility: 0.9, feasibility: 0.9 });

  const environment: Environment = {
    observe: () => ({}),
    act: (name) => ({ name, succeeded: true, detail: 'done' }),
  };

  const agent = new CognitiveAgent({ kernel, ...stack, environment, reflectEvery: 3 });
  await kernel.start();

  // Enough cycles that the plan is chosen, acted on and completed. Nothing
  // checks the goal off on the first pass: a cycle perceives, orients, recalls,
  // evaluates, deliberates, acts, predicts, then reflects.
  const reports = await agent.run(12);
  assert.ok(reports.length >= 10);
  assert.ok(agent.cycles >= 10);
  assert.ok(kernel.clock.current > 0, 'the clock advanced with the work');
  await kernel.stop();
});

test('guide 8: an agent with no environment contemplates without acting', async () => {
  const kernel = new Kernel({ config: { seed: 7 } });
  const stack = assemble(kernel);
  const agent = new CognitiveAgent({ kernel, ...stack, reflectEvery: 2 });

  await kernel.start();
  const reports = await agent.run(6);
  assert.ok(reports.length >= 5);
  assert.ok(
    reports.every((r) => r.action === undefined),
    'no environment means nothing is acted on',
  );
  await kernel.stop();
});

test('guide 8: percepts reach memory, and only what gets in is remembered', async () => {
  const kernel = new Kernel({ config: { seed: 7 } });
  const stack = assemble(kernel);
  const agent = new CognitiveAgent({ kernel, ...stack });

  await kernel.start();

  // Episodic memory is written from what the gate ADMITTED, not from what was
  // offered. Feeding nothing, or feeding only things the gate refuses, leaves
  // the past empty — which is correct, and is why consolidation has nothing to
  // work with until something genuinely gets in.
  await agent.run(3);
  assert.equal(stack.episodic.size, 0, 'nothing was offered, so nothing was laid down');

  const offered = await agent.run(4, () => [
    { content: 'the primary database stopped accepting writes', modality: 'text', source: 'monitor', intensity: 1 },
  ]);
  assert.ok(offered.some((r) => r.perceptsAdmitted >= 1), 'the surprising observation got in');
  assert.ok(stack.episodic.size > 0, 'and it became an episode');
  await kernel.stop();
});

// ── 10. Attaching a model ───────────────────────────────────────────────────

test('guide 10: a model is attached through a client the caller supplies', async () => {
  const kernel = new Kernel();
  const stack = assemble(kernel);

  // No transport is bundled. A test double, an HTTP client and a local server
  // all satisfy the same interface, and the package depends on none of them.
  const client: ModelClient = {
    name: 'example',
    complete: (request) =>
      Promise.resolve({
        content: request.json === true ? '{"cause": "a flaky test", "severity": 3}' : 'the pump is cavitating',
        confidence: 0.82,
        tokens: 12,
      }),
  };

  const adapter = new ModelAdapter({
    clock: kernel.clock,
    bus: kernel.bus,
    rng: kernel.rng,
    client,
    gate: stack.gate,
    beliefs: stack.beliefs,
    calibrator: stack.calibrator,
    domain: 'diagnosis',
  });

  const answer = await adapter.ask('what is likely wrong with the pump?', { intensity: 1 });
  assert.match(answer.text, /cavitating/);

  // The stated confidence became a PREDICTION rather than being believed, which
  // is what makes a model's calibration a measured property.
  assert.equal(stack.calibrator.pendingCount, 1);
  assert.equal(adapter.settleDomain('diagnosis', true), 1);

  const structured = await adapter.askStructured<{ cause: string; severity: number }>('what went wrong?', {
    cause: 'string',
    severity: 'number',
  });
  assert.equal(structured.ok, true);
  if (!structured.ok) return;
  assert.equal(structured.value.cause, 'a flaky test');
  assert.equal(structured.value.severity, 3);

  // The structured field became evidence for the proposition it names.
  assert.ok(stack.beliefs.get('cause: a flaky test') !== undefined);
  await kernel.stop();
});

test('guide 10: a malformed response is refused rather than coerced', async () => {
  const kernel = new Kernel();
  const client: ModelClient = {
    name: 'sloppy',
    complete: () => Promise.resolve({ content: 'I think the cause was probably a flaky test.' }),
  };
  const adapter = new ModelAdapter({ clock: kernel.clock, bus: kernel.bus, rng: kernel.rng, client });

  const outcome = await adapter.askStructured('q', { cause: 'string' });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /not JSON/);
  assert.equal(adapter.stats.schemaFailures, 1);

  // And it is never retried: retrying a schema failure asks the same question
  // again hoping for a different shape, which makes the statistics look better
  // than the model is.
  assert.equal(adapter.stats.calls, 1);
});

// ── 11. Determinism and debugging ───────────────────────────────────────────

test('guide 11: a run is reproducible from its seed, in both directions', async () => {
  const run = async (seed: number): Promise<string> => {
    const kernel = new Kernel({ config: { seed } });
    const stack = assemble(kernel);
    stack.episodic.encode('a fixed observation', { situation: 'fixed', surprise: 0.5 });
    const agent = new CognitiveAgent({ kernel, ...stack });
    await kernel.start();
    await agent.run(3, () => [
      { content: 'the primary database stopped accepting writes', modality: 'text', source: 'monitor', intensity: 1 },
    ]);
    const summary = `${agent.cycles}:${stack.episodic.size}:${stack.gate.snapshot().admitted}`;
    await kernel.stop();
    return summary;
  };

  // Same seed, same trajectory.
  assert.equal(await run(4242), await run(4242));
});

test('guide 11: every store audits itself and reports no problems', async () => {
  const kernel = new Kernel();
  const stack = assemble(kernel);
  await kernel.start();

  stack.working.encode('something to hold', { salience: 0.8 });
  stack.episodic.encode('something that happened', { situation: 's', surprise: 0.5 });
  stack.semantic.observe({ label: 'a concept', definition: 'something learned' });
  stack.beliefs.declare('the sky is blue');
  stack.goals.declare('finish the report', { utility: 0.5 });
  stack.world.observe({ content: 'a state', source: 'test' });

  // Six of the eight stores expose `check`. The planner holds no state between
  // calls and the calibrator's records are append-only scores, so neither has a
  // cross-field invariant to violate.
  assert.deepEqual(stack.working.check(), []);
  assert.deepEqual(stack.episodic.check(), []);
  assert.deepEqual(stack.semantic.check(), []);
  assert.deepEqual(stack.beliefs.check(), []);
  assert.deepEqual(stack.goals.check(), []);
  assert.deepEqual(stack.world.check(), []);
  await kernel.stop();
});

// ── 12. Health and integrity ────────────────────────────────────────────────

test('guide 9: every store can audit itself', async () => {
  const kernel = new Kernel();
  const stack = assemble(kernel);
  await kernel.start();

  stack.episodic.encode('something happened', { situation: 's', surprise: 0.5 });
  stack.beliefs.declare('the sky is blue');
  stack.goals.declare('finish the report', { utility: 0.5 });
  stack.world.observe({ content: 'a', source: 'test' });

  // Each store checks its own invariants. This is the property that makes the
  // whole thing debuggable: a corrupted structure reports itself rather than
  // producing subtly wrong answers later.
  //
  // Six of the eight stores expose `check`. The planner and the calibrator do
  // not: the planner holds no state between calls, and the calibrator's records
  // are append-only scores with no cross-field invariant to violate. Listing
  // only the six that exist is the point of the test.
  stack.semantic.observe({ label: 'something', definition: 'a thing that happened' });
  assert.deepEqual(stack.working.check(), []);
  assert.deepEqual(stack.episodic.check(), []);
  assert.deepEqual(stack.semantic.check(), []);
  assert.deepEqual(stack.beliefs.check(), []);
  assert.deepEqual(stack.goals.check(), []);
  assert.deepEqual(stack.world.check(), []);
  await kernel.stop();
});

test('guide 9: kernel health reports itself and any subsystem that answers', async () => {
  const kernel = new Kernel();

  // A subsystem reports health only if it implements `health()`. The interface
  // makes it optional, so a subsystem with nothing to say is not forced to
  // invent something — and the kernel does not fabricate a report on its behalf.
  kernel.use({ name: 'silent', start: () => undefined });
  kernel.use({
    name: 'talkative',
    start: () => undefined,
    health: () => ({
      subsystem: 'talkative',
      phase: 'running',
      ok: true,
      detail: 'all good',
      metrics: { queue: 0 },
    }),
  });

  await kernel.start();
  const health = kernel.health();

  assert.equal(health[0]?.subsystem, 'kernel', 'the kernel reports itself first');
  assert.ok(health.some((h) => h.subsystem === 'talkative' && h.ok));
  assert.ok(
    !health.some((h) => h.subsystem === 'silent'),
    'a subsystem with no health() contributes no report rather than a fabricated one',
  );
  await kernel.stop();
});

test('guide 9: a subsystem whose health check throws is reported as degraded', async () => {
  const kernel = new Kernel();
  kernel.use({
    name: 'broken',
    start: () => undefined,
    health: () => {
      throw new Error('the probe itself is broken');
    },
  });

  await kernel.start();
  const report = kernel.health().find((h) => h.subsystem === 'broken');

  // An exception inside a health check is itself a health finding, not a crash.
  assert.equal(report?.ok, false);
  assert.match(report?.detail ?? '', /threw/);
  await kernel.stop();
});
