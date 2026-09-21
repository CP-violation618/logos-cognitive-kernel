#!/usr/bin/env node
/**
 * LOGOS :: Command line interface
 * ---------------------------------------------------------------------------
 * A thin shell over the kernel. It exists so the architecture can be driven
 * and inspected without writing code, which is what makes it a usable research
 * tool rather than a library that only its author can operate.
 *
 * Commands:
 *
 *   logos demo [--seed N] [--quiet]   run the worked scenario end to end
 *   logos repl                        drive a live agent interactively
 *   logos inspect [--seed N]          dump the kernel's assembled state
 *   logos bench [--cycles N]          measure how fast a cycle is
 *   logos help                        this text
 *
 * Implemented with `node:util` parseArgs and no dependencies, in keeping with
 * the rest of the project. It runs directly from TypeScript source because
 * Node 22.6+ strips types natively.
 */

import { parseArgs } from 'node:util';
import { Kernel, availablePresets, preset } from '../src/kernel/index.ts';
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
import { runPipelineScenario } from '../src/scenarios/pipeline.ts';
import { VERSION, LAYERS } from '../src/index.ts';

const HELP = `
LOGOS v${VERSION} — a cognitive kernel for AGI research

Usage: logos <command> [options]

Commands:
  demo              Run the worked scenario end to end
  repl              Drive a live agent interactively
  inspect           Dump the assembled architecture
  bench             Measure cycle throughput
  help              Show this text

Options:
  --seed <n>        Deterministic seed (decimal or 0x-prefixed)
  --cycles <n>      Cycle count for bench
  --quiet           Suppress the scenario's narration
  --preset <name>   Configuration preset: ${availablePresets().join(', ')}
  --json            Emit machine-readable output

Examples:
  logos demo --seed 1234
  logos bench --cycles 500
  logos inspect --json

Runs on Node 22.6+ with no dependencies.
`;

/** Parse a seed that may be decimal or hexadecimal. */
function parseSeed(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  const value = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? Number.parseInt(trimmed.slice(2), 16) : Number(trimmed);
  if (!Number.isFinite(value)) {
    process.stderr.write(`warning: could not parse seed "${raw}", using ${fallback}\n`);
    return fallback;
  }
  return Math.floor(value);
}

/** A world that simply accumulates whatever the agent does to it. */
function inertEnvironment(): Environment & { readonly actions: string[] } {
  const state: Record<string, unknown> = { idle: true };
  const actions: string[] = [];
  return {
    actions,
    observe: () => ({ ...state }),
    act: (name) => {
      actions.push(name);
      state[name.replace(/\s+/g, '_')] = true;
      return { name, succeeded: true, detail: 'done' };
    },
  };
}

interface Assembly {
  readonly kernel: Kernel;
  readonly working: WorkingMemory;
  readonly episodic: EpisodicMemory;
  readonly semantic: SemanticMemory;
  readonly consolidation: ConsolidationEngine;
  readonly rememberer: Rememberer;
  readonly gate: PerceptionGate;
  readonly world: WorldModel;
  readonly beliefs: BeliefStore;
  readonly goals: GoalSystem;
  readonly planner: Planner;
  readonly calibrator: Calibrator;
  readonly agent: CognitiveAgent;
}

/** Assemble a complete agent from a preset. */
function assemble(seed: number, presetName: string, environment?: Environment): Assembly {
  const config = preset(presetName as never, { seed });
  const kernel = new Kernel({ config });

  const working = new WorkingMemory({ capacity: config.memory.workingSlots });
  const episodic = new EpisodicMemory({ baseHalfLife: config.memory.forgettingHalfLifeTicks });
  const semantic = new SemanticMemory({ baseHalfLife: config.memory.forgettingHalfLifeTicks * 8 });
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
  const goals = new GoalSystem({
    clock: kernel.clock,
    bus: kernel.bus,
    maxActive: config.goals.maxActive,
    stallTicks: config.goals.stallTicks,
  });
  const planner = new Planner({ clock: kernel.clock, bus: kernel.bus, maxDepth: config.cognition.maxPlanDepth });
  const calibrator = new Calibrator({ clock: kernel.clock, bus: kernel.bus, minimumSamples: 4 });

  // A default competence, so the agent can do something out of the box rather
  // than reporting that it has no methods for anything.
  planner.defineAction({ name: 'observe the situation', reliability: 0.95 });
  planner.defineAction({ name: 'write down what was learned', reliability: 0.9 });
  planner.defineMethod({
    name: 'default enquiry',
    task: 'understand what is happening',
    priority: 0.5,
    actions: ['observe the situation', 'write down what was learned'],
  });

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
    ...(environment === undefined ? {} : { environment }),
  });

  return { kernel, working, episodic, semantic, consolidation, rememberer, gate, world, beliefs, goals, planner, calibrator, agent };
}

