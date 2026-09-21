/**
 * LOGOS :: Memory :: Working memory tests
 * ---------------------------------------------------------------------------
 * Each test here pins down one of the mechanisms the architecture claims to
 * have. If the claims in the file header of `working.ts` are not testable,
 * they are marketing rather than engineering.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkingMemory } from '../src/memory/working.ts';
import { RunningMean, decayFactor, reinforcementGain, affectMagnitude } from '../src/memory/types.ts';
import {
  VectorIndex,
  blendedSimilarity,
  cosine,
  embed,
  jaccard,
  normalise,
  similarity,
  tokenize,
} from '../src/memory/vector.ts';
import { LogosError, tick as mkTick } from '../src/kernel/types.ts';

// ── Vector utilities ────────────────────────────────────────────────────────

test('vector: tokenize drops stopwords and splits on punctuation', () => {
  const tokens = tokenize('The quick brown fox, and the lazy dog!');
  assert.ok(tokens.includes('quick'));
  assert.ok(tokens.includes('brown'));
  assert.ok(!tokens.includes('the'), 'stopwords are removed');
  assert.ok(!tokens.includes('and'));
});

test('vector: tokenize handles CJK with bigrams', () => {
  const tokens = tokenize('认知架构');
  assert.deepEqual(tokens, ['认知', '知架', '架构'], 'bigrams plus no short-run fallback for length 4');
});

test('vector: tokenize gives short CJK runs their whole form too', () => {
  const tokens = tokenize('记忆');
  assert.deepEqual(tokens, ['记忆'], 'the bigram and the whole run coincide and are deduplicated');
});

test('vector: stem folds inflectional variants of one root together', () => {
  const fold = (...words: string[]): string[] => words.map((w) => tokenize(w)[0] ?? '');

  const [structural, structurally] = fold('structural', 'structurally');
  assert.equal(structural, structurally, 'adverb folds onto its adjective');

  assert.deepEqual(fold('bridge'), fold('bridges'), 'plural folds to singular');
  assert.deepEqual(fold('walk'), fold('walking'), 'gerund folds to base');
  assert.deepEqual(fold('class'), fold('classes'), 'sibilant stem takes the whole -es');
  assert.deepEqual(fold('process'), fold('processes'), 'processes must not become processe');
  assert.deepEqual(fold('create'), fold('created'), 'silent-e stems are restored');
  assert.deepEqual(fold('memory'), fold('memories'), 'y-plural folds');
  assert.deepEqual(fold('stop'), fold('stopping'), 'doubled consonant folds');
});

test('vector: stemming does not merge derivational forms — they are not variants', () => {
  // Deliberate scope limit. "structure" and "structural" are different words
  // that share a root; folding them together would create false associations,
  // which is worse than missing a link.
  const [structure, structural] = ['structure', 'structural'].map((w) => tokenize(w)[0] ?? '');
  assert.notEqual(structure, structural, 'derivation is out of scope for this stemmer');
});

test('vector: stemming does not destroy short unrelated words', () => {
  // A stemmer that is too aggressive is worse than none: it invents matches.
  assert.notDeepEqual(tokenize('bus'), tokenize('bu'));
  assert.notDeepEqual(tokenize('gas'), tokenize('ga'));
  assert.equal(tokenize('bus')[0], 'bus', 'short words are left alone');
});

test('vector: stemming produces no false convergences across word groups', () => {
  const groups: readonly (readonly string[])[] = [
    ['structural', 'structurally'],
    ['bridge', 'bridges'],
    ['walk', 'walking', 'walks'],
    ['class', 'classes'],
    ['process', 'processes'],
    ['stop', 'stopping', 'stopped'],
    ['run', 'running'],
    ['memory', 'memories'],
    ['fly', 'flies'],
    ['create', 'created', 'creating'],
    ['write', 'writing'],
    ['decide', 'decided'],
  ];

  const owner = new Map<string, string>();
  for (const group of groups) {
    const stems = new Set(group.map((w) => tokenize(w)[0] ?? ''));
    assert.equal(stems.size, 1, `${group.join('/')} should fold to one stem, got ${[...stems].join(' / ')}`);

    for (const word of group) {
      const s = tokenize(word)[0] ?? '';
      const previous = owner.get(s);
      if (previous !== undefined) {
        assert.ok(
          group.includes(previous),
          `stem "${s}" is shared by unrelated words "${previous}" and "${word}"`,
        );
      } else {
        owner.set(s, word);
      }
    }
  }
});

test('vector: embed is deterministic and normalised', () => {
  const a = embed('the cat sat on the mat');
  const b = embed('the cat sat on the mat');
  assert.deepEqual([...a.entries()], [...b.entries()]);

  let sumSquares = 0;
  for (const v of a.values()) sumSquares += v * v;
  assert.ok(Math.abs(sumSquares - 1) < 1e-9, 'L2 norm should be 1');
});

test('vector: empty text yields an empty vector rather than throwing', () => {
  assert.equal(embed('').size, 0);
  assert.equal(embed('   ').size, 0);
});

test('vector: tokenize rejects non-strings', () => {
  assert.throws(() => tokenize(42 as never), LogosError);
});

test('vector: cosine self-similarity is 1 and range is respected', () => {
  const v = embed('memory and cognition');
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9);

  const w = embed('completely different subject matter about weather');
  assert.ok(cosine(v, w) <= 1 + 1e-9);
  assert.ok(cosine(v, w) >= -1 - 1e-9);
  assert.ok(similarity(v, w) >= 0 && similarity(v, w) <= 1);
});

test('vector: related text scores above unrelated text', () => {
  const query = embed('layered memory architecture');
  const related = embed('the memory layer stores traces in tiers');
  const unrelated = embed('a recipe for sourdough bread');

  assert.ok(
    similarity(query, related) > similarity(query, unrelated),
    'semantic ordering must survive the hashing trick',
  );
});

test('vector: jaccard is exact set overlap', () => {
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccard(['a', 'b'], ['c', 'd']), 0);
  assert.ok(Math.abs(jaccard(['a', 'b'], ['b', 'c']) - 1 / 3) < 1e-9);
});

test('vector: blended similarity rewards shared vocabulary over bucket luck', () => {
  const shared = blendedSimilarity(embed('alpha beta gamma'), tokenize('alpha beta gamma'), embed('alpha beta gamma'), tokenize('alpha beta gamma'));
  assert.ok(shared > 0.95, `identical text should score near 1, got ${shared}`);
});

test('vector: normalise leaves an all-zero vector alone instead of dividing by zero', () => {
  const zero = new Map<number, number>([[1, 0], [2, 0]]);
  const result = normalise(zero);
  assert.equal(result.get(1), 0);
});

test('vector: index returns nearest neighbours in order', () => {
  const index = new VectorIndex<{ label: string }>(512);
  index.set('a', { label: 'cats' }, embed('cats and kittens are felines'));
  index.set('b', { label: 'dogs' }, embed('dogs and puppies are canines'));
  index.set('c', { label: 'bread' }, embed('sourdough bread needs a starter'));

  const hits = index.nearest('feline kittens', 3);
  assert.equal(hits[0]?.key, 'a');
  assert.ok(hits.length === 3);
  assert.ok((hits[0]?.score ?? 0) >= (hits[1]?.score ?? 0), 'sorted descending');
});

test('vector: index delete and size behave', () => {
  const index = new VectorIndex<string>();
  index.set('x', 'value');
  assert.equal(index.size, 1);
  assert.equal(index.get('x'), 'value');
  assert.equal(index.delete('x'), true);
  assert.equal(index.size, 0);
  assert.equal(index.get('x'), undefined);
});

// ── Decay and reinforcement maths ───────────────────────────────────────────

test('decay: half-life is actually a half-life', () => {
  assert.equal(decayFactor(0, 10), 1);
  assert.ok(Math.abs(decayFactor(10, 10) - 0.5) < 1e-12);
  assert.ok(Math.abs(decayFactor(20, 10) - 0.25) < 1e-12);
  assert.equal(decayFactor(5, 0), 0, 'zero half-life means instant forgetting');
});

test('reinforcement: gain diminishes but never reaches zero', () => {
  const g0 = reinforcementGain(0);
  const g1 = reinforcementGain(1);
  const g9 = reinforcementGain(9);
  const g99 = reinforcementGain(99);

  assert.ok(g0 > g1 && g1 > g9 && g9 > g99, 'strictly diminishing');
  assert.ok(g99 > 0, 'never zero — nothing becomes unlearnable');
});

test('running mean: incremental update matches the batch mean', () => {
  const samples = [3, 7, 11, 19, 2];
  const mean = new RunningMean();
  for (const s of samples) mean.push(s);
  const expected = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert.ok(Math.abs(mean.value - expected) < 1e-12);
  assert.equal(mean.count, samples.length);
});

test('running mean: weighted samples shift the mean proportionally', () => {
  const mean = new RunningMean(0);
  mean.push(10, 1);
  mean.push(20, 1);
  assert.ok(Math.abs(mean.value - 15) < 1e-12);

  const skewed = new RunningMean(0);
  skewed.push(0, 1);
  skewed.push(100, 9);
  assert.ok(Math.abs(skewed.value - 90) < 1e-12, `got ${skewed.value}`);
});

test('affect: magnitude grows with both valence and arousal', () => {
  assert.equal(affectMagnitude({ valence: 0, arousal: 0 }), 0);
  assert.ok(affectMagnitude({ valence: 1, arousal: 0 }) > 0);
  assert.ok(affectMagnitude({ valence: 1, arousal: 1 }) > affectMagnitude({ valence: 1, arousal: 0 }));
  assert.ok(
    Math.abs(affectMagnitude({ valence: 1, arousal: 0 }) - affectMagnitude({ valence: -1, arousal: 0 })) < 1e-12,
    'direction does not matter, only intensity',
  );
});

// ── Working memory: capacity ────────────────────────────────────────────────

test('working memory: capacity is a hard limit', () => {
  const wm = new WorkingMemory({ capacity: 3 });

  for (let i = 0; i < 10; i += 1) {
    wm.encode(`distinct thought number ${i} about ${['ocean', 'mountain', 'desert', 'forest', 'city'][i % 5]}`, {
      salience: 0.9,
    });
  }

  assert.ok(wm.size <= 3, `held ${wm.size} of 3 slots`);
  assert.deepEqual(wm.check(), []);
});

test('working memory: a stronger item displaces a weaker one', () => {
  const wm = new WorkingMemory({ capacity: 2, dedupeThreshold: 0.95 });
  wm.encode('weak transient observation about weather', { salience: 0.31 });
  wm.encode('another weak observation about traffic', { salience: 0.31 });

  const before = wm.size;
  const result = wm.encode('overwhelmingly important realisation about the goal', { salience: 1, confidence: 1 });

  assert.equal(before, 2);
  assert.equal(result.admitted, true);
  assert.equal(result.evicted.length, 1, 'something had to give');
  assert.ok(wm.size <= 2);
});

test('working memory: low-salience content is refused, not stored then dropped', () => {
  const wm = new WorkingMemory({ capacity: 5, admitThreshold: 0.5 });
  const result = wm.encode('barely noticeable background noise', { salience: 0.01, confidence: 0.05 });

  assert.equal(result.admitted, false);
  assert.equal(wm.size, 0);
  assert.equal(wm.stats().refused, 1);
});

test('working memory: at capacity, a weaker newcomer is refused rather than evicting', () => {
  const wm = new WorkingMemory({ capacity: 2, dedupeThreshold: 0.98, admitThreshold: 0.2, salienceGain: 12 });
  wm.encode('critical goal state alpha', { salience: 1, confidence: 1 });
  wm.encode('critical goal state beta', { salience: 1, confidence: 1 });

  const sizeBefore = wm.size;
  const result = wm.encode('marginal detail delta', { salience: 0.25, confidence: 0.5 });

  assert.equal(result.admitted, false, 'a full mind rejects trivia instead of forgetting what matters');
  assert.equal(wm.size, sizeBefore);
});

// ── Working memory: rehearsal and decay ─────────────────────────────────────

test('working memory: identical content reinforces rather than duplicating', () => {
  const wm = new WorkingMemory({ capacity: 5 });
  const first = wm.encode('the meeting is scheduled for three o clock', { salience: 0.8 });
  const second = wm.encode('the meeting is scheduled for three o clock', { salience: 0.8 });

  assert.equal(first.reinforced, false);
  assert.equal(second.reinforced, true);
  assert.equal(second.id, first.id, 'the same thought is one slot');
  assert.equal(wm.size, 1, 'not two slots');
  assert.equal(wm.stats().reinforced, 1);
});

test('working memory: rehearsal raises activation', () => {
  const wm = new WorkingMemory({ capacity: 3 });
  const { id } = wm.encode('a fact worth remembering', { salience: 0.6 });
  const before = wm.activationOf(id) ?? 0;

  wm.encode('a fact worth remembering', { salience: 0.6 });
  const after = wm.activationOf(id) ?? 0;

  assert.ok(after > before, `activation should rise: ${before} -> ${after}`);
});

test('working memory: rehearsal lengthens the half-life (the spacing effect)', () => {
  const wm = new WorkingMemory({ capacity: 3 });
  const { id } = wm.encode('durable knowledge', { salience: 0.6 });
  const fresh = wm.get(id, { reinforce: false });

  for (let i = 0; i < 8; i += 1) wm.encode('durable knowledge', { salience: 0.6 });
  const rehearsed = wm.get(id, { reinforce: false });

  assert.ok(fresh !== undefined && rehearsed !== undefined);
  assert.ok(
    rehearsed.halfLife > fresh.halfLife,
    `rehearsed half-life ${rehearsed.halfLife} should exceed fresh ${fresh.halfLife}`,
  );
  assert.ok(rehearsed.accessCount > fresh.accessCount);
});

test('working memory: unrehearsed content decays away', () => {
  const wm = new WorkingMemory({ capacity: 5, baseHalfLife: 4, retainThreshold: 0.2 });
  wm.encode('a fleeting impression', { salience: 0.4 });

  assert.equal(wm.size, 1);
  wm.advance(200);

  assert.equal(wm.size, 0, 'it should be gone');
  assert.equal(wm.stats().evicted, 1);
});

test('working memory: rehearsal keeps content alive that would otherwise decay', () => {
  const fresh = new WorkingMemory({ capacity: 3, baseHalfLife: 4, retainThreshold: 0.2 });
  const kept = new WorkingMemory({ capacity: 3, baseHalfLife: 4, retainThreshold: 0.2 });

  fresh.encode('a fact', { salience: 0.5 });
  kept.encode('a fact', { salience: 0.5 });

  for (let i = 0; i < 60; i += 1) {
    fresh.step();
    kept.step();
    if (i % 3 === 0) kept.encode('a fact', { salience: 0.5 });
  }

  assert.equal(fresh.size, 0, 'the unrehearsed trace is gone');
  assert.equal(kept.size, 1, 'the rehearsed trace survives');
});

test('working memory: step reports what was lost', () => {
  const wm = new WorkingMemory({ capacity: 5, baseHalfLife: 3, retainThreshold: 0.2 });
  wm.encode('soon to be forgotten', { salience: 0.4 });

  let losses: readonly { content: string }[] = [];
  for (let i = 0; i < 100 && losses.length === 0; i += 1) losses = wm.step();

  assert.equal(losses.length, 1);
  assert.match(losses[0]?.content ?? '', /forgotten/);
});

test('working memory: advance rejects non-positive counts', () => {
  const wm = new WorkingMemory();
  assert.throws(() => wm.advance(0), RangeError);
  assert.throws(() => wm.advance(-2), RangeError);
});

// ── Working memory: attention ───────────────────────────────────────────────

test('working memory: priming raises activation of matching content', () => {
  const wm = new WorkingMemory({ capacity: 5 });
  const target = wm.encode('the bridge is structurally unsound', { salience: 0.5 });
  wm.encode('lunch is at noon in the canteen', { salience: 0.5 });

  const before = wm.activationOf(target.id) ?? 0;
  wm.prime('structural integrity of bridges', 1);
  const after = wm.activationOf(target.id) ?? 0;

  assert.ok(after > before, `priming should help: ${before} -> ${after}`);
});

test('working memory: priming is reversible', () => {
  const wm = new WorkingMemory({ capacity: 5 });
  wm.encode('the bridge is structurally unsound', { salience: 0.5 });
  wm.encode('lunch is at noon in the canteen', { salience: 0.5 });

  const unprime = wm.prime('structural integrity of the bridge', 1);
  assert.equal(wm.primings().length, 1, 'priming is registered');
  assert.ok(wm.primings()[0]?.text.includes('integrity'));

  unprime();
  assert.equal(wm.primings().length, 0, 'priming is released');

  // Releasing is idempotent: a double release must not corrupt state.
  assert.doesNotThrow(() => unprime());
  assert.equal(wm.primings().length, 0);
});

test('working memory: priming is lexical, not semantic — and says so', () => {
  const wm = new WorkingMemory({ capacity: 5 });
  wm.encode('the bridge is structurally unsound', { salience: 0.5 });
  wm.encode('lunch is at noon in the canteen', { salience: 0.5 });

  // A synonym with no shared vocabulary. The hashing-trick embedding cannot
  // bridge this, so priming on it must NOT be expected to work. Pinning the
  // limitation down as a test means a future real embedding model will show
  // up here as a deliberate change rather than a silent behavioural drift.
  wm.prime('viaduct stability concerns', 1);

  const target = wm.contents().find((c) => c.content.includes('bridge'));
  assert.ok(target !== undefined);
  assert.ok(
    target.activation < 0.75,
    'with no shared tokens, priming gives no material boost — this is the documented limit of the vector channel',
  );
});

test('working memory: priming makes matching content win the attentional competition', () => {
  const wm = new WorkingMemory({ capacity: 5, dedupeThreshold: 0.99 });
  wm.encode('the bridge is structurally unsound', { salience: 0.5, confidence: 1 });
  wm.encode('lunch is at noon in the canteen', { salience: 0.5, confidence: 1 });

  const winnerBefore = wm.contents()[0]?.content ?? '';
  wm.prime('structural integrity of the bridge', 1);
  const winnerAfter = wm.contents()[0]?.content ?? '';

  assert.ok(
    winnerAfter.includes('bridge'),
    `primed content should take the focus; winner was "${winnerAfter}" (before: "${winnerBefore}")`,
  );
});

test('working memory: similar thoughts suppress each other', () => {
  const wm = new WorkingMemory({ capacity: 5, dedupeThreshold: 0.99 });

  // Two near-identical but not identical thoughts compete.
  wm.encode('the train departs at nine in the morning', { salience: 0.9, confidence: 1 });
  wm.encode('the train departs at nine in the evening', { salience: 0.6, confidence: 1 });

  const contents = wm.contents();
  const winner = contents[0];
  const loser = contents[1];

  assert.ok(winner !== undefined && loser !== undefined);
  assert.ok(winner.activation > loser.activation, 'a winner emerged');
});

test('working memory: focus is non-empty when content is held and empty when not', () => {
  const wm = new WorkingMemory({ capacity: 4 });
  assert.deepEqual(wm.focus, []);

  wm.encode('something worth attending to', { salience: 0.8 });
  assert.ok(wm.focus.length >= 1);
  assert.equal(wm.focused().length, wm.focus.length);
});

test('working memory: focus never exceeds half of capacity plus one', () => {
  const wm = new WorkingMemory({ capacity: 6, dedupeThreshold: 0.99 });
  for (let i = 0; i < 6; i += 1) {
    wm.encode(`unrelated topic ${i} concerning ${['geology', 'music', 'law', 'cooking', 'sailing', 'poetry'][i]}`, {
      salience: 0.9,
    });
  }
  assert.ok(wm.focus.length <= Math.ceil(6 / 2), `focus was ${wm.focus.length}`);
});

test('working memory: primed content survives decay that would otherwise remove it', () => {
  const plain = new WorkingMemory({ capacity: 3, baseHalfLife: 5, retainThreshold: 0.15 });
  const primed = new WorkingMemory({ capacity: 3, baseHalfLife: 5, retainThreshold: 0.15 });

  plain.encode('a detail about the mission', { salience: 0.5 });
  primed.encode('a detail about the mission', { salience: 0.5 });
  primed.prime('the mission', 1);

  plain.advance(12);
  primed.advance(12);

  const plainActivation = plain.contents()[0]?.activation ?? 0;
  const primedActivation = primed.contents()[0]?.activation ?? 0;
  assert.ok(primedActivation > plainActivation, `primed ${primedActivation} vs plain ${plainActivation}`);
});

// ── Working memory: persistence and integrity ───────────────────────────────

test('working memory: snapshot and restore round-trip held content', () => {
  const wm = new WorkingMemory({ capacity: 4 });
  wm.encode('first remembered item', { salience: 0.8 });
  wm.encode('second remembered item', { salience: 0.7 });
  wm.advance(2);

  const snap = wm.snapshot();
  const restored = new WorkingMemory({ capacity: 4 });
  restored.restore(snap);

  const original = wm.contents().map((c) => c.content);
  const revived = restored.contents().map((c) => c.content);
  assert.deepEqual(revived, original);
  assert.deepEqual(restored.check(), []);
});

test('working memory: snapshot is JSON-serialisable', () => {
  const wm = new WorkingMemory();
  wm.encode('serialisable thought', { salience: 0.8 });
  assert.doesNotThrow(() => JSON.stringify(wm.snapshot()));
});

test('working memory: forget() removes a specific slot and logs why', () => {
  const wm = new WorkingMemory();
  const { id } = wm.encode('deliberately discarded', { salience: 0.8 });

  const record = wm.forget(id, 'displaced');
  assert.equal(record?.content, 'deliberately discarded');
  assert.equal(wm.has(id), false);
  assert.equal(wm.forget('nonexistent'), undefined);
});

test('working memory: get() reinforces by default but can be read-only', () => {
  const wm = new WorkingMemory();
  const { id } = wm.encode('a retrievable fact', { salience: 0.5 });

  const passive = wm.get(id, { reinforce: false });
  const active = wm.get(id);

  assert.ok(passive !== undefined && active !== undefined);
  assert.ok(active.accessCount > passive.accessCount, 'active retrieval is practice');
});

test('working memory: encoding empty content is refused loudly', () => {
  const wm = new WorkingMemory();
  assert.throws(() => wm.encode(''), LogosError);
  assert.throws(() => wm.encode('   '), LogosError);
});

test('working memory: clear() empties every structure', () => {
  const wm = new WorkingMemory();
  wm.encode('something', { salience: 0.9 });
  wm.prime('something');
  wm.clear();

  assert.equal(wm.size, 0);
  assert.deepEqual(wm.focus, []);
  assert.equal(wm.primings().length, 0);
  assert.deepEqual(wm.evictionLog(), []);
});

test('working memory: eviction log is bounded', () => {
  const wm = new WorkingMemory({ capacity: 1, dedupeThreshold: 0.99, admitThreshold: 0.1, salienceGain: 20 });
  for (let i = 0; i < 200; i += 1) {
    wm.encode(`item ${i} ${'x'.repeat(i % 7)}`, { salience: 1, confidence: 1 });
  }
  assert.ok(wm.evictionLog().length <= 64, `log held ${wm.evictionLog().length}`);
});

test('working memory: stats satisfy their accounting identity', () => {
  const wm = new WorkingMemory({ capacity: 3 });
  const results = [
    wm.encode('alpha content here', { salience: 0.9 }),
    wm.encode('beta content here', { salience: 0.8 }),
    wm.encode('alpha content here', { salience: 0.9 }), // reinforces the first
  ];

  const stats = wm.stats();
  assert.equal(stats.capacity, 3);
  assert.equal(stats.occupied, wm.size);
  assert.equal(stats.encoded, 2, '`encoded` counts NEW slots created, not encode calls');
  assert.equal(stats.reinforced, 1, 'a repeat of held content is a rehearsal, not an encoding');
  assert.equal(stats.refused, 0);

  // The identity every caller can rely on.
  const admitted = results.filter((r) => r.admitted).length;
  assert.equal(
    admitted,
    stats.encoded + stats.reinforced,
    'every admitted encode either created a slot or reinforced one',
  );
  assert.equal(results.length, stats.encoded + stats.reinforced + stats.refused);

  assert.ok(stats.meanActivation > 0 && stats.meanActivation <= 1);
  assert.ok(stats.meanHalfLife > 0);
});

test('working memory: pressure reflects how full attention is', () => {
  const wm = new WorkingMemory({ capacity: 4, dedupeThreshold: 0.99 });
  assert.equal(wm.pressure, 0);
  wm.encode('one', { salience: 0.9 });
  assert.ok(Math.abs(wm.pressure - 0.25) < 1e-9);
});

test('working memory: logical time is tracked and monotonic', () => {
  const wm = new WorkingMemory();
  assert.equal(wm.tick, 0);
  wm.step();
  wm.step();
  assert.equal(wm.tick, 2);
  assert.equal(mkTick(2), 2);
});
