/**
 * LOGOS :: Reasoning :: Belief tests
 * ---------------------------------------------------------------------------
 * The claims under test:
 *   · evidence accumulates by addition and is therefore ORDER-INDEPENDENT;
 *   · evidence is RETRACTABLE and retraction restores the prior exactly;
 *   · corroboration from one source is DISCOUNTED, because ten reports from
 *     one witness are not ten observations;
 *   · CONFLICT is distinguishable from IGNORANCE;
 *   · inference propagates through links and settles.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BeliefStore } from '../src/reasoning/beliefs.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import { LogosError } from '../src/kernel/types.ts';

const harness = (options: { readonly conflictThreshold?: number; readonly sourceDiscount?: number } = {}): {
  readonly kernel: Kernel;
  readonly beliefs: BeliefStore;
} => {
  const kernel = new Kernel();
  const beliefs = new BeliefStore({
    clock: kernel.clock,
    bus: kernel.bus,
    ...options,
  });
  return { kernel, beliefs };
};

// ── Declaration ─────────────────────────────────────────────────────────────

test('beliefs: a declared proposition starts at its prior', () => {
  const { beliefs } = harness();
  const belief = beliefs.declare('the door is locked', { prior: 0.5 });

  assert.equal(belief.credence, 0.5);
  assert.equal(belief.prior, 0.5);
  assert.equal(belief.evidence.length, 0);
  assert.equal(belief.conflicted, false);
});

test('beliefs: an empty proposition is refused loudly', () => {
  const { beliefs } = harness();
  assert.throws(() => beliefs.declare('   '), LogosError);
  assert.throws(() => beliefs.declare(''), LogosError);
});

test('beliefs: an informative prior is respected', () => {
  const { beliefs } = harness();
  const rare = beliefs.declare('the coin landed on its edge', { prior: 0.01 });
  assert.ok(rare.credence < 0.05, `a rare proposition should start unlikely: ${rare.credence}`);
});

test('beliefs: re-declaring keeps the gathered evidence', () => {
  const { beliefs } = harness();
  beliefs.declare('the bridge is safe');
  beliefs.addEvidence('the bridge is safe', { content: 'an engineer inspected it', strength: 5 });

  const after = beliefs.declare('the bridge is safe');
  assert.equal(after.evidence.length, 1, 're-declaring must not discard evidence');
  assert.ok(after.credence > 0.5);
});

test('beliefs: declaring is idempotent on the proposition text', () => {
  const { beliefs } = harness();
  beliefs.declare('the switch is on');
  beliefs.declare('the switch is on');
  assert.equal(beliefs.size, 1);
});

// ── Evidence accumulation ───────────────────────────────────────────────────

test('beliefs: supporting evidence raises credence', () => {
  const { beliefs } = harness();
  beliefs.declare('it will rain today');
  const before = beliefs.get('it will rain today')?.credence ?? 0;

  const after = beliefs.addEvidence('it will rain today', {
    content: 'the barometer is falling fast',
    strength: 8,
  });

  assert.ok(after.credence > before, `${before} -> ${after.credence}`);
});

test('beliefs: opposing evidence lowers credence', () => {
  const { beliefs } = harness();
  beliefs.declare('the alarm is real');
  beliefs.addEvidence('the alarm is real', { content: 'smoke was seen', source: 'observer', strength: 10 });
  const withSupport = beliefs.get('the alarm is real')?.credence ?? 0;

  // Two independent counter-reports against one supporting report, so the
  // balance genuinely shifts rather than cancelling exactly.
  beliefs.addEvidence('the alarm is real', {
    content: 'a sensor fault was diagnosed',
    source: 'engineer',
    stance: 'opposes',
    strength: 10,
  });
  const after = beliefs.addEvidence('the alarm is real', {
    content: 'the fault was reproduced in the workshop',
    source: 'technician',
    stance: 'opposes',
    strength: 10,
  });

  assert.ok(after.credence < 0.5, `counter-evidence should flip the balance: ${after.credence}`);
  assert.ok(after.credence < withSupport, `${withSupport} -> ${after.credence}`);
  assert.ok(after.opposition > after.support);
});

test('beliefs: equally strong independent evidence on both sides lands exactly at indifference', () => {
  const { beliefs } = harness();
  beliefs.declare('a balanced question');
  beliefs.addEvidence('a balanced question', { content: 'the case for', source: 'advocate', strength: 10 });
  const after = beliefs.addEvidence('a balanced question', {
    content: 'the case against',
    source: 'critic',
    stance: 'opposes',
    strength: 10,
  });

  // Bayes' rule in log-odds is a sum, and equal and opposite terms cancel. The
  // exactness is the check that the arithmetic is right, not a coincidence.
  assert.ok(Math.abs(after.credence - 0.5) < 1e-9, `should cancel exactly, got ${after.credence}`);
});

test('beliefs: evidence order does not change the result', () => {
  const build = (order: readonly ('a' | 'b' | 'c')[]): number => {
    const { beliefs } = harness();
    beliefs.declare('the hypothesis holds');
    const items = {
      a: { content: 'first observation', strength: 4 },
      b: { content: 'second observation', strength: 2, stance: 'opposes' as const },
      c: { content: 'third observation', strength: 6 },
    };
    for (const key of order) beliefs.addEvidence('the hypothesis holds', items[key]);
    return beliefs.get('the hypothesis holds')?.credence ?? 0;
  };

  // Bayes' rule is addition in log-odds, so the sum is commutative. A mind that
  // reached different conclusions from the same facts in a different order
  // would be unusable.
  const forward = build(['a', 'b', 'c']);
  const backward = build(['c', 'b', 'a']);
  const shuffled = build(['b', 'a', 'c']);

  assert.ok(Math.abs(forward - backward) < 1e-9, `${forward} vs ${backward}`);
  assert.ok(Math.abs(forward - shuffled) < 1e-9, `${forward} vs ${shuffled}`);
});

test('beliefs: uninformative evidence leaves the belief where it was', () => {
  const { beliefs } = harness();
  beliefs.declare('the reading is accurate');
  const before = beliefs.get('the reading is accurate')?.credence ?? 0;

  const after = beliefs.addEvidence('the reading is accurate', {
    content: 'the instrument is powered on',
    strength: 1,
  });

  assert.equal(after.credence, before, 'a likelihood ratio of 1 tells the mind nothing');
  assert.equal(after.evidence.length, 1, 'but it still remembers being told');
});

test('beliefs: an unreliable source cannot invert a belief', () => {
  const { beliefs } = harness();
  beliefs.declare('the witness is telling the truth');

  const after = beliefs.addEvidence('the witness is telling the truth', {
    content: 'the witness said something',
    strength: 100,
    reliability: 0,
  });

  // A liar who says "P" is not evidence for "not P". Unreliability damps the
  // likelihood ratio toward 1; it never flips it.
  assert.equal(after.credence, 0.5, `got ${after.credence}`);
});

test('beliefs: the same evidence content is not counted twice', () => {
  const { beliefs } = harness();
  beliefs.declare('the file exists');
  const first = beliefs.addEvidence('the file exists', { content: 'ls showed the file', source: 'shell', strength: 5 });
  const second = beliefs.addEvidence('the file exists', { content: 'ls showed the file', source: 'shell', strength: 5 });

  assert.equal(first.evidence.length, 1);
  assert.equal(second.evidence.length, 1, 're-reading your own notes is not new evidence');
  assert.equal(second.credence, first.credence);
});

test('beliefs: an explicit evidence id allows two genuinely distinct observations', () => {
  const { beliefs } = harness();
  beliefs.declare('the pump is failing');
  beliefs.addEvidence('the pump is failing', { content: 'vibration measured', id: 'obs-1', strength: 4 });
  beliefs.addEvidence('the pump is failing', { content: 'vibration measured', id: 'obs-2', strength: 4 });

  assert.equal(beliefs.get('the pump is failing')?.evidence.length, 2);
});

test('beliefs: empty evidence content is refused', () => {
  const { beliefs } = harness();
  beliefs.declare('something');
  assert.throws(() => beliefs.addEvidence('something', { content: '  ' }), LogosError);
});

test('beliefs: an undeclared proposition is declared implicitly rather than throwing', () => {
  const { beliefs } = harness();
  const belief = beliefs.addEvidence('an unannounced proposition', { content: 'a fact', strength: 3 });
  assert.ok(belief.credence > 0.5);
  assert.equal(beliefs.size, 1);
});

// ── Corroboration discounting ───────────────────────────────────────────────

test('beliefs: a second report from the same source counts for less than the first', () => {
  const { beliefs } = harness();
  beliefs.declare('the story is true');

  const one = beliefs.addEvidence('the story is true', { content: 'first report', source: 'witness', strength: 4 });
  const two = beliefs.addEvidence('the story is true', { content: 'second report', source: 'witness', strength: 4 });
  const three = beliefs.addEvidence('the story is true', { content: 'third report', source: 'witness', strength: 4 });

  const g1 = one.credence - 0.5;
  const g2 = two.credence - one.credence;
  const g3 = three.credence - two.credence;

  assert.ok(g1 > g2 && g2 > g3, `each same-source report should move less: ${g1}, ${g2}, ${g3}`);
});

test('beliefs: independent sources are worth more than one repeated source', () => {
  const repeated = harness();
  const independent = harness();

  for (const { beliefs } of [repeated, independent]) beliefs.declare('the claim is accurate');

  for (let i = 0; i < 4; i += 1) {
    repeated.beliefs.addEvidence('the claim is accurate', { content: `report ${i}`, source: 'one-witness', strength: 4 });
  }
  for (let i = 0; i < 4; i += 1) {
    independent.beliefs.addEvidence('the claim is accurate', { content: `report ${i}`, source: `witness-${i}`, strength: 4 });
  }

  const a = repeated.beliefs.get('the claim is accurate')?.credence ?? 0;
  const b = independent.beliefs.get('the claim is accurate')?.credence ?? 0;
  assert.ok(b > a, `four independent sources should outweigh four echoes: ${b} vs ${a}`);
});

test('beliefs: discounting never makes a report worthless', () => {
  const { beliefs } = harness({ sourceDiscount: 0.9 });
  beliefs.declare('the persistent claim');

  let previous = 0.5;
  for (let i = 0; i < 40; i += 1) {
    const belief = beliefs.addEvidence('the persistent claim', {
      content: `report number ${i}`,
      source: 'the-same-source',
      strength: 6,
    });
    assert.ok(belief.credence >= previous - 1e-9, 'repetition must never reduce credence');
    previous = belief.credence;
  }
  assert.ok(previous > 0.5, 'a source repeating itself is weak evidence, not no evidence');
});

// ── Retraction ──────────────────────────────────────────────────────────────

test('beliefs: retracting evidence restores exactly the previous state', () => {
  const { beliefs } = harness();
  beliefs.declare('the meeting is on Tuesday');
  beliefs.addEvidence('the meeting is on Tuesday', { content: 'the calendar says so', strength: 6 });
  const withOne = beliefs.get('the meeting is on Tuesday')?.credence ?? 0;

  const added = beliefs.addEvidence('the meeting is on Tuesday', {
    content: 'a colleague confirmed it',
    source: 'colleague',
    strength: 4,
  });
  assert.ok(added.credence > withOne);

  const evidenceId = added.evidence.at(-1)?.id ?? '';
  const retracted = beliefs.retract('the meeting is on Tuesday', evidenceId);

  assert.ok(retracted !== undefined);
  // This is the operation a probability-valued store cannot offer cleanly:
  // every item was a term in a sum, so removing one is a subtraction and the
  // belief returns to exactly what it would have been.
  assert.ok(
    Math.abs(retracted.credence - withOne) < 1e-9,
    `retraction should restore ${withOne}, got ${retracted.credence}`,
  );
});

test('beliefs: retracting a missing evidence id is a no-op', () => {
  const { beliefs } = harness();
  beliefs.declare('a claim');
  beliefs.addEvidence('a claim', { content: 'a fact', strength: 3 });
  const before = beliefs.get('a claim')?.credence ?? 0;

  const after = beliefs.retract('a claim', 'ev_does_not_exist');
  assert.equal(after?.credence, before);
});

test('beliefs: retraction is announced on the bus', () => {
  const { kernel, beliefs } = harness();
  const events: string[] = [];
  kernel.bus.on('belief:*', (e) => events.push(e.type));

  beliefs.declare('something');
  const added = beliefs.addEvidence('something', { content: 'a fact worth withdrawing', strength: 5 });
  beliefs.retract('something', added.evidence[0]?.id ?? '');

  assert.ok(events.includes('belief:declared'));
  assert.ok(events.includes('belief:updated'));
  assert.ok(events.includes('belief:retracted'));
});

// ── Conflict ────────────────────────────────────────────────────────────────

test('beliefs: strong evidence on both sides is reported as conflicted', () => {
  const { beliefs } = harness({ conflictThreshold: 0.5 });
  beliefs.declare('the accused is guilty');

  beliefs.addEvidence('the accused is guilty', { content: 'a motive was established', strength: 6 });
  beliefs.addEvidence('the accused is guilty', { content: 'an alibi was confirmed', stance: 'opposes', strength: 6 });

  const belief = beliefs.get('the accused is guilty');
  assert.ok(belief !== undefined);
  assert.equal(belief.conflicted, true);
  assert.ok(belief.support >= 0.5 && belief.opposition >= 0.5);
});

test('beliefs: conflict is distinguishable from ignorance', () => {
  const { beliefs } = harness({ conflictThreshold: 0.5 });
  beliefs.declare('a contested claim');
  beliefs.declare('an unexamined claim');

  beliefs.addEvidence('a contested claim', { content: 'for it', strength: 8 });
  beliefs.addEvidence('a contested claim', { content: 'against it', stance: 'opposes', strength: 8 });

  const contested = beliefs.get('a contested claim');
  const unexamined = beliefs.get('an unexamined claim');
  assert.ok(contested !== undefined && unexamined !== undefined);

  // Both sit near 0.5, but they are not the same epistemic state and a mind
  // that could not tell them apart would not know when to seek more evidence.
  assert.ok(Math.abs((contested.credence + unexamined.credence) / 2 - 0.5) < 0.2);
  assert.equal(contested.conflicted, true);
  assert.equal(unexamined.conflicted, false);
  assert.ok(contested.evidence.length > unexamined.evidence.length);
});

test('beliefs: query can isolate conflicted beliefs', () => {
  const { beliefs } = harness({ conflictThreshold: 0.5 });
  beliefs.declare('settled');
  beliefs.addEvidence('settled', { content: 'one clear observation', strength: 9 });

  beliefs.declare('contested');
  beliefs.addEvidence('contested', { content: 'for', strength: 8 });
  beliefs.addEvidence('contested', { content: 'against', stance: 'opposes', strength: 8 });

  const conflicted = beliefs.query({ conflicted: true });
  assert.equal(conflicted.length, 1);
  assert.equal(conflicted[0]?.proposition, 'contested');
});

// ── Assertion thresholds ────────────────────────────────────────────────────

test('beliefs: assert and deny thresholds classify a belief', () => {
  const { beliefs } = harness();
  beliefs.declare('the sky is blue');
  beliefs.addEvidence('the sky is blue', { content: 'I looked up', strength: 30 });

  assert.equal(beliefs.asserts('the sky is blue'), true);
  assert.equal(beliefs.denies('the sky is blue'), false);
  assert.equal(beliefs.isUndecided('the sky is blue'), false);
});

test('beliefs: an unknown proposition is undecided, not denied', () => {
  const { beliefs } = harness();
  assert.equal(beliefs.isUndecided('something never considered'), true);
  assert.equal(beliefs.asserts('something never considered'), false);
  assert.equal(beliefs.denies('something never considered'), false);
});

test('beliefs: a conflicted belief counts as undecided', () => {
  const { beliefs } = harness({ conflictThreshold: 0.5 });
  beliefs.declare('a divided question');
  beliefs.addEvidence('a divided question', { content: 'for', strength: 6 });
  beliefs.addEvidence('a divided question', { content: 'against', stance: 'opposes', strength: 6 });

  // A mind torn between two strong bodies of evidence should not act on the
  // midpoint as though it were a settled moderate view.
  assert.equal(beliefs.isUndecided('a divided question'), true);
});

test('beliefs: incoherent thresholds are refused', () => {
  const kernel = new Kernel();
  assert.throws(
    () =>
      new BeliefStore({
        clock: kernel.clock,
        bus: kernel.bus,
        assertThreshold: 0.3,
        denyThreshold: 0.7,
      }),
    LogosError,
  );
});

// ── Priors ──────────────────────────────────────────────────────────────────

test('beliefs: changing the prior keeps the evidence', () => {
  const { beliefs } = harness();
  beliefs.declare('a proposition', { prior: 0.5 });
  beliefs.addEvidence('a proposition', { content: 'a strong observation', strength: 10 });
  const withEvidence = beliefs.get('a proposition')?.credence ?? 0;

  const changed = beliefs.setPrior('a proposition', 0.9);
  assert.ok(changed.credence > withEvidence, 'a higher prior lifts the posterior');
  assert.equal(changed.evidence.length, 1, 'evidence survived');
  assert.equal(changed.prior, 0.9);
});

test('beliefs: a rare prior resists weak evidence', () => {
  const rare = harness();
  const common = harness();

  rare.beliefs.declare('an extraordinary claim', { prior: 0.001 });
  common.beliefs.declare('an ordinary claim', { prior: 0.5 });

  rare.beliefs.addEvidence('an extraordinary claim', { content: 'someone said so', strength: 3 });
  common.beliefs.addEvidence('an ordinary claim', { content: 'someone said so', strength: 3 });

  const a = rare.beliefs.get('an extraordinary claim')?.credence ?? 0;
  const b = common.beliefs.get('an ordinary claim')?.credence ?? 0;
  assert.ok(a < b, `extraordinary claims require stronger evidence: ${a} vs ${b}`);
});

// ── Inference over links ────────────────────────────────────────────────────

test('beliefs: credence propagates along a supporting link', () => {
  const { beliefs } = harness();
  beliefs.declare('it rained overnight');
  beliefs.declare('the ground is wet');

  beliefs.addEvidence('it rained overnight', { content: 'the gauge recorded rainfall', strength: 20 });
  beliefs.link('it rained overnight', 'the ground is wet', 'supports', { weight: 0.9 });

  const before = beliefs.get('the ground is wet')?.credence ?? 0;
  const iterations = beliefs.propagate();
  const after = beliefs.get('the ground is wet')?.credence ?? 0;

  assert.ok(iterations >= 1);
  assert.ok(after > before, `inference should raise the consequence: ${before} -> ${after}`);
});

test('beliefs: an opposing link propagates as evidence for the negation', () => {
  const { beliefs } = harness();
  beliefs.declare('the valve is open');
  beliefs.declare('the pipe is pressurised');

  beliefs.addEvidence('the valve is open', { content: 'the handle was turned', strength: 20 });
  beliefs.link('the valve is open', 'the pipe is pressurised', 'opposes', { weight: 0.9 });

  beliefs.propagate();
  const credence = beliefs.get('the pipe is pressurised')?.credence ?? 0;
  assert.ok(credence < 0.5, `an open valve should argue against pressure: ${credence}`);
});

test('beliefs: propagate settles rather than looping', () => {
  const { beliefs } = harness();
  a: {
    beliefs.declare('a');
    beliefs.declare('b');
    beliefs.declare('c');
    beliefs.link('a', 'b', 'supports', { weight: 0.7 });
    beliefs.link('b', 'c', 'supports', { weight: 0.7 });
    beliefs.link('c', 'a', 'supports', { weight: 0.7 });
    beliefs.addEvidence('a', { content: 'a seed observation', strength: 10 });

    const iterations = beliefs.propagate({ maxIterations: 50, tolerance: 1e-6 });
    assert.ok(iterations <= 50, 'iteration is bounded even on a cyclic graph');

    // A second run must not change anything materially, which is what
    // "settled" means.
    const before = beliefs.get('b')?.credence ?? 0;
    beliefs.propagate({ maxIterations: 50, tolerance: 1e-6 });
    const after = beliefs.get('b')?.credence ?? 0;
    assert.ok(Math.abs(after - before) < 0.05, `should be near settle: ${before} -> ${after}`);
  }
});

test('beliefs: several causes of one effect combine with diminishing returns', () => {
  const one = harness();
  const many = harness();

  for (const rig of [one, many]) {
    rig.beliefs.declare('cause one');
    rig.beliefs.declare('cause two');
    rig.beliefs.declare('cause three');
    rig.beliefs.declare('the effect occurred');
    rig.beliefs.addEvidence('cause one', { content: 'observed', strength: 20 });
    rig.beliefs.addEvidence('cause two', { content: 'observed', strength: 20 });
    rig.beliefs.addEvidence('cause three', { content: 'observed', strength: 20 });
    rig.beliefs.link('cause one', 'the effect occurred', 'supports', { weight: 0.6 });
  }
  many.beliefs.link('cause two', 'the effect occurred', 'supports', { weight: 0.6 });
  many.beliefs.link('cause three', 'the effect occurred', 'supports', { weight: 0.6 });

  one.beliefs.propagate();
  many.beliefs.propagate();

  const a = one.beliefs.get('the effect occurred')?.credence ?? 0;
  const b = many.beliefs.get('the effect occurred')?.credence ?? 0;
  assert.ok(b >= a, 'more causes should not lower the effect');
  assert.ok(b < 1, `noisy-OR must not reach certainty: ${b}`);
});

test('beliefs: linking to a missing belief returns undefined rather than throwing', () => {
  const { beliefs } = harness();
  beliefs.declare('a real belief');
  assert.equal(beliefs.link('a real belief', 'a fiction'), undefined);
  assert.equal(beliefs.link('a fiction', 'a real belief'), undefined);
});

test('beliefs: self-links are refused', () => {
  const { beliefs } = harness();
  beliefs.declare('a proposition');
  assert.throws(() => beliefs.link('a proposition', 'a proposition'), LogosError);
});

test('beliefs: repeated linking firms the connection', () => {
  const { beliefs } = harness();
  beliefs.declare('antecedent');
  beliefs.declare('consequent');

  // Deliberately start below the eventual target: weight converges toward the
  // asserted value, so starting AT it would show only support growing.
  const first = beliefs.link('antecedent', 'consequent', 'supports', { weight: 0.3 });
  const second = beliefs.link('antecedent', 'consequent', 'supports', { weight: 0.9 });
  const third = beliefs.link('antecedent', 'consequent', 'supports', { weight: 0.9 });

  assert.equal(first?.support, 1);
  assert.equal(second?.support, 2);
  assert.equal(third?.support, 3);
  assert.ok((second?.weight ?? 0) > (first?.weight ?? 0), 'a firmer assertion should raise the weight');
  assert.ok((third?.weight ?? 0) > (second?.weight ?? 0), 'and it keeps converging');
  assert.ok((third?.weight ?? 0) <= 0.9, 'without overshooting the asserted value');
});

test('beliefs: an assertion at the same weight only accumulates support', () => {
  const { beliefs } = harness();
  beliefs.declare('antecedent');
  beliefs.declare('consequent');

  const first = beliefs.link('antecedent', 'consequent', 'supports', { weight: 0.9 });
  const second = beliefs.link('antecedent', 'consequent', 'supports', { weight: 0.9 });

  assert.equal(first?.weight, 0.9);
  assert.equal(second?.weight, 0.9, 'weight converges to the asserted value, so it does not move');
  assert.ok((second?.support ?? 0) > (first?.support ?? 0), 'but the evidence for the link grew');
});

test('beliefs: inference is announced on the bus', () => {
  const { kernel, beliefs } = harness();
  const events: string[] = [];
  kernel.bus.on('belief:inferred', (e) => events.push(e.type));

  beliefs.declare('a');
  beliefs.declare('b');
  beliefs.link('a', 'b');
  beliefs.propagate();

  assert.equal(events.length, 1, 'one event per pass, not one per belief');
});

// ── Query, stats, integrity ─────────────────────────────────────────────────

test('beliefs: query filters by text, credence and source', () => {
  const { beliefs } = harness();
  beliefs.declare('the reactor is stable');
  beliefs.declare('the reactor is overheating');
  beliefs.addEvidence('the reactor is stable', { content: 'gauges nominal', source: 'control-room', strength: 10 });
  beliefs.addEvidence('the reactor is overheating', { content: 'temperature climbing', source: 'thermocouple', strength: 10 });

  assert.equal(beliefs.query({ text: 'overheating' }).length, 1);
  assert.equal(beliefs.query({ source: 'thermocouple' }).length, 1);
  assert.equal(beliefs.query({ minCredence: 0.9 }).length, 2);
  assert.equal(beliefs.query({ maxCredence: 0.1 }).length, 0);
});

test('beliefs: stats are internally consistent', () => {
  const { beliefs } = harness();
  beliefs.declare('one');
  beliefs.declare('two');
  beliefs.addEvidence('one', { content: 'a', strength: 3 });
  beliefs.addEvidence('one', { content: 'b', strength: 3 });
  beliefs.addEvidence('two', { content: 'c', stance: 'opposes', strength: 5 });

  const stats = beliefs.stats();
  assert.equal(stats.beliefs, 2);
  assert.equal(stats.evidence, 3);
  assert.ok(stats.meanCredence >= 0 && stats.meanCredence <= 1);
  assert.ok(stats.revisions >= 3);
  assert.deepEqual(beliefs.check(), []);
});

test('beliefs: the revision log explains why a belief moved', () => {
  const { beliefs } = harness();
  beliefs.declare('a changeable belief');
  beliefs.addEvidence('a changeable belief', { content: 'the first observation', source: 'sensor-a', strength: 5 });

  const revisions = beliefs.revisions;
  assert.ok(revisions.length >= 1);
  const latest = revisions.at(-1);
  assert.ok(latest !== undefined);
  assert.equal(latest.cause, 'evidence');
  assert.match(latest.detail, /sensor-a/);
  assert.notEqual(latest.before, latest.after);
});

test('beliefs: the revision log is bounded', () => {
  const kernel = new Kernel();
  const beliefs = new BeliefStore({ clock: kernel.clock, bus: kernel.bus, revisionLogLimit: 4 });
  beliefs.declare('a busy belief');
  for (let i = 0; i < 30; i += 1) {
    beliefs.addEvidence('a busy belief', { content: `observation ${i}`, strength: 2 });
  }
  assert.ok(beliefs.revisions.length <= 4);
  assert.ok(beliefs.revisionCount >= 30, 'the count is not bounded, only the log');
});

test('beliefs: forgetting removes the belief and its links', () => {
  const { beliefs } = harness();
  beliefs.declare('keeper');
  beliefs.declare('casualty');
  beliefs.link('casualty', 'keeper', 'supports', { weight: 0.8 });

  assert.equal(beliefs.forget('casualty'), true);
  assert.equal(beliefs.forget('casualty'), false);
  assert.equal(beliefs.get('casualty'), undefined);
  assert.deepEqual(beliefs.check(), [], 'no dangling link may survive');
});

test('beliefs: clear() resets everything', () => {
  const { beliefs } = harness();
  beliefs.declare('a');
  beliefs.addEvidence('a', { content: 'b', strength: 4 });
  beliefs.clear();

  assert.equal(beliefs.size, 0);
  assert.equal(beliefs.stats().evidence, 0);
  assert.equal(beliefs.revisions.length, 0);
});

test('beliefs: describe() gives a one-line summary', () => {
  const { beliefs } = harness();
  beliefs.declare('something');
  const line = beliefs.describe();
  assert.match(line, /beliefs\[/);
  assert.match(line, /n=1/);
});

test('beliefs: the same evidence produces the same belief every run', () => {
  const build = (): string => {
    const { beliefs } = harness();
    beliefs.declare('a reproducible proposition');
    for (let i = 0; i < 8; i += 1) {
      beliefs.addEvidence('a reproducible proposition', { content: `observation ${i}`, source: `src${i % 3}`, strength: 2 + (i % 3) });
    }
    return JSON.stringify(beliefs.stats());
  };
  assert.equal(build(), build());
});

test('beliefs: credence never leaves the unit interval under extreme evidence', () => {
  const { beliefs } = harness();
  beliefs.declare('an extreme proposition');
  for (let i = 0; i < 200; i += 1) {
    beliefs.addEvidence('an extreme proposition', { content: `overwhelming observation ${i}`, source: `s${i}`, strength: 1000 });
  }
  const belief = beliefs.get('an extreme proposition');
  assert.ok(belief !== undefined);
  assert.ok(belief.credence >= 0 && belief.credence <= 1, `credence was ${belief.credence}`);
  assert.ok(Number.isFinite(belief.credence));
});
