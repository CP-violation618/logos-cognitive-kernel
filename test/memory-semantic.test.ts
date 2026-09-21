/**
 * LOGOS :: Memory :: Semantic memory tests
 * ---------------------------------------------------------------------------
 * The claim under test is that concepts are CONSTRUCTED: grounding promotes
 * confidence, disagreement is preserved rather than flattened, and
 * associations are traversable rather than declared.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SemanticMemory } from '../src/memory/semantic.ts';
import { LogosError } from '../src/kernel/types.ts';

// ── Formation ───────────────────────────────────────────────────────────────

test('semantic: an observation forms a concept', () => {
  const sm = new SemanticMemory();
  const result = sm.observe({
    label: 'photosynthesis',
    definition: 'the process by which plants convert light into chemical energy',
    categories: ['biological-process'],
    sourceEpisode: 'ep1',
  });

  assert.equal(result.created, true);
  const concept = sm.get('photosynthesis');
  assert.ok(concept !== undefined);
  assert.equal(concept.label, 'photosynthesis');
  assert.equal(concept.grounding, 1);
  assert.deepEqual(concept.categories, ['biological-process']);
});

test('semantic: a repeated label merges rather than duplicating', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'gravity', definition: 'mutual attraction between masses', sourceEpisode: 'ep1' });
  const second = sm.observe({ label: 'gravity', definition: 'a force pulling objects together', sourceEpisode: 'ep2' });

  assert.equal(second.created, false);
  assert.equal(sm.size, 1);
  assert.equal(sm.get('gravity')?.grounding, 2);
});

test('semantic: observing the SAME episode twice does not inflate grounding', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'entropy', sourceEpisode: 'ep1' });
  sm.observe({ label: 'entropy', sourceEpisode: 'ep1' });
  sm.observe({ label: 'entropy', sourceEpisode: 'ep1' });

  // Grounding counts distinct sources, not observations. Otherwise a mind
  // would become wildly confident about whatever it happened to be looking at.
  assert.equal(sm.get('entropy')?.grounding, 1, 'repeated observation of one episode is one piece of evidence');
  assert.equal(sm.stats().observations, 3);
});

test('semantic: label matching is case-insensitive and does not create aliases', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'car', definition: 'a road vehicle', sourceEpisode: 'ep1' });
  const second = sm.observe({ label: 'Car', sourceEpisode: 'ep2' });

  assert.equal(second.created, false);
  assert.equal(sm.size, 1);
  assert.deepEqual(sm.get('car')?.aliases, [], 'a capitalisation difference is the same word, not a synonym');
  assert.equal(sm.has('CAR'), true, 'lookup is case-insensitive');
});

test('semantic: a differently phrased label merges and is recorded as an alias', () => {
  const sm = new SemanticMemory({ mergeThreshold: 0.5 });
  sm.observe({ label: 'the river Thames', definition: 'a river in southern England', sourceEpisode: 'ep1' });
  const second = sm.observe({ label: 'river Thames', sourceEpisode: 'ep2' });

  assert.equal(second.created, false, 'a shared description is enough to merge');
  assert.equal(sm.size, 1);
  assert.equal(sm.get('river Thames')?.label, 'the river Thames', 'the alias resolves to the concept');
});

test('semantic: synonyms with no shared vocabulary do NOT merge — a documented limit', () => {
  // "automobile" and "motorcar" have zero token overlap. The hashing-trick
  // embedding cannot know they are synonyms, so their blended similarity sits
  // at the no-overlap baseline and they stay separate concepts.
  //
  // This is a real limit of a zero-dependency lexical embedding, and pinning
  // it down here means swapping in a genuine semantic model later shows up as
  // a deliberate behavioural change rather than silent drift.
  const sm = new SemanticMemory({ mergeThreshold: 0.5 });
  sm.observe({ label: 'automobile', sourceEpisode: 'ep1' });
  sm.observe({ label: 'motorcar', sourceEpisode: 'ep2' });

  assert.equal(sm.size, 2, 'no vocabulary in common means no merge');
});

test('semantic: an identical definition DOES merge, whatever the labels are', () => {
  // Merge decisions consider label and definition together. Two different
  // words attached to the same description are very likely the same thing, and
  // the vector channel can see that even when it cannot see the synonymy.
  const sm = new SemanticMemory({ mergeThreshold: 0.5 });
  sm.observe({ label: 'automobile', definition: 'a four wheeled road vehicle', sourceEpisode: 'ep1' });
  const second = sm.observe({ label: 'motorcar', definition: 'a four wheeled road vehicle', sourceEpisode: 'ep2' });

  assert.equal(second.created, false, 'the shared description identifies the referent');
  assert.equal(sm.size, 1);
});

test('semantic: synonymy that the embedding cannot infer can be stated outright', () => {
  // The interface provides for what the embedding cannot discover: an explicit
  // alias is a claim by the caller, and claims are honoured directly.
  const sm = new SemanticMemory();
  sm.observe({
    label: 'automobile',
    definition: 'a road vehicle',
    aliases: ['motorcar', 'car'],
    sourceEpisode: 'ep1',
  });

  assert.equal(sm.size, 1);
  assert.equal(sm.get('motorcar')?.label, 'automobile', 'declared aliases resolve');
  assert.equal(sm.get('car')?.label, 'automobile');

  // And this is the important part: a later observation under the alias now
  // folds into the same concept instead of creating a rival one.
  const later = sm.observe({ label: 'motorcar', definition: 'a self-propelled vehicle', sourceEpisode: 'ep2' });
  assert.equal(later.created, false);
  assert.equal(sm.size, 1);
  assert.equal(sm.get('automobile')?.grounding, 2, 'the alias observation is genuine new evidence');
});

test('semantic: a semantically similar label merges without an exact match', () => {
  const sm = new SemanticMemory({ mergeThreshold: 0.5 });
  const first = sm.observe({
    label: 'the river Thames',
    definition: 'a river flowing through southern England',
    sourceEpisode: 'ep1',
  });
  const second = sm.observe({
    label: 'river Thames',
    definition: 'a river flowing through southern England',
    sourceEpisode: 'ep2',
  });

  assert.equal(second.created, false);
  assert.equal(second.mergedInto, first.id);
});

test('semantic: unrelated labels stay distinct', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'photosynthesis', definition: 'plants converting light to energy' });
  sm.observe({ label: 'bricklaying', definition: 'assembling walls from bricks and mortar' });
  assert.equal(sm.size, 2);
});

test('semantic: an empty label is refused', () => {
  const sm = new SemanticMemory();
  assert.throws(() => sm.observe({ label: '   ' }), LogosError);
});

// ── Grounding drives confidence ─────────────────────────────────────────────

test('semantic: a concept seen once is held less confidently than one seen many times', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'quark', definition: 'an elementary particle', sourceEpisode: 'ep1' });
  const once = sm.get('quark')?.confidence ?? 0;

  for (let i = 2; i <= 10; i += 1) {
    sm.observe({ label: 'quark', definition: 'an elementary particle', sourceEpisode: `ep${i}` });
  }
  const many = sm.get('quark')?.confidence ?? 0;

  assert.ok(many > once, `confidence should rise with grounding: ${once} -> ${many}`);
  assert.equal(sm.get('quark')?.grounding, 10);
});

test('semantic: grounding also makes a concept structurally more durable', () => {
  const build = (sources: number): SemanticMemory => {
    const sm = new SemanticMemory({ baseHalfLife: 100, forgetThreshold: 0.05 });
    for (let i = 1; i <= sources; i += 1) {
      sm.observe({ label: 'iron', definition: 'a metallic element', sourceEpisode: `ep${i}` });
    }
    return sm;
  };

  const grounded = build(8);
  const lonely = build(1);

  // Measured retention at these settings: a concept grounded in 8 distinct
  // episodes survives ~1800 ticks, one grounded in a single episode ~466. The
  // horizon below sits inside that gap so the comparison is unambiguous.
  const horizon = 900;
  grounded.advance(horizon);
  lonely.advance(horizon);

  const groundedStrength = grounded.get('iron')?.strength ?? 0;
  const lonelyStrength = lonely.get('iron')?.strength ?? 0;

  assert.ok(
    groundedStrength > lonelyStrength,
    `a well-grounded concept must outlast a lonely one at tick ${horizon}: ${groundedStrength} vs ${lonelyStrength}`,
  );
  assert.equal(lonely.size, 0, 'the single-source hypothesis has already faded');
  assert.equal(grounded.size, 1, 'the well-grounded concept is still held');
});

test('semantic: durability rises monotonically with the number of sources', () => {
  const survive = (sources: number): number => {
    const sm = new SemanticMemory({ baseHalfLife: 100, forgetThreshold: 0.05 });
    for (let i = 1; i <= sources; i += 1) {
      sm.observe({ label: 'iron', definition: 'a metallic element', sourceEpisode: `ep${i}` });
    }
    for (let t = 1; t <= 20_000; t += 1) {
      sm.step();
      if (sm.size === 0) return t;
    }
    return Number.POSITIVE_INFINITY;
  };

  const measured = [1, 2, 4, 8].map(survive);
  for (let i = 1; i < measured.length; i += 1) {
    assert.ok(
      (measured[i] as number) > (measured[i - 1] as number),
      `more sources must mean longer retention: ${JSON.stringify(measured)}`,
    );
  }
  assert.ok(
    (measured[3] as number) > (measured[0] as number) * 3,
    `enduring knowledge should outlast a rumour several times over: ${JSON.stringify(measured)}`,
  );
});

test('semantic: observing one episode repeatedly does not entrench a concept', () => {
  const repeated = new SemanticMemory({ baseHalfLife: 100, forgetThreshold: 0.05 });
  for (let i = 0; i < 8; i += 1) {
    repeated.observe({ label: 'echo', definition: 'the same source over and over', sourceEpisode: 'ep1' });
  }

  const concept = repeated.get('echo');
  assert.ok(concept !== undefined);
  assert.equal(concept.grounding, 1, 'one source is one piece of evidence however often it repeats');

  // It must decay like the single-observation hypothesis it is.
  repeated.advance(4_000);
  assert.equal(repeated.get('echo')?.strength ?? 0, 0, 'repetition without variety is not knowledge');
});

test('semantic: accumulated definitions add detail instead of overwriting', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'mitosis', definition: 'cell division producing two identical cells', sourceEpisode: 'ep1' });
  sm.observe({ label: 'mitosis', definition: 'a phase of the cell cycle', sourceEpisode: 'ep2' });

  const definition = sm.get('mitosis')?.definition ?? '';
  assert.match(definition, /identical cells/);
  assert.match(definition, /cell cycle/);
});

// ── Contested properties ────────────────────────────────────────────────────

test('semantic: a settled property resolves to its value', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'apple', properties: { colour: 'red' }, sourceEpisode: 'ep1' });
  sm.observe({ label: 'apple', properties: { colour: 'red' }, sourceEpisode: 'ep2' });

  const property = sm.property('apple', 'colour');
  assert.equal(property?.value, 'red');
  assert.equal(property?.contested, false);
  assert.equal(property?.support, 1);
});

test('semantic: disagreement is preserved and marked contested', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'apple', properties: { colour: 'red' }, sourceEpisode: 'ep1' });
  sm.observe({ label: 'apple', properties: { colour: 'green' }, sourceEpisode: 'ep2' });

  const property = sm.property('apple', 'colour');
  assert.equal(property?.contested, true, 'a mind that noticed the contradiction says so');
  assert.ok(['red', 'green'].includes(String(property?.value)));
  assert.equal(property?.support, 0.5, 'two equally supported values means no majority');
});

test('semantic: a clear majority resolves a contested property', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'swan', properties: { colour: 'white' }, sourceEpisode: 'ep1' });
  sm.observe({ label: 'swan', properties: { colour: 'white' }, sourceEpisode: 'ep2' });
  sm.observe({ label: 'swan', properties: { colour: 'white' }, sourceEpisode: 'ep3' });
  sm.observe({ label: 'swan', properties: { colour: 'black' }, sourceEpisode: 'ep4' });

  const property = sm.property('swan', 'colour');
  assert.equal(property?.value, 'white');
  assert.equal(property?.contested, false, 'three against one is not contested');
  assert.ok((property?.support ?? 0) > 0.7);
});

test('semantic: noticing a contradiction lowers confidence', () => {
  const consistent = new SemanticMemory();
  const contradicted = new SemanticMemory();

  for (let i = 1; i <= 4; i += 1) {
    consistent.observe({ label: 'gem', properties: { hardness: 'high' }, sourceEpisode: `ep${i}` });
    contradicted.observe({
      label: 'gem',
      properties: { hardness: i % 2 === 0 ? 'high' : 'low' },
      sourceEpisode: `ep${i}`,
    });
  }

  const a = consistent.get('gem')?.confidence ?? 0;
  const b = contradicted.get('gem')?.confidence ?? 0;
  assert.ok(b < a, `contradiction should reduce confidence: consistent ${a} vs contradicted ${b}`);
});

test('semantic: contested properties appear as such in the concept view', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'door', properties: { state: 'open' }, sourceEpisode: 'ep1' });
  sm.observe({ label: 'door', properties: { state: 'closed' }, sourceEpisode: 'ep2' });

  const properties = sm.get('door')?.properties ?? {};
  const state = properties.state as { value: string; contested: boolean; alternatives: string[] };
  assert.equal(state.contested, true);
  assert.equal(state.alternatives.length, 1);
});

test('semantic: find() can filter by exact property value', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'robin', properties: { class: 'bird' } });
  sm.observe({ label: 'salmon', properties: { class: 'fish' } });

  const birds = sm.find({ hasProperty: { class: 'bird' } });
  assert.equal(birds.length, 1);
  assert.equal(birds[0]?.concept.label, 'robin');
});

// ── Relations and spreading activation ─────────────────────────────────────

test('semantic: relations connect concepts and are retrievable both ways', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'doctor' });
  sm.observe({ label: 'hospital' });

  const edge = sm.relate('doctor', 'works-in', 'hospital', { weight: 0.9 });
  assert.ok(edge !== undefined);
  assert.equal(edge.weight, 0.9);

  assert.equal(sm.edgesFrom('doctor').length, 1);
  assert.equal(sm.edgesTo('hospital').length, 1);
  assert.equal(sm.edgeCount, 1);
});

test('semantic: relating an unknown concept returns undefined rather than throwing', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'known' });
  assert.equal(sm.relate('known', 'links-to', 'nonexistent'), undefined);
});

test('semantic: repeated relation assertions accumulate support', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'a' });
  sm.observe({ label: 'b' });

  const first = sm.relate('a', 'r', 'b', { weight: 0.1 });
  const second = sm.relate('a', 'r', 'b', { weight: 0.9 });
  const third = sm.relate('a', 'r', 'b', { weight: 0.9 });

  assert.equal(first?.support, 1);
  assert.equal(second?.support, 2);
  assert.equal(third?.support, 3);
  assert.ok((second?.confidence ?? 0) > (first?.confidence ?? 0), 'confidence grows with support');
  assert.ok((third?.weight ?? 0) > (first?.weight ?? 0));
});

test('semantic: spreading activation reaches associated concepts', () => {
  const sm = new SemanticMemory();
  for (const label of ['doctor', 'hospital', 'surgery', 'patient']) sm.observe({ label });

  sm.relate('doctor', 'works-in', 'hospital', { weight: 0.9, confidence: 0.9 });
  sm.relate('hospital', 'hosts', 'surgery', { weight: 0.8, confidence: 0.9 });
  sm.relate('hospital', 'treats', 'patient', { weight: 0.7, confidence: 0.9 });

  const associations = sm.spread(['doctor'], { depth: 2 });
  const labels = associations.map((a) => a.concept.label);

  assert.ok(labels.includes('hospital'), `direct association missing: ${labels.join(', ')}`);
  assert.ok(labels.includes('surgery'), `depth-2 association missing: ${labels.join(', ')}`);
  assert.ok(!labels.includes('doctor'), 'the seed is the question, not an answer');
});

test('semantic: activation attenuates with distance', () => {
  const sm = new SemanticMemory();
  for (const label of ['a', 'b', 'c', 'd']) sm.observe({ label });
  sm.relate('a', 'r', 'b', { weight: 1, confidence: 1 });
  sm.relate('b', 'r', 'c', { weight: 1, confidence: 1 });
  sm.relate('c', 'r', 'd', { weight: 1, confidence: 1 });

  const results = sm.spread(['a'], { depth: 3 });
  const byLabel = new Map(results.map((r) => [r.concept.label, r.activation]));

  assert.ok((byLabel.get('b') ?? 0) > (byLabel.get('c') ?? 0), 'closer concepts activate more');
  assert.ok((byLabel.get('c') ?? 0) > (byLabel.get('d') ?? 0));
});

test('semantic: activation does not immediately flow back to its source', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'x' });
  sm.observe({ label: 'y' });
  sm.relate('x', 'r', 'y', { weight: 1, confidence: 1 });
  sm.relate('y', 'r', 'x', { weight: 1, confidence: 1 });

  const results = sm.spread(['x'], { depth: 2 });
  assert.ok(!results.some((r) => r.concept.label === 'x'), 'no trivial echo back to the seed');
});

test('semantic: associations record the route they were reached by', () => {
  const sm = new SemanticMemory();
  for (const label of ['seed', 'middle', 'target']) sm.observe({ label });
  sm.relate('seed', 'r', 'middle', { weight: 0.9, confidence: 1 });
  sm.relate('middle', 'r', 'target', { weight: 0.9, confidence: 1 });

  const target = sm.spread(['seed'], { depth: 2 }).find((a) => a.concept.label === 'target');
  assert.ok(target !== undefined);
  assert.deepEqual(target.path, ['seed', 'middle', 'target'], 'the route is auditable');
  assert.equal(target.depth, 2);
});

test('semantic: spreading from an unknown seed yields nothing rather than throwing', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'known' });
  assert.deepEqual(sm.spread(['unknown']), []);
});

test('semantic: fan-out bounds how many edges are traversed per node', () => {
  const sm = new SemanticMemory({ fanOut: 2 });
  sm.observe({ label: 'hub' });
  for (let i = 0; i < 8; i += 1) {
    sm.observe({ label: `spoke${i}` });
    sm.relate('hub', 'r', `spoke${i}`, { weight: 1 - i * 0.1, confidence: 1 });
  }

  const results = sm.spread(['hub'], { depth: 1, limit: 50 });
  assert.ok(results.length <= 2, `fanOut should cap traversal, got ${results.length}`);
});

// ── Retrieval ───────────────────────────────────────────────────────────────

test('semantic: find ranks by similarity', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'volcano', definition: 'a mountain that erupts molten rock' });
  sm.observe({ label: 'abacus', definition: 'a counting frame with sliding beads' });

  const hits = sm.find({ text: 'mountain erupting molten rock' });
  assert.equal(hits[0]?.concept.label, 'volcano');
});

test('semantic: grounding breaks ties in ranking', () => {
  const sm = new SemanticMemory({ mergeThreshold: 0.99 });
  sm.observe({ label: 'alpha', definition: 'a shared descriptive phrase' });
  sm.observe({ label: 'beta', definition: 'a shared descriptive phrase' });
  for (let i = 1; i <= 6; i += 1) {
    sm.observe({ label: 'beta', definition: 'a shared descriptive phrase', sourceEpisode: `ep${i}` });
  }

  const hits = sm.find({ text: 'a shared descriptive phrase' });
  assert.equal(hits[0]?.concept.label, 'beta', 'the better-grounded concept wins at equal similarity');
});

test('semantic: find reports its score decomposition', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'thing', definition: 'a test concept', sourceEpisode: 'ep1' });

  const hit = sm.find({ text: 'test concept' })[0];
  assert.ok(hit !== undefined);
  for (const key of ['similarity', 'grounding', 'strength', 'recency'] as const) {
    assert.equal(typeof hit.components[key], 'number');
  }
});

test('semantic: find can filter by category', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'eagle', categories: ['bird'] });
  sm.observe({ label: 'trout', categories: ['fish'] });

  const birds = sm.find({ category: 'bird' });
  assert.equal(birds.length, 1);
  assert.equal(birds[0]?.concept.label, 'eagle');
});

test('semantic: exclude removes specific concepts from results', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'one', definition: 'a described thing' });
  sm.observe({ label: 'two', definition: 'a described thing' });
  const hits = sm.find({ text: 'described thing', exclude: [sm.get('one')?.id ?? ''] });
  assert.ok(hits.every((h) => h.concept.label !== 'one'));
});

// ── Decay, forgetting and integrity ─────────────────────────────────────────

test('semantic: a weak ungrounded concept eventually fades', () => {
  const sm = new SemanticMemory({ baseHalfLife: 50, forgetThreshold: 0.05 });
  sm.observe({ label: 'ephemeral', sourceEpisode: 'ep1' });

  sm.advance(50_000);
  assert.equal(sm.size, 0);
});

test('semantic: forgetting a concept also removes its edges', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'alpha' });
  sm.observe({ label: 'beta' });
  sm.relate('alpha', 'r', 'beta');
  assert.equal(sm.edgeCount, 1);

  assert.equal(sm.forget('alpha'), true);
  assert.equal(sm.edgeCount, 0, 'dangling edges must not survive their endpoint');
  assert.deepEqual(sm.check(), []);
});

test('semantic: at capacity the least grounded concepts are shed first', () => {
  const sm = new SemanticMemory({ capacity: 3, mergeThreshold: 0.99 });

  for (let i = 1; i <= 6; i += 1) {
    sm.observe({ label: 'important', definition: 'a heavily grounded concept', sourceEpisode: `ep${i}` });
  }
  sm.observe({ label: 'rumour-a', definition: 'something heard once about topic A' });
  sm.observe({ label: 'rumour-b', definition: 'something heard once about topic B' });
  sm.observe({ label: 'rumour-c', definition: 'something heard once about topic C' });

  assert.ok(sm.size <= 3);
  assert.ok(sm.has('important'), `the grounded concept survived: ${sm.all().map((c) => c.label).join(', ')}`);
});

test('semantic: check() is clean after ordinary use', () => {
  const sm = new SemanticMemory();
  const labels = ['one', 'two', 'three', 'four'];
  for (const label of labels) sm.observe({ label, definition: `definition of ${label}` });
  sm.relate('one', 'links', 'two');
  sm.relate('two', 'links', 'three');
  sm.observe({ label: 'one', definition: 'more detail about one', sourceEpisode: 'ep9' });

  assert.deepEqual(sm.check(), []);
});

test('semantic: clear() resets everything', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'a' });
  sm.observe({ label: 'b' });
  sm.relate('a', 'r', 'b');
  sm.clear();

  assert.equal(sm.size, 0);
  assert.equal(sm.edgeCount, 0);
  assert.equal(sm.has('a'), false);
  assert.equal(sm.stats().observations, 0);
});

test('semantic: stats are internally consistent', () => {
  const sm = new SemanticMemory();
  for (let i = 0; i < 5; i += 1) {
    sm.observe({ label: `concept${i}`, definition: `the ${i}th concept`, sourceEpisode: `ep${i}` });
  }
  sm.relate('concept0', 'r', 'concept1');
  sm.relate('concept1', 'r', 'concept2');
  sm.observe({ label: 'concept0', properties: { x: 1 }, sourceEpisode: 'epX' });
  sm.observe({ label: 'concept0', properties: { x: 2 }, sourceEpisode: 'epY' });

  const stats = sm.stats();
  assert.equal(stats.concepts, sm.size);
  assert.equal(stats.edges, sm.edgeCount);
  assert.equal(stats.observations, 7);
  assert.equal(stats.contestedProperties, 1);
  assert.ok(stats.meanDegree > 0);
  assert.ok(stats.meanConfidence >= 0 && stats.meanConfidence <= 1);
  assert.deepEqual(sm.check(), []);
});

test('semantic: advance rejects non-positive counts', () => {
  const sm = new SemanticMemory();
  assert.throws(() => sm.advance(0), RangeError);
});

test('semantic: concepts handed to callers are frozen', () => {
  const sm = new SemanticMemory();
  sm.observe({ label: 'frozen', definition: 'a concept that must not be mutated' });
  const concept = sm.get('frozen');

  assert.ok(concept !== undefined);
  assert.equal(Object.isFrozen(concept), true);
  assert.equal(Object.isFrozen(concept.aliases), true);
  assert.throws(() => {
    (concept as { label: string }).label = 'tampered';
  }, TypeError);
});

test('semantic: the same seed reproduces the same concept graph', () => {
  const build = (): string => {
    const sm = new SemanticMemory();
    for (const label of ['alpha', 'beta', 'gamma']) sm.observe({ label, definition: `the ${label} entity` });
    sm.relate('alpha', 'precedes', 'beta', { weight: 0.7 });
    sm.relate('beta', 'precedes', 'gamma', { weight: 0.6 });
    return JSON.stringify(sm.all().map((c) => [c.label, c.strength, c.confidence]));
  };

  assert.equal(build(), build());
});
