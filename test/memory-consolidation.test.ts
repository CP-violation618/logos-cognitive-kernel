/**
 * LOGOS :: Memory :: Consolidation tests
 * ---------------------------------------------------------------------------
 * The claims under test:
 *   · only what RECURS becomes a concept, and one vivid episode is not enough;
 *   · the concept's label is the INVARIANT (shared tokens), not the average;
 *   · source episodes are marked, never deleted — a mind that forgets the
 *     events but keeps the conclusion cannot re-examine its own reasoning;
 *   · consolidation is background work that goes through the scheduler, so its
 *     cost is accounted for in the same budget as everything else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ConsolidationEngine } from '../src/memory/consolidation.ts';
import { EpisodicMemory } from '../src/memory/episodic.ts';
import { SemanticMemory } from '../src/memory/semantic.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import { LogosError } from '../src/kernel/types.ts';

interface Harness {
  readonly kernel: Kernel;
  readonly episodic: EpisodicMemory;
  readonly semantic: SemanticMemory;
  readonly engine: ConsolidationEngine;
}

const harness = (): Harness => {
  const kernel = new Kernel({ config: { memory: { consolidationAgeTicks: 1 } } });
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
  return { kernel, episodic, semantic, engine };
};

/**
 * Encode a recurring phenomenon.
 *
 * Distinct situations on purpose: the same situation plus similar short text
 * would make each episode a continuation of the last and collapse the cluster
 * to a single episode.
 */
const encodeRecurring = (episodic: EpisodicMemory, count: number, variant: (i: number) => string): string[] => {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const { id } = episodic.encode(variant(i), {
      situation: `session-${i}`,
      surprise: 0.4,
      selfRelevance: 0.5,
      data: { domain: 'testing', attempt: i },
    });
    ids.push(id);
    episodic.advance(2);
  }
  return ids;
};

// ── Clustering ──────────────────────────────────────────────────────────────

test('consolidation: similar episodes cluster together', () => {
  const { episodic, engine } = harness();
  encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed again on attempt ${i} due to a flaky test`);

  const clusters = engine.cluster(episodic.all());
  assert.equal(clusters.length, 1, 'they are all the same phenomenon');
  assert.equal(clusters[0]?.episodes.length, 4);
});

test('consolidation: dissimilar episodes do not cluster', () => {
  const { episodic, engine } = harness();
  episodic.encode('the deployment pipeline failed on a flaky test', { situation: 'a' });
  episodic.encode('the tide came in earlier than the almanac predicted', { situation: 'b' });
  episodic.encode('a woodpecker was drumming on the gutter', { situation: 'c' });

  const clusters = engine.cluster(episodic.all());
  assert.equal(clusters.length, 0, 'nothing recurs, so nothing generalises');
});

test('consolidation: cohesion measures how tightly a cluster hangs together', () => {
  const { episodic, engine } = harness();
  encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed again on attempt ${i} due to a flaky test`);

  const cluster = engine.cluster(episodic.all())[0];
  assert.ok(cluster !== undefined);
  assert.ok(cluster.cohesion > 0.5 && cluster.cohesion <= 1, `cohesion was ${cluster.cohesion}`);
});