// ── commands ────────────────────────────────────────────────────────────────

async function commandDemo(seed: number, quiet: boolean): Promise<number> {
  const result = await runPipelineScenario({ seed, verbose: !quiet });

  const report = result.calibrator.report('world-model');
  process.stdout.write(
    `\nsummary: ${result.cycles} cycles, ${result.episodic.size} episodes, ` +
      `${result.semantic.size} concepts, ${result.beliefs.size} beliefs, ` +
      `${result.world.log.length} actions\n` +
      `         calibration ${report.verdict} (brier ${report.brier.toFixed(3)}, ` +
      `bias ${report.bias >= 0 ? '+' : ''}${report.bias.toFixed(3)})\n`,
  );
  return 0;
}

async function commandInspect(seed: number, json: boolean): Promise<number> {
  const assembly = assemble(seed, 'default');
  await assembly.kernel.start();

  const state = {
    version: VERSION,
    seed,
    layers: LAYERS,
    tick: assembly.kernel.clock.current,
    subsystems: {
      working: assembly.working.snapshot(),
      episodic: assembly.episodic.stats(),
      semantic: assembly.semantic.stats(),
      worldModel: assembly.world.stats(),
      beliefs: assembly.beliefs.stats(),
      goals: assembly.goals.stats(),
      calibration: assembly.calibrator.report(),
    },
    health: assembly.kernel.health(),
    scheduler: assembly.kernel.scheduler.snapshot(),
  };

  await assembly.kernel.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`LOGOS v${VERSION} — assembled state (seed ${seed})\n\n`);
  process.stdout.write(`layers:\n`);
  for (const layer of LAYERS) {
    process.stdout.write(`  ${layer.level}  ${layer.name.padEnd(14)} ${layer.purpose}\n`);
  }
  process.stdout.write(`\nsubsystems:\n`);
  process.stdout.write(`  working memory   ${state.subsystems.working.slots.length}/${state.subsystems.working.capacity} slots\n`);
  process.stdout.write(`  episodic         ${state.subsystems.episodic.count} episodes\n`);
  process.stdout.write(`  semantic         ${state.subsystems.semantic.concepts} concepts, ${state.subsystems.semantic.edges} edges\n`);
  process.stdout.write(`  world model      ${state.subsystems.worldModel.states} states, ${state.subsystems.worldModel.transitions} transitions\n`);
  process.stdout.write(`  beliefs          ${state.subsystems.beliefs.beliefs} held, ${state.subsystems.beliefs.evidence} evidence\n`);
  process.stdout.write(`  goals            ${state.subsystems.goals.total} declared\n`);
  process.stdout.write(`  calibration      ${state.subsystems.calibration.verdict}\n`);
  process.stdout.write(`\nhealth:\n`);
  for (const report of state.health) {
    process.stdout.write(`  ${report.ok ? 'ok  ' : 'BAD '} ${report.subsystem.padEnd(12)} ${report.detail}\n`);
  }
  return 0;
}

async function commandBench(cycles: number, seed: number): Promise<number> {
  const environment = inertEnvironment();
  const assembly = assemble(seed, 'research', environment);
  await assembly.kernel.start();

  const goal = assembly.goals.declare('understand what is happening', { utility: 0.9 });
  assembly.goals.activate(goal.id);

  const started = process.hrtime.bigint();
  for (let i = 0; i < cycles; i += 1) {
    await assembly.agent.cycle([
      {
        content: `reading ${i} reports value ${i % 17}`,
        source: 'benchmark',
        modality: 'numeric',
        intensity: 0.6,
        data: { value: i % 17 },
      },
    ]);
  }
  const elapsedNs = Number(process.hrtime.bigint() - started);
  const elapsedMs = elapsedNs / 1e6;

  const report = assembly.agent.lastCycle();
  await assembly.kernel.stop();

  process.stdout.write(`benchmark: ${cycles} cycles in ${elapsedMs.toFixed(1)} ms\n`);
  process.stdout.write(`  per cycle      ${(elapsedMs / cycles).toFixed(4)} ms\n`);
  process.stdout.write(`  throughput     ${((cycles / elapsedMs) * 1000).toFixed(0)} cycles/second\n`);
  process.stdout.write(`  final state    ${assembly.agent.describe()}\n`);
  process.stdout.write(`  last cycle     ${report === undefined ? 'n/a' : `${report.perceptsAdmitted} admitted, ${report.recalled} recalled`}\n`);
  process.stdout.write(`  actions taken  ${environment.actions.length}\n`);
  return 0;
}

