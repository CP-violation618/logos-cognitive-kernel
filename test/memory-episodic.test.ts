/**
 * LOGOS :: Memory :: Episodic memory tests
 * ---------------------------------------------------------------------------
 * The headline claim under test here is that retrieval is RECONSTRUCTIVE:
 * recalling an episode changes it. If `retrieve()` were a pure read, the
 * `reconsolidations` counter would always be zero and memory would be a
 * database with extra bookkeeping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { EpisodicMemory } from '../src/memory/episodic.ts';
import { LogosError, tick as mkTick } from '../src/kernel/types.ts';

const ctx = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ room: 'lab', ...over });

// ── Encoding ────────────────────────────────────────────────────────────────

test('episodic: records an episode with its situation and context', () => {
  const em = new EpisodicMemory();
  const { id, merged } = em.encode('saw a bright flash through the window', {
    situation: 'storm',
    context: ctx(),
    surprise: 0.8,
    selfRelevance: 0.4,
  });

  assert.equal(merged, false);
  const episode = em.get(id);
  assert.ok(episode !== undefined);
  assert.equal(episode.situation, 'storm');
  assert.equal(episode.context.room, 'lab');
  assert.equal(episode.surprise, 0.8);
  assert.equal(episode.kind, 'episodic');
});

test('episodic: refuses empty content', () => {
  const em = new EpisodicMemory();
  assert.throws(() => em.encode(''), LogosError);
  assert.throws(() => em.encode('   '), LogosError);
});

test('episodic: a near-duplicate in the same situation merges instead of duplicating', () => {
  const em = new EpisodicMemory({ mergeThreshold: 0.6 });
  const first = em.encode('reading the first paragraph of the document', { situation: 'reading' });
  const second = em.encode('reading the first paragraph of the document', { situation: 'reading' });

  assert.equal(first.merged, false);
  assert.equal(second.merged, true, 'a continuation is not a new event');
  assert.equal(second.id, first.id);
  assert.equal(em.size, 1);
});

test('episodic: the same content in a different situation does not merge', () => {
  const em = new EpisodicMemory({ mergeThreshold: 0.5 });
  em.encode('the room was quiet', { situation: 'morning' });
  // Same words, different situation — a distinct episode.
  em.encode('the room was quiet', { situation: 'evening' });
  assert.equal(em.size, 2);
});

test('episodic: episodes chain automatically in chronological order', () => {
  const em = new EpisodicMemory();
  const a = em.encode('first event of the day', { situation: 'morning' });
  const b = em.encode('second event of the day', { situation: 'noon' });
  const c = em.encode('third event of the day', { situation: 'evening' });

  assert.deepEqual(em.get(b.id)?.precededBy, [a.id]);
  assert.deepEqual(em.get(c.id)?.precededBy, [b.id]);
});

test('episodic: a surprising episode is more durable than a dull one', () => {
  const em = new EpisodicMemory({ baseHalfLife: 100 });
  const dull = em.encode('nothing in particular happened', { situation: 'idle', surprise: 0, selfRelevance: 0 });
  const vivid = em.encode('something unprecedented occurred', { situation: 'crisis', surprise: 1, selfRelevance: 1 });

  const dullEp = em.get(dull.id);
  const vividEp = em.get(vivid.id);
  assert.ok(dullEp !== undefined && vividEp !== undefined);
  assert.ok(
    vividEp.strength > dullEp.strength,
    `vivid ${vividEp.strength} should exceed dull ${dullEp.strength}`,
  );
});

test('episodic: self-relevance raises an episode above an equally surprising one', () => {
  const em = new EpisodicMemory({ baseHalfLife: 100 });
  const impersonal = em.encode('a distant event occurred somewhere', { situation: 'news', surprise: 0.5, selfRelevance: 0 });
  const personal = em.encode('an event happened to me directly', { situation: 'news', surprise: 0.5, selfRelevance: 1 });

  const a = em.get(impersonal.id);
  const b = em.get(personal.id);
  assert.ok(a !== undefined && b !== undefined);
  assert.ok(b.strength > a.strength, 'the self-relevant episode is held harder');
});

// ── Retrieval ───────────────────────────────────────────────────────────────

test('episodic: recall finds an episode by content cue', () => {
  const em = new EpisodicMemory();
  em.encode('the compiler rejected the build with a type error', { situation: 'debugging' });
  em.encode('lunch was a sandwich in the park', { situation: 'break' });

  const hits = em.recall({ text: 'type error in the build' });
  assert.ok(hits.length >= 1);
  assert.match(hits[0]?.episode.content ?? '', /compiler rejected/);
});

test('episodic: recall can be restricted to a situation', () => {
  const em = new EpisodicMemory();
  em.encode('the machine hummed quietly', { situation: 'lab' });
  em.encode('the machine hummed quietly', { situation: 'kitchen' });

  const hits = em.recall({ text: 'machine humming', situation: 'kitchen' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.episode.situation, 'kitchen');
});

test('episodic: context must match when a context filter is supplied', () => {
  const em = new EpisodicMemory();
  em.encode('a reading was taken', { situation: 'experiment', context: { room: 'lab' } });
  em.encode('a reading was taken', { situation: 'experiment', context: { room: 'field' } });

  const hits = em.recall({ context: { room: 'field' } });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.episode.context.room, 'field');
});

test('episodic: recall respects time bounds', () => {
  const em = new EpisodicMemory();
  em.encode('early event', { situation: 'a' });
  em.advance(5);
  em.encode('middle event', { situation: 'b' });
  em.advance(5);
  em.encode('late event', { situation: 'c' });

  const hits = em.recall({ since: mkTick(5), until: mkTick(10) });
  const contents = hits.map((h) => h.episode.content);
  assert.ok(contents.includes('middle event'));
  assert.ok(!contents.includes('early event'));
});

test('episodic: recall can exclude ids already used', () => {
  const em = new EpisodicMemory();
  const a = em.encode('first recollection about the topic', { situation: 's' });
  em.encode('second recollection about the topic', { situation: 's' });

  const hits = em.recall({ text: 'recollection about the topic', exclude: [a.id] });
  assert.ok(hits.every((h) => h.episode.id !== a.id));
});

test('episodic: mood-congruent recall biases what comes back', () => {
  const em = new EpisodicMemory();
  em.encode('a joyful celebration with friends', {
    situation: 'social',
    affect: { valence: 0.9, arousal: 0.6 },
  });
  em.encode('a miserable argument with friends', {
    situation: 'social',
    affect: { valence: -0.9, arousal: 0.6 },
  });

  const happy = em.recall({ text: 'an evening with friends', mood: { valence: 0.9, arousal: 0.6 } });
  const sad = em.recall({ text: 'an evening with friends', mood: { valence: -0.9, arousal: 0.6 } });

  assert.match(happy[0]?.episode.content ?? '', /joyful/, 'a good mood reaches the good memory');
  assert.match(sad[0]?.episode.content ?? '', /miserable/, 'a bad mood reaches the bad one');
});

test('episodic: hits expose their score decomposition', () => {
  const em = new EpisodicMemory();
  em.encode('a scored recollection', { situation: 's', context: ctx(), surprise: 0.5 });
  const hit = em.recall({ text: 'scored recollection' })[0];

  assert.ok(hit !== undefined);
  assert.ok(hit.score >= 0 && hit.score <= 1);
  for (const key of ['similarity', 'contextMatch', 'strength', 'recency', 'affect'] as const) {
    assert.equal(typeof hit.components[key], 'number', `${key} must be reported`);
  }
});

test('episodic: limit and threshold control how much comes back', () => {
  const em = new EpisodicMemory();
  for (let i = 0; i < 10; i += 1) em.encode(`event number ${i} about the experiment`, { situation: 'exp' });

  assert.ok(em.recall({ text: 'event about the experiment', limit: 3 }).length <= 3);
  assert.equal(em.recall({ text: 'completely unrelated query text', threshold: 0.99 }).length, 0);
});

// ── Reconsolidation: the headline mechanism ─────────────────────────────────

test('episodic: retrieve() strengthens the episode (retrieval practice)', () => {
  const em = new EpisodicMemory();
  const { id } = em.encode('a fact I wish to retain', { situation: 'study', surprise: 0.3 });
  const before = em.get(id)?.strength ?? 0;

  em.retrieve(id);
  const after = em.get(id)?.strength ?? 0;

  assert.ok(after > before, `${before} -> ${after}`);
  assert.equal(em.get(id)?.accessCount, 1);
});

test('episodic: retrieve() with a new context re-encodes the memory', () => {
  const em = new EpisodicMemory();
  const { id } = em.encode('where I left the keys', { situation: 'home', context: { room: 'kitchen' } });
  assert.equal(em.get(id)?.context.room, 'kitchen');

  em.retrieve(id, { context: { room: 'hallway' } });

  const episode = em.get(id);
  assert.equal(episode?.context.room, 'hallway', 'recall folded the present into the past');
  assert.ok((episode?.strength ?? 0) > 0);
});

test('episodic: reconsolidation count tracks how often a memory was rewritten', () => {
  const em = new EpisodicMemory();
  const { id } = em.encode('an evolving recollection', { situation: 's' });

  assert.equal(em.stats().reconsolidated, 0);
  em.retrieve(id, { context: { seen: 1 } });
  em.retrieve(id, { context: { seen: 2 } });
  em.retrieve(id, { context: { seen: 3 } });

  assert.equal(em.stats().reconsolidated, 3);
  assert.equal(em.get(id)?.context.seen, 3, 'each recall edited the memory again');
});

test('episodic: read-only retrieval does not reconsolidate', () => {
  const em = new EpisodicMemory();
  const { id } = em.encode('untouched recollection', { situation: 's', context: { a: 1 } });
  em.retrieve(id, { context: { a: 2 }, reinforce: false });

  assert.equal(em.stats().reconsolidated, 0);
  assert.equal(em.get(id)?.context.a, 1, 'a non-reinforcing read leaves no trace');
});

test('episodic: repeated reconsolidation has diminishing returns', () => {
  const em = new EpisodicMemory();
  const { id } = em.encode('a memory under repeated recall', { situation: 's' });

  const gains: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const before = em.get(id)?.strength ?? 0;
    em.retrieve(id, { context: { pass: i } });
    gains.push((em.get(id)?.strength ?? 0) - before);
  }

  assert.ok(gains[0] !== undefined && gains[4] !== undefined);
  assert.ok((gains[0] as number) > (gains[4] as number), `first gain ${gains[0]} should exceed last ${gains[4]}`);
});

test('episodic: retrieving a missing episode yields undefined rather than throwing', () => {
  const em = new EpisodicMemory();
  assert.equal(em.retrieve('ep_does_not_exist'), undefined);
});

// ── Sequence traversal ──────────────────────────────────────────────────────

test('episodic: replayFrom reconstructs what led to an episode', () => {
  const em = new EpisodicMemory();
  const a = em.encode('woke up late', { situation: 'morning' });
  const b = em.encode('missed the bus', { situation: 'commute' });
  const c = em.encode('arrived flustered', { situation: 'office' });

  const chain = em.replayFrom(c.id);
  assert.deepEqual(
    chain.map((e) => e.content),
    ['woke up late', 'missed the bus', 'arrived flustered'],
  );
  assert.equal(chain[0]?.id, a.id);
  assert.equal(chain[1]?.id, b.id);
});

test('episodic: replayTo reconstructs what followed an episode', () => {
  const em = new EpisodicMemory();
  const a = em.encode('the first domino fell', { situation: 'chain' });
  em.encode('the second followed', { situation: 'chain' });
  em.encode('the third concluded it', { situation: 'chain' });

  const chain = em.replayTo(a.id);
  assert.deepEqual(
    chain.map((e) => e.content),
    ['the first domino fell', 'the second followed', 'the third concluded it'],
  );
});

test('episodic: replay is bounded and cycle-safe', () => {
  const em = new EpisodicMemory();
  const a = em.encode('alpha', { situation: 's' });
  const b = em.encode('beta', { situation: 's' });

  assert.ok(em.replayFrom(b.id, 1).length <= 1);
  assert.ok(em.replayFrom(b.id, 100).length <= 100);
  assert.doesNotThrow(() => em.replayTo(a.id, 0));
});

test('episodic: between() returns the episodes in a window, oldest first', () => {
  const em = new EpisodicMemory();
  em.encode('at tick zero', { situation: 's' });
  em.advance(3);
  em.encode('at tick three', { situation: 's' });
  em.advance(3);
  em.encode('at tick six', { situation: 's' });

  const window = em.between(mkTick(1), mkTick(5));
  assert.deepEqual(
    window.map((e) => e.content),
    ['at tick three'],
  );
});

test('episodic: latest() and earliest() bound the record', () => {
  const em = new EpisodicMemory();
  assert.equal(em.latest(), undefined);

  em.encode('the beginning', { situation: 's' });
  em.advance(2);
  em.encode('the end', { situation: 's' });

  assert.equal(em.earliest()?.content, 'the beginning');
  assert.equal(em.latest()?.content, 'the end');
});

// ── Decay and forgetting ────────────────────────────────────────────────────

test('episodic: significance governs which episodes are generalised', () => {
  const em = new EpisodicMemory({ baseHalfLife: 100 });
  em.encode('a tedious routine check', { situation: 'routine', surprise: 0, selfRelevance: 0 });
  em.encode('an astonishing discovery', { situation: 'research', surprise: 1, selfRelevance: 0.9 });
  em.advance(10);

  const candidates = em.consolidationCandidates(5, 1);
  assert.equal(candidates.length, 1);
  assert.match(candidates[0]?.content ?? '', /astonishing/);
});

test('episodic: consolidation candidates respect a minimum age', () => {
  const em = new EpisodicMemory();
  em.encode('too fresh to generalise', { situation: 's', surprise: 1 });

  assert.equal(em.consolidationCandidates(100, 10).length, 0);
  em.advance(100);
  assert.equal(em.consolidationCandidates(100, 10).length, 1);
});

test('episodic: markConsolidated is idempotent and counted', () => {
  const em = new EpisodicMemory();
  const a = em.encode('first lesson', { situation: 's' });
  const b = em.encode('second lesson', { situation: 's' });

  assert.equal(em.markConsolidated([a.id, b.id]), 2);
  assert.equal(em.markConsolidated([a.id, b.id]), 0, 'already marked');
  assert.equal(em.stats().consolidated, 2);
});

test('episodic: unrehearsed episodes eventually decay away', () => {
  const em = new EpisodicMemory({ baseHalfLife: 20, forgetThreshold: 0.05 });
  em.encode('a forgettable moment', { situation: 's', surprise: 0, selfRelevance: 0, salience: 0.2 });

  em.advance(2_000);
  assert.equal(em.size, 0, 'it should be gone');
  assert.ok(em.stats().forgotten >= 1);
});

test('episodic: step() reports which episodes were lost', () => {
  const em = new EpisodicMemory({ baseHalfLife: 10, forgetThreshold: 0.2 });
  em.encode('perishable', { situation: 's', surprise: 0, selfRelevance: 0, salience: 0.1 });

  const lost: string[] = [];
  for (let i = 0; i < 500 && lost.length === 0; i += 1) lost.push(...em.step());

  assert.equal(lost.length, 1);
});

test('episodic: a recently retrieved episode is not forgotten even at low strength', () => {
  // `forgetThreshold` is a floor on retrievability, so it must sit well below
  // a typical encoded strength. A threshold near the encoding strength would
  // mean "forget almost immediately", which is a misuse of the knob rather
  // than a property of the model.
  const em = new EpisodicMemory({ baseHalfLife: 20, forgetThreshold: 0.15 });
  const { id } = em.encode('barely held but just recalled', {
    situation: 'fragile',
    surprise: 0,
    selfRelevance: 0,
    salience: 0.1,
  });

  assert.ok(em.retrieve(id) !== undefined, 'it is retrievable while still fresh');
  assert.equal(em.size, 1);

  // Long enough for the trace to decay to a low strength, short enough to sit
  // inside the protection window that recall opened.
  em.advance(10);

  assert.equal(em.size, 1, 'recency of recall protects a weak memory inside its window');
});

test('episodic: an unrehearsed weak episode is dropped once past its window', () => {
  const em = new EpisodicMemory({ baseHalfLife: 10, forgetThreshold: 0.3 });
  em.encode('barely held and never revisited', {
    situation: 'fragile',
    surprise: 0,
    selfRelevance: 0,
    salience: 0.1,
  });

  em.advance(400);
  assert.equal(em.size, 0, 'nothing protects a weak memory that is never used');
});

test('episodic: a vivid episode outlives a dull one by a wide margin', () => {
  const dull = new EpisodicMemory({ baseHalfLife: 20, forgetThreshold: 0.05 });
  const vivid = new EpisodicMemory({ baseHalfLife: 20, forgetThreshold: 0.05 });

  // Different situations on purpose: identical situations plus similar short
  // text would make the second episode a continuation of the first.
  dull.encode('an ordinary uneventful hour', {
    situation: 'routine',
    surprise: 0,
    selfRelevance: 0,
    salience: 0.3,
  });
  vivid.encode('a shocking and personal event', {
    situation: 'crisis',
    surprise: 1,
    selfRelevance: 1,
    salience: 0.9,
  });

  assert.equal(dull.size, 1);
  assert.equal(vivid.size, 1);

  // Horizon chosen from measured behaviour, not from intuition. At these
  // settings the uneventful hour is gone by tick ~21 while the shocking
  // personal event survives to ~289, so tick 200 is comfortably inside the
  // window where the asymmetry is unambiguous.
  dull.advance(200);
  vivid.advance(200);

  assert.equal(dull.size, 0, 'the uneventful hour has faded');
  assert.equal(vivid.size, 1, 'the shocking personal event is still there');
});

test('episodic: significance buys an order-of-magnitude retention advantage', () => {
  const survive = (surprise: number, selfRelevance: number, salience: number): number => {
    const em = new EpisodicMemory({ baseHalfLife: 20, forgetThreshold: 0.05 });
    em.encode('an event of some kind', { situation: 'observed', surprise, selfRelevance, salience });
    for (let t = 1; t <= 100_000; t += 1) {
      em.step();
      if (em.size === 0) return t;
    }
    return Number.POSITIVE_INFINITY;
  };

  const forgettable = survive(0, 0, 0.2);
  const memorable = survive(1, 1, 0.9);

  assert.ok(Number.isFinite(forgettable), 'the forgettable event does eventually go');
  assert.ok(
    memorable > forgettable * 5,
    `measured: forgettable ${forgettable}, memorable ${memorable} ticks`,
  );
});

test('episodic: forget() removes one episode and reports success', () => {
  const em = new EpisodicMemory();
  const { id } = em.encode('to be erased', { situation: 's' });

  assert.equal(em.forget(id), true);
  assert.equal(em.forget(id), false);
  assert.equal(em.size, 0);
});

// ── Capacity and integrity ──────────────────────────────────────────────────

test('episodic: at capacity the least significant episode is shed, not the oldest', () => {
  const em = new EpisodicMemory({ capacity: 3, baseHalfLife: 1_000 });

  em.encode('crucial turning point', { situation: 's', surprise: 1, selfRelevance: 1, salience: 1 });
  em.encode('filler one', { situation: 's', surprise: 0, selfRelevance: 0, salience: 0.1 });
  em.encode('filler two', { situation: 's', surprise: 0, selfRelevance: 0, salience: 0.1 });
  em.encode('filler three', { situation: 's', surprise: 0, selfRelevance: 0, salience: 0.1 });

  assert.ok(em.size <= 3);
  const contents = em.all().map((e) => e.content);
  assert.ok(contents.includes('crucial turning point'), `the important episode survived: ${contents.join(' | ')}`);
});

test('episodic: check() reports no problems in normal operation', () => {
  const em = new EpisodicMemory();
  for (let i = 0; i < 20; i += 1) {
    em.encode(`event ${i} in a sequence of events`, { situation: 's', surprise: i / 20 });
    em.advance(2);
  }
  em.retrieve(em.latest()?.id ?? '');
  assert.deepEqual(em.check(), []);
});

test('episodic: clear() resets state and counters', () => {
  const em = new EpisodicMemory();
  em.encode('something', { situation: 's' });
  em.advance(3);
  em.clear();

  assert.equal(em.size, 0);
  assert.equal(em.tick, 0);
  assert.equal(em.stats().encoded, 0);
  assert.equal(em.latest(), undefined);
});

test('episodic: advance rejects non-positive counts', () => {
  const em = new EpisodicMemory();
  assert.throws(() => em.advance(0), RangeError);
  assert.throws(() => em.advance(-1), RangeError);
});

test('episodic: emitted views are frozen against caller mutation', () => {
  const em = new EpisodicMemory();
  const { id } = em.encode('immutable recollection', { situation: 's', context: { a: 1 } });
  const episode = em.get(id);

  assert.ok(episode !== undefined);
  assert.equal(Object.isFrozen(episode), true);
  assert.equal(Object.isFrozen(episode.context), true);
  assert.throws(() => {
    (episode as { content: string }).content = 'tampered';
  }, TypeError);
});

test('episodic: stats are internally consistent across a busy session', () => {
  const em = new EpisodicMemory({ capacity: 100 });
  for (let i = 0; i < 30; i += 1) {
    em.encode(`distinct occurrence ${i} of the phenomenon`, { situation: `phase${i % 3}`, surprise: (i % 10) / 10 });
    em.advance(3);
  }
  const id = em.latest()?.id;
  if (id !== undefined) em.retrieve(id, { context: { noted: true } });

  const stats = em.stats();
  assert.equal(stats.count, em.size);
  assert.equal(stats.encoded, 30);
  assert.ok(stats.recalled >= 0);
  assert.ok(stats.reconsolidated <= stats.encoded);
  assert.ok(stats.meanStrength >= 0 && stats.meanStrength <= 1);
  assert.ok(stats.meanSurprise >= 0 && stats.meanSurprise <= 1);
  assert.deepEqual(em.check(), []);
});