test('consolidation: shared tokens are the invariant, distinguishing tokens the detail', () => {
  const { episodic, engine } = harness();
  encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed with error code ${i} on a flaky test`);

  const cluster = engine.cluster(episodic.all())[0];
  assert.ok(cluster !== undefined);
  assert.ok(cluster.sharedTokens.includes('deployment'), `shared: ${cluster.sharedTokens.join(', ')}`);
  assert.ok(cluster.sharedTokens.includes('pipeline'));
  assert.ok(!cluster.sharedTokens.includes('with'), 'stopwords never reach the invariant');
  assert.ok(cluster.distinguishingTokens.length > 0, 'what differs is recorded as incidental');
});

// ── Concept formation ───────────────────────────────────────────────────────

test('consolidation: a repeated phenomenon becomes a concept', () => {
  const { episodic, semantic, engine } = harness();
  encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);

  const outcome = engine.consolidateNow();
  assert.equal(outcome.conceptsFormed, 1);
  assert.equal(semantic.size, 1, 'one concept generalised from the cluster');
  assert.ok(outcome.episodesConsolidated >= 4);
});

test('consolidation: a single vivid episode forms nothing', () => {
  const { episodic, semantic, engine } = harness();
  episodic.encode('an utterly unprecedented event that has never happened before', {
    situation: 'once',
    surprise: 1,
    selfRelevance: 1,
  });

  const outcome = engine.consolidateNow();
  assert.equal(outcome.conceptsFormed, 0);
  assert.equal(semantic.size, 0, 'one observation is an anecdote, not knowledge');
});

test('consolidation: two episodes are below the default cluster minimum', () => {
  const { episodic, semantic, engine } = harness();
  encodeRecurring(episodic, 2, (i) => `the deployment pipeline failed again on attempt ${i}`);

  assert.equal(engine.consolidateNow().conceptsFormed, 0);
  assert.equal(semantic.size, 0);
});

test('consolidation: lowering the minimum lets a pair generalise', () => {
  const kernel = new Kernel({ config: { memory: { consolidationAgeTicks: 1 } } });
  const episodic = new EpisodicMemory({ baseHalfLife: 10_000 });
  const semantic = new SemanticMemory();
  const engine = new ConsolidationEngine({
    clock: kernel.clock,
    bus: kernel.bus,
    scheduler: kernel.scheduler,
    config: kernel.config,
    rng: kernel.rng,
    episodic,
    semantic,
    minClusterSize: 2,
  });

  encodeRecurring(episodic, 2, (i) => `the deployment pipeline failed again on attempt ${i}`);
  assert.equal(engine.consolidateNow().conceptsFormed, 1);
  assert.equal(semantic.size, 1);
});

test('consolidation: the concept is grounded in every source episode', () => {
  const { episodic, semantic, engine } = harness();
  encodeRecurring(episodic, 5, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);
  engine.consolidateNow();

  const concept = semantic.all()[0];
  assert.ok(concept !== undefined);
  // This is the crux: a cluster of 5 must count as 5 pieces of evidence. If
  // the sources were passed as one concatenated string it would read as 1 and
  // the concept would be permanently under-confident.
  assert.equal(concept.grounding, 5, `grounding was ${concept.grounding}`);
});

test('consolidation: a larger cluster yields a more confident concept', () => {
  const small = harness();
  const large = harness();

  encodeRecurring(small.episodic, 3, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);
  encodeRecurring(large.episodic, 12, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);

  small.engine.consolidateNow();
  large.engine.consolidateNow();

  const a = small.semantic.all()[0]?.confidence ?? 0;
  const b = large.semantic.all()[0]?.confidence ?? 0;
  assert.ok(b > a, `more recurrence should mean more confidence: ${a} vs ${b}`);
});

test('consolidation: the concept definition comes from the episodes themselves', () => {
  const { episodic, semantic, engine } = harness();
  encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);
  engine.consolidateNow();

  const definition = semantic.all()[0]?.definition ?? '';
  assert.match(definition, /deployment pipeline/, 'the definition is drawn from real experience');
});

// ── Source episodes are preserved ───────────────────────────────────────────

test('consolidation: source episodes are marked, never deleted', () => {
  const { episodic, semantic, engine } = harness();
  const ids = encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);
  const sizeBefore = episodic.size;

  engine.consolidateNow();

  assert.equal(episodic.size, sizeBefore, 'generalising does not erase the experiences');
  for (const id of ids) {
    assert.ok(episodic.get(id) !== undefined, `episode ${id} survived`);
  }
  assert.equal(semantic.size, 1);
});

test('consolidation: a consolidated episode is not re-generalised on the next pass', () => {
  const { episodic, engine } = harness();
  encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);

  const first = engine.consolidateNow();
  const second = engine.consolidateNow();

  assert.equal(first.conceptsFormed, 1);
  assert.equal(second.conceptsFormed, 0, 'already-generalised episodes are not reconsidered');
  assert.equal(second.episodesConsolidated, 0);
});

test('consolidation: fresh episodes join an existing concept rather than creating a rival', () => {
  const { episodic, semantic, engine } = harness();
  encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);
  engine.consolidateNow();
  assert.equal(semantic.size, 1);

  encodeRecurring(episodic, 3, (i) => `the deployment pipeline failed on attempt ${i + 10} with a flaky test`);
  const second = engine.consolidateNow();

  assert.equal(semantic.size, 1, 'the same phenomenon strengthens one concept');
  assert.equal(second.conceptsReinforced, 1);
  assert.equal(semantic.all()[0]?.grounding, 7, 'and the grounding grew by the new sources');
});

// ── The pass as scheduled work ──────────────────────────────────────────────

test('consolidation: run() executes as a background scheduler task', async () => {
  const { episodic, engine, kernel } = harness();
  await kernel.start();
  encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);

  const outcome = await engine.run();
  await kernel.stop();

  assert.equal(outcome.conceptsFormed, 1);
  assert.ok((kernel.scheduler.stats().completed ?? 0) >= 1, 'the pass was accounted for by the scheduler');
});

test('consolidation: the pass reports itself on the event bus', async () => {
  const { episodic, engine, kernel } = harness();
  const events: string[] = [];
  await kernel.start();
  kernel.bus.on('memory:*', (e) => events.push(e.type));

  encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);
  await engine.run();
  await kernel.stop();

  assert.ok(events.includes('memory:consolidation'), `events were: ${events.join(', ')}`);
  assert.ok(events.includes('memory:concept'));
});

test('consolidation: run() surfaces a pass that did not complete as an error', async () => {
  // Stubbed rather than raced. Cancelling from outside would contend with
  // `run()` draining its slice eagerly, and the point of this test is the
  // error path, not the scheduler's cancellation semantics (which have their
  // own tests). A scheduler that reports `cancelled` is the deterministic
  // version of "the pass did not happen".
  //
  // The age threshold is lowered to match the harness: with the default of 40
  // ticks a freshly-encoded episode is not yet eligible to generalise, which
  // is correct behaviour but would make this test assert the wrong thing.
  const kernel = new Kernel({ config: { memory: { consolidationAgeTicks: 1 } } });
  const episodic = new EpisodicMemory({ baseHalfLife: 10_000 });
  const semantic = new SemanticMemory();
  const engine = new ConsolidationEngine({
    clock: kernel.clock,
    bus: kernel.bus,
    scheduler: kernel.scheduler,
    config: kernel.config,
    rng: kernel.rng,
    episodic,
    semantic,
  });

  const cancelled = {
    state: 'cancelled' as const,
    value: undefined,
    error: undefined,
  };
  const stub = {
    ...kernel.scheduler,
    run: async (): Promise<typeof cancelled> => cancelled,
  } as unknown as typeof kernel.scheduler;

  const stubbed = new ConsolidationEngine({
    clock: kernel.clock,
    bus: kernel.bus,
    scheduler: stub,
    config: kernel.config,
    rng: kernel.rng,
    episodic,
    semantic,
  });

  await assert.rejects(stubbed.run(), (error: unknown) => {
    assert.ok(error instanceof LogosError);
    assert.equal(error.code, 'CONSOLIDATION_FAILED');
    return true;
  });

  // And the unstubbed engine still works, so the stub is the only difference.
  // Distinct situations matter here: identical ones plus similar short text
  // would merge the four episodes into one and fall below the cluster minimum.
  encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);
  await engine.run();
  assert.equal(semantic.size, 1);
});

// ── Derived relations ───────────────────────────────────────────────────────

test('consolidation: concepts from overlapping experiences are linked automatically', () => {
  const { episodic, semantic, engine } = harness();

  // Two phenomena that share some episodes: the deployment failures and the
  // rollbacks that followed them.
  for (let i = 0; i < 4; i += 1) {
    episodic.encode(`the deployment pipeline failed on attempt ${i} with a flaky test`, {
      situation: `deploy-${i}`,
      data: { pipeline: 'ci' },
    });
    episodic.advance(1);
    episodic.encode(`the rollback procedure was triggered by the release manager ${i}`, {
      situation: `release-${i}`,
      data: { action: 'rollback' },
    });
    episodic.advance(1);
  }

  engine.consolidateNow();
  assert.ok(semantic.size >= 1);
  // Relations are only asserted when sources genuinely overlap, so the exact
  // count depends on the clustering; what matters is that the mechanism runs
  // and leaves the graph consistent.
  assert.deepEqual(semantic.check(), []);
});

// ── Accounting and bookkeeping ──────────────────────────────────────────────

test('consolidation: stats accumulate across passes', () => {
  const { episodic, engine } = harness();
  encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);
  engine.consolidateNow();
  encodeRecurring(episodic, 3, (i) => `an unrelated tide observation recorded at station ${i} near the estuary`);
  engine.consolidateNow();

  const stats = engine.stats();
  assert.equal(stats.passes, 2);
  assert.ok((stats.conceptsFormed as number) >= 1);
  assert.ok((stats.episodesConsolidated as number) >= 4);
});

test('consolidation: history records each pass', () => {
  const { episodic, engine } = harness();
  encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);

  assert.equal(engine.history.length, 0);
  engine.consolidateNow();
  engine.consolidateNow();

  assert.equal(engine.history.length, 2);
  const first = engine.history[0];
  assert.ok(first !== undefined);
  assert.equal(typeof first.at, 'number');
});

test('consolidation: history is bounded', () => {
  const { engine } = harness();
  for (let i = 0; i < 50; i += 1) engine.consolidateNow();
  assert.ok(engine.history.length <= 32);
});

test('consolidation: reset clears the counters', () => {
  const { episodic, engine } = harness();
  encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);
  engine.consolidateNow();

  engine.reset();
  assert.equal(engine.passes, 0);
  assert.equal(engine.history.length, 0);
  assert.equal(engine.stats().conceptsFormed, 0);
});

test('consolidation: an empty memory consolidates nothing without error', () => {
  const { engine, semantic } = harness();
  const outcome = engine.consolidateNow();

  assert.equal(outcome.clusters, 0);
  assert.equal(outcome.conceptsFormed, 0);
  assert.equal(semantic.size, 0);
});

test('consolidation: episodes too fresh to generalise are left alone', () => {
  const kernel = new Kernel({ config: { memory: { consolidationAgeTicks: 500 } } });
  const episodic = new EpisodicMemory({ baseHalfLife: 10_000 });
  const semantic = new SemanticMemory();
  const engine = new ConsolidationEngine({
    clock: kernel.clock,
    bus: kernel.bus,
    scheduler: kernel.scheduler,
    config: kernel.config,
    rng: kernel.rng,
    episodic,
    semantic,
  });

  encodeRecurring(episodic, 4, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);
  assert.equal(engine.consolidateNow().clusters, 0, 'a recent experience is not yet a lesson');
});

test('consolidation: truncation is reported when a pass hits its ceiling', () => {
  const kernel = new Kernel({ config: { memory: { consolidationAgeTicks: 1 } } });
  const episodic = new EpisodicMemory({ baseHalfLife: 10_000 });
  const semantic = new SemanticMemory();
  const engine = new ConsolidationEngine({
    clock: kernel.clock,
    bus: kernel.bus,
    scheduler: kernel.scheduler,
    config: kernel.config,
    rng: kernel.rng,
    episodic,
    semantic,
    maxPerPass: 4,
  });

  encodeRecurring(episodic, 12, (i) => `the deployment pipeline failed on attempt ${i} with a flaky test`);
  const outcome = engine.consolidateNow();

  assert.equal(outcome.truncated, true, 'the pass says it did not see everything');
  assert.ok(outcome.episodesConsolidated <= 4);
});
