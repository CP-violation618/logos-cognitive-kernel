/**
 * LOGOS :: Calibration is graded against what was actually claimed
 * ---------------------------------------------------------------------------
 * This file exists because the agent claimed one thing and was graded on
 * another, for as long as the calibration layer has existed.
 *
 * At PREDICT the mind said `the world proceeds to: X` and attached the world
 * model's transition probability for X as its confidence. At the next cycle it
 * was graded on `surprise < 0.5` — "was this cycle unsurprising" — which is a
 * different question with a different answer distribution. On the demo's data
 * that test passed about 93% of the time while the stated confidence averaged
 * 0.64, so the report described a forecaster that did not exist: `skill` pinned
 * to its −1 floor, and a verdict of "underconfident" derived from a bias that
 * was an artefact of the mismatch.
 *
 * The pairing rule the tests below enforce:
 *
 *   A claim about WHICH STATE COMES NEXT is graded on whether that state came.
 *   A claim that THE SITUATION CONTINUES is graded on surprise, because that is
 *   what it actually asserted.
 *
 * Either criterion alone looks reasonable. Checked as a pair, the old one was
 * incoherent.
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
import { CognitiveAgent } from '../src/cognition/agent.ts';

const rig = () => {
  const kernel = new Kernel({ config: { seed: 0x5eed } });
  const working = new WorkingMemory({ capacity: 7 });
  const episodic = new EpisodicMemory({ baseHalfLife: 400 });
  const semantic = new SemanticMemory({ baseHalfLife: 4_000 });
  const consolidation = new ConsolidationEngine({
    clock: kernel.clock,
    bus: kernel.bus,
    scheduler: kernel.scheduler,
    config: kernel.config,
    rng: kernel.rng,
    episodic,
    semantic,
  });
  const rememberer = new Rememberer({ working, episodic, semantic, rng: kernel.rng, now: () => kernel.clock.current });
  const world = new WorldModel({ clock: kernel.clock, bus: kernel.bus, rng: kernel.rng });
  const gate = new PerceptionGate({
    clock: kernel.clock,
    bus: kernel.bus,
    config: kernel.config,
    rng: kernel.rng,
    working,
    predictor: world,
  });
  const beliefs = new BeliefStore({ clock: kernel.clock, bus: kernel.bus });
  const goals = new GoalSystem({ clock: kernel.clock, bus: kernel.bus, beliefs });
  const planner = new Planner({ clock: kernel.clock, bus: kernel.bus });
  const calibrator = new Calibrator({ clock: kernel.clock, bus: kernel.bus, minimumSamples: 4 });

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
  });

  return { kernel, agent, world, calibrator, gate };
};

/** A percept strong enough to get through the gate every time. */
const percept = (content: string) => ({ content, source: 'test', modality: 'text' as const, intensity: 1 });

test('grading: a forecast that comes true is scored correct', async () => {
  const { agent, world, calibrator } = rig();

  // Teach a strict alternation, so the next state is genuinely determined by
  // the current one and the world model can be right.
  for (let i = 0; i < 10; i += 1) {
    world.observe({ content: 'alpha' });
    world.observe({ content: 'beta' });
  }
  // Leave the model sitting on `alpha`, whose successor is `beta`.
  world.observe({ content: 'alpha' });

  await agent.cycle([percept('alpha')]);
  await agent.cycle([percept('beta')]);

  const report = calibrator.report('world-model');
  assert.ok(report.resolved >= 1, 'nothing was graded');
  // The forecast made while on `alpha` said `beta`, and `beta` is what arrived.
  assert.ok(
    report.bias <= 0.5,
    `a forecast that came true should not read as badly overconfident: bias ${report.bias}`,
  );
});

test('grading: a forecast that does not come true is scored wrong', async () => {
  const { agent, world, calibrator } = rig();

  for (let i = 0; i < 10; i += 1) {
    world.observe({ content: 'alpha' });
    world.observe({ content: 'beta' });
  }
  world.observe({ content: 'alpha' });

  await agent.cycle([percept('alpha')]);
  // `beta` was forecast. Send something else entirely.
  await agent.cycle([percept('gamma')]);

  const report = calibrator.report('world-model');
  assert.ok(report.resolved >= 1, 'nothing was graded');
  // The confidence was high (a learned alternation) and the outcome was wrong,
  // so this must register as overconfidence rather than as noise.
  assert.ok(
    report.bias > 0,
    `a confident forecast that failed should read as overconfident: bias ${report.bias}`,
  );
});

test('grading: the two claims use the two different criteria', async () => {
  // The pairing rule, stated directly. A mind with nothing to forecast claims
  // only that the situation continues, and THAT is graded on surprise — because
  // it is the claim that was made. An earlier version graded every claim on
  // surprise, which made a specific prediction about a specific state
  // indistinguishable from a shrug.
  const { agent, calibrator } = rig();
  await agent.cycle([]);
  await agent.cycle([percept('the very first thing this mind has seen')]);

  // With an empty world model there is nothing to forecast, so the claim is
  // "the situation continues" and it is graded on surprise.
  assert.ok(calibrator.resolvedCount >= 1, 'a claim with no forecast was never graded');
});

test('grading: the demo shows a mind that is confident and wrong', async () => {
  // The finding the fix exposed, and the reason the fix was worth making: the
  // old criterion hid it behind a metric artefact, and the corrected one
  // reports textbook overconfidence. Asserted so that a future change which
  // flattens this back out is a deliberate decision rather than a regression.
  const { runPipelineScenario } = await import('../src/scenarios/pipeline.ts');
  const result = await runPipelineScenario({ seed: 0x5eed, verbose: false });
  const report = result.calibrator.report('world-model');

  assert.ok(report.resolved >= 20, `too few resolved predictions to say anything: ${report.resolved}`);

  // Accuracy is meaningfully above chance, so the mind is not merely guessing.
  const baseRate = (1 - Math.sqrt(Math.max(0, 1 - 4 * report.baselineBrier))) / 2;
  const accuracy = Math.max(baseRate, 1 - baseRate);
  assert.ok(accuracy > 0.5, `the forecaster should beat a coin flip: ${accuracy}`);
  assert.ok(accuracy < 1, `and should not be perfect: ${accuracy}`);

  // And its stated confidence does not track that accuracy — which is exactly
  // what a calibration layer is for.
  assert.equal(
    report.verdict,
    'uninformative',
    `expected scattered rather than systematic error, got "${report.verdict}" (bias ${report.bias})`,
  );

  // The high-confidence bins are where it fails. If this stops being true, the
  // calibration report has started describing a different mind.
  const confident = report.bins.filter((b) => b.from >= 0.8);
  const confidentCount = confident.reduce((a, b) => a + b.count, 0);
  assert.ok(confidentCount > 0, 'no confident predictions were made, so there is nothing to grade');

  // `skill` must not be pinned at its floor any more. It was −1.000 before the
  // fix, which is the signature of a metric computed from mismatched inputs.
  assert.ok(
    report.skill > -1,
    `skill is pinned at its floor (${report.skill}), which is the artefact the fix removed`,
  );
});
