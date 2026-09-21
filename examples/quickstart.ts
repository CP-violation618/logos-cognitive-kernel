/**
 * LOGOS :: Usage walkthrough
 * ---------------------------------------------------------------------------
 * A runnable tour of what exists today: the kernel and the memory layer.
 * Everything below is exercised by `node examples/quickstart.ts`.
 */

import { Kernel } from '../src/kernel/kernel.ts';
import { WorkingMemory } from '../src/memory/working.ts';
import { EpisodicMemory } from '../src/memory/episodic.ts';
import { SemanticMemory } from '../src/memory/semantic.ts';
import { ConsolidationEngine } from '../src/memory/consolidation.ts';
import { Rememberer } from '../src/memory/remember.ts';

const rule = (title: string): void => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);

// ═══════════════════════════════════════════════════════════════════════════
// 1. The kernel: a clock, an event bus, a budgeted scheduler, one RNG
// ═══════════════════════════════════════════════════════════════════════════

rule('1. Booting the kernel');

const kernel = new Kernel({
  config: {
    name: 'demo',
    seed: 0x5eed,
    // Logical ticks per second when the heartbeat runs. Tests never use it.
    clock: { hz: 20 },
  },
});

// A subsystem is anything with a name and a start method. Subsystems may only
// talk to each other through the bus, which is what keeps the layers honest.
kernel.use({
  name: 'greeter',
  start(ctx) {
    ctx.bus.on('kernel:started', () => console.log('  greeter: hello from a subsystem'));
  },
});

await kernel.start();
console.log(`  ${kernel.describe()}`);

// ═══════════════════════════════════════════════════════════════════════════
// 2. Work is scheduled, not awaited
// ═══════════════════════════════════════════════════════════════════════════

rule('2. Scheduling work under a budget');

console.log(`  budget per tick: ${kernel.config.scheduler.budgetPerTick} units`);

// A task may finish, or it may YIELD — meaning "that is as far as this thought
// goes for now, pick me up next tick". Yielding is how deliberation is spread
// across cycles instead of running away with one.
let step = 0;
const deliberate = kernel.scheduler.enqueue<number>({
  name: 'deliberate',
  priority: 100,
  run: () => {
    step += 1;
    if (step < 3) return { status: 'yielded', detail: `phase ${step}` };
    return { status: 'done', value: step };
  },
});

// Drain ticks manually. In a live system the clock's heartbeat does this.
for (let i = 0; i < 4; i += 1) {
  await kernel.tick();
  const state = kernel.scheduler.getState(deliberate.id);
  console.log(`  tick ${i + 1}: state=${state ?? 'pruned'}`);
}
console.log(`  concluded after ${(await deliberate.settled).attempts} attempts`);

// ═══════════════════════════════════════════════════════════════════════════
// 3. Working memory: the bottleneck
// ═══════════════════════════════════════════════════════════════════════════

rule('3. Working memory holds about seven things');

const working = new WorkingMemory({ capacity: 7 });
working.encode('the client wants the report by Friday', { salience: 0.9, confidence: 0.9 });
working.encode('the staging database is still on the old schema', { salience: 0.7 });
working.encode('lunch is at noon', { salience: 0.2 });

console.log(`  holding ${working.size} of ${working.capacity} slots:`);
for (const item of working.contents()) {
  console.log(`    ${item.activation.toFixed(3)}  ${item.content}`);
}

// Rehearsal raises activation AND lengthens the half-life, so a rehearsed
// thought decays more slowly than a fresh one. This is the spacing effect.
const target = working.contents()[0];
if (target !== undefined) {
  const before = working.get(target.id, { reinforce: false })?.halfLife ?? 0;
  working.encode(target.content, { salience: 0.9 });
  const after = working.get(target.id, { reinforce: false })?.halfLife ?? 0;
  console.log(`  rehearsing "${target.content.slice(0, 30)}..." half-life ${before.toFixed(1)} -> ${after.toFixed(1)} ticks`);
}

