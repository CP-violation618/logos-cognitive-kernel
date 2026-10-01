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
 * Node 22.18+ strips types natively.
 */

import { parseArgs } from 'node:util';
import { Kernel, availablePresets, preset, type PresetName } from '../src/kernel/index.ts';
import { Dashboard, readLine, terminalControl, type DashboardParts } from './tui.ts';
import { SkillRegistry, type SkillStep } from './skills/index.ts';
import type { CycleReport } from './cognition/index.ts';
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
  tui               Live dashboard, with an input line (needs a terminal)
  repl              Line-based interactive session
  inspect           Dump the assembled architecture
  bench             Measure cycle throughput
  help              Show this text

Options:
  --seed <n>        Deterministic seed (decimal or 0x-prefixed). Affects every command.
  --preset <name>   Configuration preset: ${availablePresets().join(', ')}
                    Applies to demo, repl and inspect. An unknown name is an error.
  --cycles <n>      Cycle count. Bench only — the demo's phases have fixed lengths.
  --quiet           Suppress the scenario's narration (demo)
  --json            Emit machine-readable output (inspect)

Examples:
  logos tui
  logos demo --seed 1234
  logos demo --preset research
  logos bench --cycles 500
  logos inspect --json

Runs on Node 22.18+ with no dependencies.
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

/**
 * The competences a freshly assembled agent starts with.
 *
 * Each name matches a planner action defined below, which is what lets a plan
 * step be performed as a practised PROCEDURE rather than as a bare call. The
 * steps are declared as real actions so that the skill layer's cost accounting
 * and precondition checks have something to work on.
 */
const DEFAULT_SKILLS: readonly {
  readonly name: string;
  readonly achieves: string;
  readonly description: string;
  readonly steps: readonly SkillStep[];
  readonly prior: number;
}[] = Object.freeze([
  {
    name: 'observe the situation',
    achieves: 'understand what is happening',
    description: 'look at what is in front of you before deciding anything',
    steps: [
      { kind: 'action', name: 'scan' },
      { kind: 'action', name: 'record' },
    ],
    prior: 0.3,
  },
  {
    name: 'write down what was learned',
    achieves: 'understand what is happening',
    description: 'commit the finding to memory while it is still fresh',
    steps: [{ kind: 'action', name: 'record' }],
    prior: 0.3,
  },
  {
    name: 'restart the service',
    achieves: 'the service recovers',
    description: 'cycle the service, clearing whatever state it was stuck in',
    steps: [
      { kind: 'action', name: 'stop' },
      { kind: 'action', name: 'start' },
    ],
    prior: 0.2,
  },
]);
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
  readonly skills: SkillRegistry;
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

  // Procedural memory, populated so the layer is live rather than empty. Each
  // skill's name matches a planner action, which is how a plan step becomes a
  // practised procedure instead of a bare function call.
  const skills = new SkillRegistry({
    clock: kernel.clock,
    bus: kernel.bus,
    rng: kernel.rng,
    // The registry's own defaults are used deliberately: they are the values
    // the skill layer's measurements were taken at, and a preset that changed
    // them would change what mastery means without saying so.
    scheduler: kernel.scheduler,
  });
  for (const procedure of DEFAULT_SKILLS) skills.define(procedure);

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
    skills,
    ...(environment === undefined ? {} : { environment }),
  });

  return { kernel, working, episodic, semantic, consolidation, rememberer, gate, world, beliefs, goals, planner, calibrator, skills, agent };
}

// ── commands ────────────────────────────────────────────────────────────────

async function commandDemo(seed: number, quiet: boolean, presetName: PresetName): Promise<number> {
  const result = await runPipelineScenario({ seed, verbose: !quiet, preset: presetName });

  const report = result.calibrator.report('world-model');
  process.stdout.write(
    `\nsummary: ${result.cycles} cycles, ${result.episodic.size} episodes, ` +
      `${result.semantic.size} concepts, ${result.beliefs.size} beliefs, ` +
      `${result.world.log.length} actions\n` +
      `         calibration ${report.verdict} (brier ${report.brier.toFixed(3)}, ` +
      `bias ${report.bias >= 0 ? '+' : ''}${report.bias.toFixed(3)})\n` +
      `         preset ${presetName}\n`,
  );
  return 0;
}

