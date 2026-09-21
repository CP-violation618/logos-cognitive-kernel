/**
 * LOGOS :: Scenarios :: The failing pipeline
 * ---------------------------------------------------------------------------
 * A worked scenario, written to exercise every layer at once.
 *
 * A service keeps failing under load. Over the run, the agent should:
 *
 *   1. perceive the readings, and refuse most of them as unremarkable;
 *   2. habituate to the constant ones, so only the change stands out;
 *   3. be surprised when the failure follows a different cause than usual;
 *   4. consolidate the recurring incidents into a concept;
 *   5. hold beliefs about the cause, and revise them as evidence arrives;
 *   6. pursue a goal, form a plan and take steps against the world;
 *   7. predict what happens next, and score its own predictions;
 *   8. end up measurably calibrated, or measurably overconfident.
 *
 * The scenario is deterministic: same seed, same trajectory. That is the point
 * of building it this way — a demonstration that cannot be reproduced is an
 * anecdote, not evidence.
 */

import { Kernel } from '../kernel/kernel.ts';
import { WorkingMemory } from '../memory/working.ts';
import { EpisodicMemory } from '../memory/episodic.ts';
import { SemanticMemory } from '../memory/semantic.ts';
import { ConsolidationEngine } from '../memory/consolidation.ts';
import { Rememberer } from '../memory/remember.ts';
import { PerceptionGate } from '../perception/gate.ts';
import { WorldModel } from '../reasoning/world-model.ts';
import { BeliefStore } from '../reasoning/beliefs.ts';
import { GoalSystem } from '../planning/goals.ts';
import { Planner } from '../planning/planner.ts';
import { Calibrator } from '../metacognition/calibration.ts';
import { CognitiveAgent, type Environment } from '../cognition/agent.ts';
import type { PlanState } from '../planning/planner.ts';
import type { PerceptInput } from '../perception/gate.ts';

/** A tiny world: a service that fails under load and can be fixed. */
export interface PipelineWorld extends Environment {
  readonly log: string[];
  state: PlanState;
}

export function createPipelineWorld(): PipelineWorld {
  const state: Record<string, unknown> = {
    load: 40,
    cacheWarm: false,
    connectionPoolSize: 5,
    serviceHealthy: true,
    incidentOpen: false,
  };
  const log: string[] = [];

  return {
    log,
    state,
    observe: () => ({ ...state }),
    act: (name: string): { name: string; succeeded: boolean; detail: string } => {
      log.push(name);
      switch (name) {
        case 'warm the cache':
          state['cacheWarm'] = true;
          return { name, succeeded: true, detail: 'the cache is warm' };
        case 'raise the connection pool':
          state['connectionPoolSize'] = 50;
          return { name, succeeded: true, detail: 'the pool is larger' };
        case 'restart the service':
          state['serviceHealthy'] = true;
          state['incidentOpen'] = false;
          return { name, succeeded: true, detail: 'the service restarted' };
        case 'declare an incident':
          state['incidentOpen'] = true;
          return { name, succeeded: true, detail: 'an incident is open' };
        default:
          return { name, succeeded: false, detail: `unknown action: ${name}` };
      }
    },
  };
}

export interface ScenarioResult {
  readonly agent: CognitiveAgent;
  readonly kernel: Kernel;
  readonly world: PipelineWorld;
  readonly episodic: EpisodicMemory;
  readonly semantic: SemanticMemory;
  readonly beliefs: BeliefStore;
  readonly goals: GoalSystem;
  readonly calibrator: Calibrator;
  readonly working: WorkingMemory;
  readonly worldModel: WorldModel;
  readonly gate: PerceptionGate;
  readonly cycles: number;
  readonly calmCycles: number;
  readonly incidentCycles: number;
  readonly repairCycles: number;
}

/** Phase boundaries, so the scenario's shape is data rather than three loops. */
const CALM_CYCLES = 18;
const INCIDENT_CYCLES = 14;
const REPAIR_CYCLES = 12;

/**
 * Run the scenario to completion.
 *
 * Three phases rather than one long stream, because the interesting behaviour
 * is in the TRANSITIONS: a mind that habituated during calm must notice the
 * first incident, and a mind that has learned the incident's shape must
 * recognise the repair. A single undifferentiated stream would test neither.
 */