// Attention is a competition, not a filter: priming biases it from a goal.
working.prime('database schema migration', 1);
console.log(`  after priming on "database schema":`);
for (const item of working.focused().slice(0, 3)) {
  console.log(`    ${item.activation.toFixed(3)}  ${item.content}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Episodic memory: what happened
// ═══════════════════════════════════════════════════════════════════════════

rule('4. Episodic memory records experience, and recall rewrites it');

const episodic = new EpisodicMemory({ baseHalfLife: 400 });

const incidents = [
  'the payment gateway timed out during the morning peak',
  'the payment gateway timed out again when traffic doubled',
  'the payment gateway timed out while the cache was cold',
  'the payment gateway timed out under a bulk import',
];

for (const [i, text] of incidents.entries()) {
  const { id } = episodic.encode(text, {
    situation: `incident-${i}`,
    context: { service: 'payments', shift: i < 2 ? 'morning' : 'evening' },
    surprise: 0.7,
    selfRelevance: 0.5,
    affect: { valence: -0.4, arousal: 0.6 },
    data: { service: 'payments', severity: 'high' },
  });
  console.log(`  recorded ${id}: ${text.slice(0, 46)}...`);
  episodic.advance(3);
}

const recalled = episodic.recall({ text: 'payment gateway timeout', limit: 2 });
console.log(`  recalled ${recalled.length} of them for "payment gateway timeout"`);
const firstHit = recalled[0];
if (firstHit !== undefined) {
  console.log(`    score ${firstHit.score.toFixed(3)} = similarity ${firstHit.components.similarity}, strength ${firstHit.components.strength}, recency ${firstHit.components.recency}`);
}

// Reconsolidation: recall folds the present context into the past. The memory
// gets stronger and less faithful at the same time.
if (firstHit !== undefined) {
  const before = episodic.get(firstHit.episode.id);
  episodic.retrieve(firstHit.episode.id, { context: { reviewedDuring: 'postmortem' } });
  const after = episodic.get(firstHit.episode.id);
  console.log(`  after recall: strength ${before?.strength} -> ${after?.strength}, context now has ${Object.keys(after?.context ?? {}).join(', ')}`);
  console.log(`  reconsolidated ${episodic.stats().reconsolidated} time(s) — the memory has been rewritten`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Consolidation: experience becomes knowledge
// ═══════════════════════════════════════════════════════════════════════════

rule('5. Consolidation generalises recurring experience');

const semantic = new SemanticMemory({ baseHalfLife: 4_000 });
const engine = new ConsolidationEngine({
  clock: kernel.clock,
  bus: kernel.bus,
  scheduler: kernel.scheduler,
  // Age threshold lowered so the demo does not have to simulate thousands of
  // ticks. The default is 40, which is the honest value for a live mind.
  config: { ...kernel.config, memory: { ...kernel.config.memory, consolidationAgeTicks: 1 } },
  rng: kernel.rng,
  episodic,
  semantic,
});

const outcome = engine.consolidateNow();
console.log(`  pass: ${outcome.clusters} cluster(s), ${outcome.conceptsFormed} concept(s) formed, ${outcome.conceptsReinforced} reinforced`);

for (const concept of semantic.all()) {
  console.log(`    "${concept.label}"`);
  console.log(`      definition: ${concept.definition.slice(0, 60)}...`);
  console.log(`      grounding:  ${concept.grounding} distinct episodes (confidence ${concept.confidence.toFixed(3)})`);
}

// The sources survive: generalising does not erase the experiences.
console.log(`  episodic memory still holds ${episodic.size} episodes — generalising does not erase them`);

// ═══════════════════════════════════════════════════════════════════════════
// 6. Unified recall: one question, four stores, one answer
// ═══════════════════════════════════════════════════════════════════════════

rule('6. Recall across every store at once');

const rememberer = new Rememberer({
  working,
  episodic,
  semantic,
  rng: kernel.rng,
  now: () => kernel.clock.current,
});

const memory = rememberer.recall({ text: 'the payment gateway timed out', limit: 6, spreadDepth: 2 });
console.log(`  considered: ${memory.considered.semantic} concepts, ${memory.considered.episodic} episodes, ${memory.considered.working} working items`);
console.log('  ranked:');
for (const item of memory.items) {
  const route = item.via === 'direct' ? '' : `  via ${item.path.join(' > ') || item.via}`;
  console.log(`    ${item.relevance.toFixed(3)}  [${item.store}] ${item.trace.content.slice(0, 50)}${route}`);
}
console.log(`  gist: ${memory.gist.map((c) => c.label).join(', ') || '(none)'}`);

// Mood colours what comes back. Run against episodic memory only, and against
// genuinely unhappy memories: affective bias applies to the AFFECTIVE content
// of a trace, so the effect is invisible on neutral material — which is itself
// the correct behaviour, not a shortcoming.
const gloomy = rememberer.recall({
  text: 'the payment gateway timed out',
  limit: 3,
  stores: ['episodic'],
  mood: { valence: -0.8, arousal: 0.7 },
});
const bright = rememberer.recall({
  text: 'the payment gateway timed out',
  limit: 3,
  stores: ['episodic'],
  mood: { valence: 0.8, arousal: 0.7 },
});
const gloomyTop = gloomy.items[0]?.relevance ?? 0;
const brightTop = bright.items[0]?.relevance ?? 0;
console.log(`  unhappy memories under a matching mood: ${gloomyTop.toFixed(3)}; under a mismatched one: ${brightTop.toFixed(3)}`);
console.log(`  affectMagnitude of a low mood on a neutral trace is 0, so neutral recall is unbiased by design`);

// ═══════════════════════════════════════════════════════════════════════════
// 7. Determinism: the same seed replays the same mind
// ═══════════════════════════════════════════════════════════════════════════

rule('7. Everything is replayable');

const runOnce = async (seed: number): Promise<number[]> => {
  const k = new Kernel({ config: { seed } });
  await k.start();
  const draws: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    await k.run({
      name: `draw${i}`,
      priority: k.rng.int(1, 100),
      run: () => {
        draws.push(k.rng.next());
        return { status: 'done' as const };
      },
    });
  }
  await k.stop();
  return draws;
};

const a = await runOnce(1234);
const b = await runOnce(1234);
console.log(`  seed 1234 twice: ${a.map((n) => n.toFixed(4)).join(', ')}`);
console.log(`  identical: ${JSON.stringify(a) === JSON.stringify(b)}`);

// ═══════════════════════════════════════════════════════════════════════════

rule('Shutdown');
console.log(`  ${kernel.describe()}`);
console.log(`  health: ${kernel.health().map((h) => `${h.subsystem}=${h.ok ? 'ok' : 'degraded'}`).join(', ')}`);
await kernel.stop();
console.log(`  ${kernel.describe()}`);
console.log('\nDone. Everything above ran on Node with no dependencies.\n');