async function commandInspect(seed: number, json: boolean, presetName: PresetName): Promise<number> {
  const assembly = assemble(seed, presetName);
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

async function commandRepl(seed: number, presetName: PresetName): Promise<number> {
  const readline = await import('node:readline');
  const environment = inertEnvironment();
  const assembly = assemble(seed, presetName, environment);
  await assembly.kernel.start();

  const goal = assembly.goals.declare('understand what is happening', { utility: 0.8 });
  assembly.goals.activate(goal.id);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'logos> ' });

  process.stdout.write(`LOGOS v${VERSION} — interactive session (seed ${seed}, preset ${presetName})\n`);
  process.stdout.write(`Type observations to feed the agent. Commands: :state  :beliefs  :goals  :memory  :skills  :quit\n\n`);
  rl.prompt();

  const handle = async (line: string): Promise<void> => {
    const text = line.trim();
    if (text.length === 0) return;

    if (text === ':quit' || text === ':q') {
      // Set BEFORE closing, so the line handler's continuation sees it. The
      // 'close' event cannot serve this purpose on its own: it fires during
      // `rl.close()`, which is synchronous, so relying on it would leave the
      // ordering to whether an event listener runs before a promise
      // continuation — true today, and not something to depend on.
      closing = true;
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
    if (text === ':skills') {
      const all = assembly.skills.all();
      process.stdout.write(all.length === 0 ? '  (no skills)\n' : '');
      for (const skill of all) {
        process.stdout.write(
          `  ${skill.mastery.toFixed(2)}  ${skill.name}  ${skill.attempts} attempts, cost ${skill.attentionCost.toFixed(2)}\n`,
        );
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

    // Intensity 1.0 because this is not ambient input: a person typed it and is
    // waiting for an answer, which is as deliberate as attention gets. It used
    // to be 0.8, which combined with the old default threshold meant the REPL
    // refused every single percept.
    const report = await assembly.agent.cycle([
      { content: text, source: 'user', modality: 'text', intensity: 1 },
    ]);
    process.stdout.write(
      `  admitted ${report.perceptsAdmitted}/${report.perceptsOffered}` +
        `, surprise ${report.surprise.toFixed(2)}` +
        `, recalled ${report.recalled}` +
        (report.action === undefined ? '' : `, acted: ${report.action.name}`) +
        '\n',
    );
  };

  /**
   * Set once the session is ending.
   *
   * Without it, `:quit` closed the readline interface from inside `handle` and
   * then the `.then()` below called `rl.prompt()` on it — throwing
   * `ERR_USE_AFTER_CLOSE` and making the polite way out of the REPL exit with a
   * stack trace and status 1. Reading a line and deciding to stop are not
   * atomic, and the continuation has to know which happened.
   */
  let closing = false;

  /**
   * Lines are processed ONE AT A TIME, in the order they arrived.
   *
   * A cycle is asynchronous and takes real time, while a `:command` is
   * synchronous and returns immediately. Piping the two together — which is
   * exactly what happens when someone types an observation and then a command,
   * or pastes several lines — used to run them concurrently, so `:skills`
   * reported the state from BEFORE the observation finished. The data was not
   * wrong; it was stale, which is harder to notice.
   *
   * A user should not have to type slowly to get the truth.
   */
  let queue: Promise<void> = Promise.resolve();

  rl.on('line', (line) => {
    queue = queue.then(async () => {
      if (closing) return;
      await handle(line);
      if (!closing) rl.prompt();
    });
  });

  rl.on('close', () => {
    closing = true;
  });

  return new Promise<number>((resolve) => {
    rl.on('close', () => resolve(0));
  });
}

/**
 * A one-shot exit hook, filled in once the input loop is running.
 *
 * `handle` needs to be able to end the session, and the session's teardown
 * needs the input loop's disposer — a cycle. Rather than declare `finish` in
 * the outer scope and assign it from inside a Promise executor that runs
 * synchronously, which puts the binding in its temporal dead zone exactly when
 * `:quit` is typed, the hook is an object whose single field is filled in
 * before any input can arrive.
 */
interface ExitHook {
  finish: (() => void) | undefined;
}

/**
 * The live dashboard.
 *
 * Refuses to run without a TTY rather than printing escape codes into a pipe.
 * A dashboard redirected to a file is a file full of cursor movements, and the
 * person who did it wanted `inspect` or `demo`.
 */
async function commandTui(seed: number, presetName: PresetName): Promise<number> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    process.stderr.write(
      'error: the dashboard needs a terminal.\n' +
        '       For scripted use, try: logos demo --quiet  ·  logos inspect --json\n',
    );
    return 2;
  }

  // Filled in once the input loop exists; see ExitHook.
  const exitHook: ExitHook = { finish: undefined };

  const assembly = assemble(seed, presetName, inertEnvironment());
  await assembly.kernel.start();

  const parts: DashboardParts = {
    kernel: assembly.kernel,
    agent: assembly.agent,
    working: assembly.working,
    episodic: assembly.episodic,
    semantic: assembly.semantic,
    world: assembly.world,
    beliefs: assembly.beliefs,
    goals: assembly.goals,
    calibrator: assembly.calibrator,
  };

  let notice = '';
  let input = '';
  let buffer = input;
  let busy = false;
  let closed = false;

  const draw = (): void => {
    if (closed) return;
    const dashboard = new Dashboard({
      parts,
      seed,
      presetName,
      version: VERSION,
      notice: () => notice,
      input: buffer,
    });
    for (const admittedLine of recentAdmitted) dashboard.noteAdmitted(admittedLine);
    for (const report of recentReports) dashboard.observeCycle(report);
    process.stdout.write(dashboard.render());
  };

  /** Lines the gate admitted, newest first, for the ATTENTION panel. */
  const recentAdmitted: string[] = [];
  /** Cycle reports, newest first, so the panels have history at first paint. */
  const recentReports: CycleReport[] = [];

  // The goal is declared up front so the dashboard opens on a mind that wants
  // something, rather than on an empty GOALS panel that looks broken.
  const goal = assembly.goals.declare('understand what is happening', { utility: 0.8 });
  assembly.goals.activate(goal.id);

  process.stdout.write(terminalControl.HIDE_CURSOR + terminalControl.CLEAR);

  const commands: Readonly<Record<string, () => string>> = Object.freeze({
    ':help': () => 'commands: :state :beliefs :goals :memory :world :skills :save :clear :quit',
    ':state': () => JSON.stringify(assembly.agent.state()).slice(0, 4000),
    ':beliefs': () => {
      const held = assembly.beliefs.all();
      return held.length === 0
        ? '(no beliefs)'
        : held.map((b) => `${b.credence.toFixed(3)} ${b.conflicted ? '⚡' : ' '} ${b.proposition}`).join('\n');
    },
    ':goals': () => {
      const all = assembly.goals.all();
      return all.length === 0
        ? '(no goals)'
        : all.map((g) => `[${g.status}] p=${g.priority.toFixed(2)} ${g.description}`).join('\n');
    },
    ':memory': () => {
      const items = assembly.working.contents();
      return items.length === 0
        ? '(working memory empty)'
        : items.map((i) => `${i.activation.toFixed(3)} ${i.content}`).join('\n');
    },
    ':world': () => {
      const known = assembly.world.knownStates(12);
      return known.length === 0
        ? '(nothing observed)'
        : known.map((s) => `${String(s.observations).padStart(3)}× ${s.content} →${s.transitions}`).join('\n');
    },
    ':skills': () => {
      const all = assembly.skills?.all() ?? [];
      return all.length === 0
        ? '(no skills defined)'
        : all.map((s) => `${s.mastery.toFixed(2)} ${s.name} (${s.attempts} attempts)`).join('\n');
    },
    ':clear': () => {
      recentAdmitted.length = 0;
      recentReports.length = 0;
      return 'cleared the panels';
    },
  });

  const handle = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (text.length === 0) return;

    if (text === ':quit' || text === ':q') {
      exitHook.finish?.();
      return;
    }

    const command = commands[text];
    if (command !== undefined) {
      notice = command();
      return;
    }

    if (busy) return;
    busy = true;
    try {
      // Intensity 1.0: a person typed this and is waiting. Combined with the
      // default threshold of 0.28 that is comfortably enough to be considered,
      // which is the point — the old 0.8 against 0.35 admitted nothing at all.
      const report = await assembly.agent.cycle([
        { content: text, source: 'user', modality: 'text', intensity: 1 },
      ]);
      recentReports.unshift(report);
      if (recentReports.length > 6) recentReports.pop();
      if (report.perceptsAdmitted > 0) {
        recentAdmitted.unshift(text);
        if (recentAdmitted.length > 6) recentAdmitted.pop();
        notice = `admitted · surprise ${report.surprise.toFixed(2)} · recalled ${report.recalled}`;
      } else {
        const why = report.refused[0]?.reason ?? 'below-threshold';
        notice = `refused (${why}) — try something more unexpected, or :help`;
      }
    } catch (error) {
      notice = `error: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
    }
  };

  return new Promise<number>((resolve) => {
    let drawing = false;
    const render = (): void => {
      if (drawing || closed) return;
      drawing = true;
      try {
        draw();
      } finally {
        drawing = false;
      }
    };

    /**
     * Whether the terminal has already been handed back.
     *
     * Separate from `closed`, which only means "stop drawing". Conflating the
     * two meant `:quit` set `closed` and the cleanup then returned early,
     * leaving the cursor HIDDEN after a normal exit — the terminal stayed
     * unusable until the user ran `reset`. Exiting is not the same as having
     * exited.
     */
    let restored = false;

    const dispose = readLine(
      (text) => {
        void handle(text).then(() => {
          buffer = '';
          render();
        });
      },
      (next) => {
        buffer = next;
        render();
      },
      () => {
        finish();
      },
    );

    // A redraw timer rather than a tick subscription: the heartbeat runs at
    // 20Hz and animating the terminal at 20Hz would spend more time painting
    // than thinking. 8Hz is enough to see activation decay as it happens.
    const timer = setInterval(render, 125);

    // Declared before `handle` closes over it. A `function` declaration further
    // down would hoist, but the binding would still be in its temporal dead
    // zone at the moment `handle` is defined — and `:quit` reaching an
    // uninitialised binding is a crash on the one command a user is most likely
    // to type.
    const finish = (): void => {
      closed = true;
      if (restored) return;
      restored = true;
      clearInterval(timer);
      dispose();
      // Both of these are unconditional on the way out: the cursor must come
      // back, and the colours must be reset, or the user's shell inherits them.
      process.stdout.write(terminalControl.SHOW_CURSOR + terminalControl.RESET + '\n');
      void assembly.kernel.stop().then(() => resolve(0));
    };

    exitHook.finish = finish;
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);

    render();
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

  // An unknown preset is rejected BEFORE anything runs. Silently falling back
  // to the default would mean a typo produced a working run with the wrong
  // configuration, which is the worst of both worlds.
  const presetName = (values.preset ?? 'default') as PresetName;
  if (!availablePresets().includes(presetName)) {
    process.stderr.write(
      `error: unknown preset "${String(values.preset)}". Available: ${availablePresets().join(', ')}\n`,
    );
    return 2;
  }

  switch (command) {
    case 'demo':
      return commandDemo(seed, values.quiet === true, presetName);
    case 'inspect':
      return commandInspect(seed, values.json === true, presetName);
    case 'bench': {
      const cycles = Number(values.cycles ?? 200);
      if (!Number.isFinite(cycles) || cycles < 1) {
        process.stderr.write(`error: --cycles must be a positive number, got ${String(values.cycles)}\n`);
        return 2;
      }
      return commandBench(Math.floor(cycles), seed);
    }
    case 'repl':
      return commandRepl(seed, presetName);
    case 'tui':
      return commandTui(seed, presetName);
    default:
      process.stderr.write(`error: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

const exitCode = await main();
process.exitCode = exitCode;