export async function runPipelineScenario(options: { readonly seed?: number; readonly verbose?: boolean } = {}): Promise<ScenarioResult> {
  const seed = options.seed ?? 0x5eed;
  const verbose = options.verbose ?? false;
  const say = (line: string): void => {
    if (verbose) console.log(line);
  };

  const kernel = new Kernel({
    config: { seed, memory: { consolidationAgeTicks: 6, attentionThreshold: 0.32 } },
  });

  const working = new WorkingMemory({ capacity: 7 });
  const episodic = new EpisodicMemory({ baseHalfLife: 600 });
  const semantic = new SemanticMemory({ baseHalfLife: 6_000 });
  const consolidation = new ConsolidationEngine({
    clock: kernel.clock,
    bus: kernel.bus,
    scheduler: kernel.scheduler,
    config: kernel.config,
    rng: kernel.rng,
    episodic,
    semantic,
    minClusterSize: 3,
  });
  const rememberer = new Rememberer({
    working,
    episodic,
    semantic,
    rng: kernel.rng,
    now: () => kernel.clock.current,
  });
  const worldModel = new WorldModel({
    clock: kernel.clock,
    bus: kernel.bus,
    rng: kernel.rng,
    matchThreshold: 0.7,
    surpriseThreshold: 0.5,
  });
  const gate = new PerceptionGate({
    clock: kernel.clock,
    bus: kernel.bus,
    config: kernel.config,
    rng: kernel.rng,
    working,
    predictor: worldModel,
    threshold: 0.32,
  });
  const beliefs = new BeliefStore({ clock: kernel.clock, bus: kernel.bus });
  const goals = new GoalSystem({ clock: kernel.clock, bus: kernel.bus, maxActive: 2, stallTicks: 40 });
  const planner = new Planner({ clock: kernel.clock, bus: kernel.bus, maxDepth: 6 });
  const calibrator = new Calibrator({ clock: kernel.clock, bus: kernel.bus, minimumSamples: 8 });

  // ── the agent's knowledge of how to fix things ──
  planner.defineAction({
    name: 'warm the cache',
    preconditions: [{ key: 'cacheWarm', absent: true }],
    effects: [{ key: 'cacheWarm', set: true }],
    reliability: 0.9,
  });
  planner.defineAction({
    name: 'raise the connection pool',
    preconditions: [{ key: 'connectionPoolSize', below: 50 }],
    effects: [{ key: 'connectionPoolSize', set: 50 }],
    reliability: 0.85,
  });
  planner.defineAction({
    name: 'restart the service',
    effects: [{ key: 'serviceHealthy', set: true }],
    reliability: 0.95,
  });
  planner.defineMethod({
    name: 'preferred remedy',
    task: 'the service recovers',
    priority: 0.9,
    preconditions: [{ key: 'cacheWarm', absent: true }],
    actions: ['warm the cache', 'raise the connection pool', 'restart the service'],
  });
  planner.defineMethod({
    name: 'fallback remedy',
    task: 'the service recovers',
    priority: 0.3,
    actions: ['restart the service'],
  });

  const world = createPipelineWorld();
  const agent = new CognitiveAgent({
    kernel,
    working,
    episodic,
    semantic,
    consolidation,
    rememberer,
    gate,
    world: worldModel,
    beliefs,
    goals,
    planner,
    calibrator,
    environment: world,
    reflectEvery: 8,
    actAbove: 0.25,
  });

  // ── wire the deeper integration: goals from incidents, beliefs from lies ──
  kernel.bus.on('world:revised', (event) => {
    const observed = String(event.payload['observed'] ?? '');
    if (observed.includes('timeout')) {
      // A violated expectation about timeouts is evidence about the cause.
      beliefs.addEvidence('the timeouts come from cache misses', {
        content: `unexpected failure observed: ${observed.slice(0, 60)}`,
        source: 'world-model',
        strength: 4,
        reliability: 0.8,
      });
    }
  });

  /**
   * Percepts for one cycle, given the phase.
   *
   * Readings repeat over a SMALL fixed set rather than varying every cycle.
   * That is not a simplification for the demo's benefit — it is what a real
   * monitored service looks like, and it is what makes consolidation possible
   * at all: a mind generalises from recurrence, so a stream in which nothing
   * ever recurs has nothing to generalise from, however long it runs.
   */
  const calmPercepts = (i: number): PerceptInput[] => {
    const latencies = [180, 184, 188, 192];
    const loads = [40, 42, 44, 41];
    const latency = latencies[i % latencies.length] as number;
    const load = loads[i % loads.length] as number;
    return [
      { content: 'the service is healthy', source: 'monitor', modality: 'event', intensity: 0.35 },
      { content: 'request latency is nominal', source: 'monitor', modality: 'numeric', intensity: 0.3, data: { latency } },
      { content: `load is ${load} percent`, source: 'monitor', modality: 'numeric', intensity: 0.3, data: { load } },
    ];
  };

  const incidentPercepts = (i: number): PerceptInput[] => {
    const errorRates = [5, 7, 9];
    const errorRate = errorRates[i % errorRates.length] as number;
    return [
      { content: 'the service is healthy', source: 'monitor', modality: 'event', intensity: 0.35 },
      {
        content: 'request latency exceeds the threshold under load',
        source: 'monitor',
        modality: 'numeric',
        intensity: 0.85,
        data: { latency: 900 },
      },
      {
        content: 'the payment gateway timed out under load',
        source: 'logs',
        modality: 'event',
        intensity: 0.9,
        affect: { valence: -0.5, arousal: 0.7 },
        data: { service: 'payments' },
      },
      {
        content: `error rate is ${errorRate} percent`,
        source: 'monitor',
        modality: 'numeric',
        intensity: 0.8,
        data: { errorRate },
      },
    ];
  };

  const repairPercepts = (i: number): PerceptInput[] => {
    const latencies = [300, 240, 180, 120];
    const latency = latencies[i % latencies.length] as number;
    return [
      { content: 'the cache is warm', source: 'monitor', modality: 'event', intensity: 0.5 },
      { content: 'request latency is recovering', source: 'monitor', modality: 'numeric', intensity: 0.6, data: { latency } },
      { content: 'error rate is 1 percent', source: 'monitor', modality: 'numeric', intensity: 0.4, data: { errorRate: 1 } },
    ];
  };

  say(`\n=== LOGOS pipeline scenario (seed 0x${seed.toString(16)}) ===\n`);

  // ── phase 1: calm ──
  say(`-- phase 1: calm (${CALM_CYCLES} cycles) --`);
  for (let i = 0; i < CALM_CYCLES; i += 1) {
    await agent.cycle(calmPercepts(i));
    if ((i + 1) % 6 === 0) say(`  ${agent.describe()}`);
  }

  // ── phase 2: the incident ──
  say(`\n-- phase 2: incident (${INCIDENT_CYCLES} cycles) --`);
  const goal = goals.declare('the service recovers', { utility: 0.95, deadline: (kernel.clock.current + 60) as never });
  goals.activate(goal.id);

  for (let i = 0; i < INCIDENT_CYCLES; i += 1) {
    const report = await agent.cycle(incidentPercepts(i));
    if (i % 4 === 0 || report.surprise > 0.6) {
      say(
        `  tick ${report.tick}: admitted ${report.perceptsAdmitted}/${report.perceptsOffered}, ` +
          `surprise ${report.surprise.toFixed(2)}, recalled ${report.recalled}` +
          (report.action === undefined ? '' : `, acted: ${report.action.name}`),
      );
    }
  }

  // ── phase 3: the repair ──
  say(`\n-- phase 3: repair (${REPAIR_CYCLES} cycles) --`);
  for (let i = 0; i < REPAIR_CYCLES; i += 1) {
    const report = await agent.cycle(repairPercepts(i));
    if (i % 4 === 0) {
      say(
        `  tick ${report.tick}: admitted ${report.perceptsAdmitted}, surprise ${report.surprise.toFixed(2)}` +
          (report.action === undefined ? '' : `, acted: ${report.action.name}`),
      );
    }
  }

  say(`\n=== outcome ===`);
  say(`  ${agent.describe()}`);
  say(`  ${beliefs.describe()}`);
  say(`  ${calibrator.describe('world-model')}`);
  for (const concept of semantic.all().slice(0, 6)) {
    say(`  concept "${concept.label}" grounded in ${concept.grounding} episodes (confidence ${concept.confidence.toFixed(2)})`);
  }
  say(`  actions taken: ${world.log.length === 0 ? '(none)' : world.log.join(', ')}`);
  say(`  goal "${goal.description}" is ${goals.get(goal.id)?.status}`);
  say(`  calibration verdict: ${calibrator.report('world-model').verdict}`);

  return {
    agent,
    kernel,
    world,
    episodic,
    semantic,
    beliefs,
    goals,
    calibrator,
    working,
    worldModel,
    gate,
    cycles: agent.cycles,
    calmCycles: CALM_CYCLES,
    incidentCycles: INCIDENT_CYCLES,
    repairCycles: REPAIR_CYCLES,
  };
}