async function commandRepl(seed: number): Promise<number> {
  const readline = await import('node:readline');
  const environment = inertEnvironment();
  const assembly = assemble(seed, 'default', environment);
  await assembly.kernel.start();

  const goal = assembly.goals.declare('understand what is happening', { utility: 0.8 });
  assembly.goals.activate(goal.id);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'logos> ' });

  process.stdout.write(`LOGOS v${VERSION} — interactive session (seed ${seed})\n`);
  process.stdout.write(`Type observations to feed the agent. Commands: :state  :beliefs  :goals  :memory  :quit\n\n`);
  rl.prompt();

  const handle = async (line: string): Promise<void> => {
    const text = line.trim();
    if (text.length === 0) return;

    if (text === ':quit' || text === ':q') {
      await assembly.kernel.stop();
      rl.close();
      return;
    }
    if (text === ':state') {
      process.stdout.write(`${assembly.agent.describe()}\n`);
      process.stdout.write(`${JSON.stringify(assembly.agent.state(), null, 2)}\n`);
      return;
    }
    if (text === ':beliefs') {
      const held = assembly.beliefs.all().slice(0, 10);
      process.stdout.write(held.length === 0 ? '  (no beliefs)\n' : '');
      for (const belief of held) {
        process.stdout.write(`  ${belief.credence.toFixed(3)}  ${belief.proposition.slice(0, 70)}\n`);
      }
      return;
    }
    if (text === ':goals') {
      const all = assembly.goals.all();
      process.stdout.write(all.length === 0 ? '  (no goals)\n' : '');
      for (const g of all) {
        process.stdout.write(`  [${g.status.padEnd(9)}] p=${g.priority.toFixed(2)} ${g.description.slice(0, 60)}\n`);
      }
      return;
    }
    if (text === ':memory') {
      for (const item of assembly.working.contents()) {
        process.stdout.write(`  ${item.activation.toFixed(3)}  ${item.content.slice(0, 66)}\n`);
      }
      process.stdout.write(`  -- ${assembly.episodic.size} episodes, ${assembly.semantic.size} concepts\n`);
      return;
    }

    const report = await assembly.agent.cycle([
      { content: text, source: 'user', modality: 'text', intensity: 0.8 },
    ]);
    process.stdout.write(
      `  admitted ${report.perceptsAdmitted}/${report.perceptsOffered}` +
        `, surprise ${report.surprise.toFixed(2)}` +
        `, recalled ${report.recalled}` +
        (report.action === undefined ? '' : `, acted: ${report.action.name}`) +
        '\n',
    );
  };

  rl.on('line', (line) => {
    void handle(line).then(() => {
      rl.prompt();
    });
  });

  return new Promise<number>((resolve) => {
    rl.on('close', () => resolve(0));
  });
}

// ── entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      seed: { type: 'string' },
      cycles: { type: 'string' },
      preset: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  const command = positionals[0] ?? 'help';
  const seed = parseSeed(values.seed, 0x5eed);

  if (values.help === true || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  switch (command) {
    case 'demo':
      return commandDemo(seed, values.quiet === true);
    case 'inspect':
      return commandInspect(seed, values.json === true);
    case 'bench': {
      const cycles = Number(values.cycles ?? 200);
      if (!Number.isFinite(cycles) || cycles < 1) {
        process.stderr.write(`error: --cycles must be a positive number, got ${String(values.cycles)}\n`);
        return 2;
      }
      return commandBench(Math.floor(cycles), seed);
    }
    case 'repl':
      return commandRepl(seed);
    default:
      process.stderr.write(`error: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

const exitCode = await main();
process.exitCode = exitCode;
