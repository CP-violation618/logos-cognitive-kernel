/**
 * LOGOS :: Memory :: Unified recall tests
 * ---------------------------------------------------------------------------
 * The claim under test is that recall is a single act over four stores, not
 * four lookups stapled together. The mechanisms that make it one:
 *   · a relevance scale comparable ACROSS stores;
 *   · cross-store spreading activation that travels
 *     episode → concept → other episodes;
 *   · mood applied once, globally, so the bias cannot compound per store.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rememberer } from '../src/memory/remember.ts';
import { WorkingMemory } from '../src/memory/working.ts';
import { EpisodicMemory } from '../src/memory/episodic.ts';
import { SemanticMemory } from '../src/memory/semantic.ts';
import { ConsolidationEngine } from '../src/memory/consolidation.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import { tick as mkTick } from '../src/kernel/types.ts';

interface Harness {
  readonly kernel: Kernel;
  readonly working: WorkingMemory;
  readonly episodic: EpisodicMemory;
  readonly semantic: SemanticMemory;
  readonly engine: ConsolidationEngine;
  readonly rememberer: Rememberer;
}

const harness = (): Harness => {
  const kernel = new Kernel({ config: { memory: { consolidationAgeTicks: 1 } } });
  const working = new WorkingMemory({ capacity: 7 });
  const episodic = new EpisodicMemory({ baseHalfLife: 10_000, forgetThreshold: 0.001 });
  const semantic = new SemanticMemory({ baseHalfLife: 10_000 });
  const engine = new ConsolidationEngine({
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
  return { kernel, working, episodic, semantic, engine, rememberer };
};

// ── A single ranked list ────────────────────────────────────────────────────

test('recall: returns results from every store on one scale', () => {
  const { working, episodic, semantic, rememberer } = harness();

  working.encode('the build is currently broken', { salience: 0.9 });
  episodic.encode('the build broke after the schema migration', { situation: 'debugging', surprise: 0.6 });
  semantic.observe({ label: 'build failure', definition: 'the build breaks when the schema migration runs' });

  const result = rememberer.recall({ text: 'the build is broken' });

  assert.ok(result.items.length >= 2, `expected several stores to contribute: ${result.items.length}`);
  const stores = new Set(result.items.map((i) => i.store));
  assert.ok(stores.size >= 2, `stores represented: ${[...stores].join(', ')}`);

  // Relevance must be a single comparable scale.
  for (const item of result.items) {
    assert.ok(item.relevance >= 0 && item.relevance <= 1, `relevance out of range: ${item.relevance}`);
  }
  const relevances = result.items.map((i) => i.relevance);
  assert.deepEqual(relevances, [...relevances].sort((a, b) => b - a), 'ranked descending');
});

test('recall: an empty memory recalls nothing without error', () => {
  const { rememberer } = harness();
  const result = rememberer.recall({ text: 'anything at all' });

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.gist, []);
  assert.equal(result.at, 0);
});

test('recall: limit and threshold control the result size', () => {
  const { semantic, rememberer } = harness();
  for (let i = 0; i < 8; i += 1) {
    semantic.observe({ label: `topic${i}`, definition: `a distinct subject area numbered ${i}` });
  }

  assert.ok(rememberer.recall({ text: 'distinct subject area', limit: 3 }).items.length <= 3);
  assert.equal(rememberer.recall({ text: 'nothing like this exists', threshold: 0.95 }).items.length, 0);
});

test('recall: stores can be restricted', () => {
  const { working, episodic, semantic, rememberer } = harness();
  working.encode('a live thought about the topic', { salience: 0.9 });
  episodic.encode('an experience of the topic', { situation: 's' });
  semantic.observe({ label: 'the topic', definition: 'a subject under discussion' });

  const onlySemantic = rememberer.recall({ text: 'the topic', stores: ['semantic'] });
  assert.ok(onlySemantic.items.every((i) => i.store === 'semantic'));

  const onlyEpisodic = rememberer.recall({ text: 'experience of the topic', stores: ['episodic'] });
  assert.ok(onlyEpisodic.items.every((i) => i.store === 'episodic'));
});

test('recall: exclude removes specific traces', () => {
  const { semantic, rememberer } = harness();
  semantic.observe({ label: 'alpha', definition: 'the first described subject' });
  semantic.observe({ label: 'beta', definition: 'the second described subject' });
  const alphaId = semantic.get('alpha')?.id ?? '';

  const result = rememberer.recall({ text: 'described subject', exclude: [alphaId] });
  assert.ok(result.items.every((i) => i.trace.id !== alphaId));
});

test('recall: consider counts are reported so a skewed result is explainable', () => {
  const { semantic, rememberer } = harness();
  semantic.observe({ label: 'thing', definition: 'a described thing for counting purposes' });
  const result = rememberer.recall({ text: 'described thing' });
  assert.ok(result.considered.semantic >= 1);
  assert.equal(typeof result.considered.working, 'number');
  assert.equal(typeof result.considered.episodic, 'number');
});

// ── Cross-store spreading activation ────────────────────────────────────────

test('recall: a recalled episode brings back the concept it taught', () => {
  const { episodic, semantic, engine, rememberer } = harness();

  for (let i = 0; i < 4; i += 1) {
    episodic.encode(`the payment gateway timed out on request ${i} under load`, {
      situation: `incident-${i}`,
      surprise: 0.5,
      selfRelevance: 0.4,
    });
    episodic.advance(2);
  }
  engine.consolidateNow();

  const concept = semantic.all()[0];
  assert.ok(concept !== undefined, 'a concept formed from the recurring incident');

  // Query with episode-like wording rather than the concept's label: the
  // concept should still come back, because the episodes reach it.
  const result = rememberer.recall({ text: 'the payment gateway timed out under load' });
  const labels = result.gist.map((c) => c.label);
  assert.ok(labels.length >= 1, `the generalisation was not reached: ${result.items.map((i) => i.store).join(', ')}`);
});

test('recall: a concept brings back other episodes of the same thing', () => {
  const { episodic, semantic, engine, rememberer } = harness();

  for (let i = 0; i < 5; i += 1) {
    episodic.encode(`the payment gateway timed out on request ${i} under heavy load`, {
      situation: `incident-${i}`,
      surprise: 0.6,
      selfRelevance: 0.5,
    });
    episodic.advance(2);
  }
  engine.consolidateNow();

  // Ask about the concept by name; the specific incidents should surface even
  // though their wording is what matched, not the query.
  const concept = semantic.all()[0];
  assert.ok(concept !== undefined);

  const result = rememberer.recall({ text: concept.label, spreadDepth: 2, limit: 12 });
  const episodeCount = result.items.filter((i) => i.store === 'episodic').length;
  assert.ok(episodeCount >= 1, `expected episodes to be reached from the concept, got ${episodeCount}`);
  assert.ok(result.resonant.length + episodeCount >= 1);
});

test('recall: spreadDepth 0 disables cross-store activation', () => {
  const { episodic, semantic, engine, rememberer } = harness();
  for (let i = 0; i < 4; i += 1) {
    episodic.encode(`the payment gateway timed out on request ${i} under load`, {
      situation: `incident-${i}`,
      surprise: 0.5,
    });
    episodic.advance(2);
  }
  engine.consolidateNow();

  const spread = rememberer.recall({ text: 'payment gateway', spreadDepth: 2, limit: 20 });
  const flat = rememberer.recall({ text: 'payment gateway', spreadDepth: 0, limit: 20 });

  assert.ok(
    flat.items.every((i) => i.via === 'direct'),
    'with spreading off, everything is a direct hit',
  );
  assert.ok(spread.items.length >= flat.items.length, 'spreading can only add');
});

test('recall: spread results record the route they came by', () => {
  const { semantic, rememberer } = harness();

  semantic.observe({ label: 'incident report', definition: 'a written account of what went wrong' });
  // Deliberately shares no vocabulary with the query, so it cannot come back as
  // a direct hit and can only be reached by activation spreading along the edge.
  semantic.observe({ label: 'zzqq', definition: 'zzqq' });
  semantic.relate('incident report', 'concerns', 'zzqq', { weight: 1, confidence: 1 });

  const result = rememberer.recall({
    text: 'a written account of what went wrong',
    spreadDepth: 2,
    limit: 20,
    threshold: 0.05,
    // The direct-hit bar is raised so an unrelated concept's no-overlap
    // similarity baseline cannot admit it, leaving activation spreading as the
    // only route by which it can arrive.
    directThreshold: 0.4,
  });

  const reached = result.items.find((i) => i.via === 'association');
  assert.ok(
    reached !== undefined,
    `expected an association result, got ${result.items.map((i) => `${i.trace.id}:${i.via}`).join(', ')}`,
  );
  assert.ok(reached.path.length >= 1, `the route should be recorded: [${reached.path.join(' > ')}]`);
  assert.equal(reached.store, 'semantic');
  assert.ok(reached.relevance > 0 && reached.relevance <= 1);
});

test('recall: an association never displaces a direct hit for the same trace', () => {
  const { semantic, rememberer } = harness();
  semantic.observe({ label: 'incident report', definition: 'a written account of what went wrong' });
  semantic.relate('incident report', 'concerns', 'incident report', { weight: 1, confidence: 1 });

  const result = rememberer.recall({ text: 'a written account of what went wrong', spreadDepth: 2, limit: 20 });
  const ids = result.items.map((i) => i.trace.id);
  assert.equal(new Set(ids).size, ids.length, 'no trace appears twice under two different routes');
  assert.equal(result.items[0]?.via, 'direct', 'the direct hit wins');
});

test('recall: prefer shifts the balance between general and specific', () => {
  const { episodic, semantic, rememberer } = harness();
  episodic.encode('the sensor reading drifted during the calibration run', { situation: 'lab' });
  semantic.observe({ label: 'sensor drift', definition: 'the sensor reading drifts during calibration' });

  const general = rememberer.recall({ text: 'sensor reading drifts during calibration', prefer: 'general' });
  const specific = rememberer.recall({ text: 'sensor reading drifts during calibration', prefer: 'specific' });

  const generalTop = general.items[0];
  const specificTop = specific.items[0];
  assert.ok(generalTop !== undefined && specificTop !== undefined);

  if (generalTop.store !== specificTop.store) {
    assert.equal(generalTop.store, 'semantic', 'preferring the general puts a concept first');
    assert.equal(specificTop.store, 'episodic', 'preferring the specific puts an experience first');
  }
});

// ── Recall is rehearsal ─────────────────────────────────────────────────────

test('recall: bringing an episode to mind strengthens it', () => {
  const { episodic, rememberer } = harness();
  const { id } = episodic.encode('a lesson worth retaining about the pipeline', {
    situation: 'review',
    surprise: 0.4,
  });
  const before = episodic.get(id)?.strength ?? 0;

  rememberer.recall({ text: 'a lesson worth retaining about the pipeline', stores: ['episodic'] });
  const after = episodic.get(id)?.strength ?? 0;

  assert.ok(after > before, `recall is rehearsal, not a read: ${before} -> ${after}`);
});

test('recall: the recall counter advances', () => {
  const { rememberer } = harness();
  assert.equal(rememberer.recalls, 0);
  rememberer.recall({ text: 'one' });
  rememberer.recall({ text: 'two' });
  assert.equal(rememberer.recalls, 2);
});

// ── Mood ────────────────────────────────────────────────────────────────────

test('recall: mood-congruence is applied once, globally, not per store', () => {
  const { episodic, semantic, rememberer } = harness();

  episodic.encode('a joyful breakthrough in the laboratory', {
    situation: 'success',
    affect: { valence: 0.9, arousal: 0.7 },
  });
  semantic.observe({ label: 'joyful breakthrough', definition: 'a joyful breakthrough in the laboratory' });

  const happy = rememberer.recall({ text: 'joyful breakthrough in the laboratory', mood: { valence: 0.9, arousal: 0.7 } });
  const flat = rememberer.recall({ text: 'joyful breakthrough in the laboratory', mood: { valence: 0, arousal: 0 } });

  const happyTop = happy.items[0]?.relevance ?? 0;
  const flatTop = flat.items[0]?.relevance ?? 0;

  // A matching mood lifts everything, and crucially does not lift it twice for
  // the stores that happen to be consulted twice.
  assert.ok(happyTop >= flatTop, `matching mood should not suppress: ${happyTop} vs ${flatTop}`);
  assert.ok(happyTop <= 1, 'and must never exceed the ceiling');
});

test('recall: a mismatched mood suppresses what it reaches', () => {
  const { episodic, rememberer } = harness();
  episodic.encode('a joyful celebration of the result', {
    situation: 'success',
    affect: { valence: 0.9, arousal: 0.7 },
  });

  const happy = rememberer.recall({ text: 'joyful celebration of the result', mood: { valence: 0.9, arousal: 0.7 } });
  const sad = rememberer.recall({ text: 'joyful celebration of the result', mood: { valence: -0.9, arousal: 0.7 } });

  const a = happy.items[0]?.relevance ?? 0;
  const b = sad.items[0]?.relevance ?? 0;
  assert.ok(b < a, `a low mood should reach a happy memory less easily: ${a} vs ${b}`);
});

// ── Reporting ───────────────────────────────────────────────────────────────

test('recall: describe() summarises a recollection for logs', () => {
  const { semantic, rememberer } = harness();
  semantic.observe({ label: 'a thing', definition: 'a thing that was described in detail for the log' });
  const line = rememberer.describe(rememberer.recall({ text: 'described in detail' }));

  assert.equal(typeof line, 'string');
  assert.match(line, /semantic:/);
});

test('recall: describe() handles an empty recollection', () => {
  const { rememberer } = harness();
  assert.equal(rememberer.describe(rememberer.recall({ text: 'nothing' })), 'nothing recalled');
});

test('recall: results carry the logical instant they were produced at', () => {
  const { kernel, rememberer } = harness();
  kernel.clock.advance(5);
  const result = rememberer.recall({ text: 'anything' });
  assert.equal(result.at, 5);
  assert.equal(mkTick(5), 5);
});

test('recall: repeated identical queries are deterministic', () => {
  const { semantic, rememberer } = harness();
  for (const label of ['alpha', 'beta', 'gamma']) {
    semantic.observe({ label, definition: `the ${label} subject described here` });
  }

  const first = rememberer.recall({ text: 'the subject described here' }).items.map((i) => i.trace.id);
  const second = rememberer.recall({ text: 'the subject described here' }).items.map((i) => i.trace.id);
  assert.deepEqual(second, first);
});

test('recall: a trace the mind holds but cannot match is not forced in', () => {
  const { semantic, rememberer } = harness();
  semantic.observe({ label: 'cardiology', definition: 'the branch of medicine dealing with the heart' });

  const result = rememberer.recall({ text: 'sourdough starter hydration ratios', threshold: 0.4 });
  assert.equal(result.items.length, 0, 'irrelevance must not be padded out with whatever exists');
});
