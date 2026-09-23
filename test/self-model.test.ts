/**
 * LOGOS :: Metacognition :: Self-model tests
 * ---------------------------------------------------------------------------
 * The claim under test is that a mind's knowledge of how it thinks is
 * EMPIRICAL: measured from what actually happened, not declared in advance.
 *
 * The three ways that claim could be false, and what each test rules out:
 *   · selection ignores the measurements and follows a hard-coded preference;
 *   · cost is not measured, so a strategy that is slightly worse and far more
 *     expensive keeps winning on raw success rate;
 *   · a heuristic silently dilutes real evidence instead of yielding to it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SelfModel, type Strategy } from '../src/metacognition/self-model.ts';
import { Calibrator } from '../src/metacognition/calibration.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import { LogosError, tick as mkTick } from '../src/kernel/types.ts';

interface Rig {
  readonly kernel: Kernel;
  readonly self: SelfModel;
  readonly calibrator: Calibrator;
}

const rig = (options: { readonly evidenceThreshold?: number; readonly withCalibrator?: boolean } = {}): Rig => {
  const kernel = new Kernel();
  const calibrator = new Calibrator({ clock: kernel.clock, bus: kernel.bus });
  const self = new SelfModel({
    clock: kernel.clock,
    bus: kernel.bus,
    ...(options.withCalibrator === true ? { calibrator } : {}),
    ...(options.evidenceThreshold === undefined ? {} : { evidenceThreshold: options.evidenceThreshold }),
  });
  return { kernel, self, calibrator };
};

/**
 * Give a strategy a track record.
 *
 * `successes` of `attempts`, each costing `attention`, started `latency` ticks
 * before it concluded.
 */
const practice = (
  self: SelfModel,
  strategy: Strategy,
  kind: string,
  attempts: number,
  successes: number,
  attention = 1,
  latency = 1,
  confidence = 0.7,
): void => {
  for (let i = 0; i < attempts; i += 1) {
    self.observe({
      strategy,
      kind,
      succeeded: i < successes,
      confidence,
      attention,
      startedAt: mkTick(latency),
    });
  }
};

// ── Observation ─────────────────────────────────────────────────────────────

test('self-model: an outcome is recorded against its strategy and kind', () => {
  const { kernel, self } = rig();
  const outcome = self.observe({
    strategy: 'recall',
    kind: 'diagnosis',
    succeeded: true,
    confidence: 0.8,
    attention: 2,
    startedAt: mkTick(0),
  });

  assert.equal(outcome.strategy, 'recall');
  assert.equal(outcome.kind, 'diagnosis');
  assert.equal(outcome.succeeded, true);

  const record = self.record('recall', 'diagnosis');
  assert.ok(record !== undefined);
  assert.equal(record.attempts, 1);
  assert.equal(record.successes, 1);
  assert.equal(record.efficacy, 1);
  void kernel;
});

test('self-model: an empty kind is refused', () => {
  const { self } = rig();
  assert.throws(
    () => self.observe({ strategy: 'recall', kind: '  ', succeeded: true, confidence: 0.5, attention: 1, startedAt: mkTick(0) }),
    LogosError,
  );
});

test('self-model: negative attention is refused', () => {
  const { self } = rig();
  assert.throws(
    () => self.observe({ strategy: 'recall', kind: 'k', succeeded: true, confidence: 0.5, attention: -1, startedAt: mkTick(0) }),
    LogosError,
  );
});

test('self-model: efficacy is the observed success rate', () => {
  const { self } = rig();
  practice(self, 'infer', 'arithmetic', 10, 7);

  const record = self.record('infer', 'arithmetic');
  assert.ok(record !== undefined);
  assert.equal(record.attempts, 10);
  assert.equal(record.successes, 7);
  assert.ok(Math.abs(record.efficacy - 0.7) < 1e-9);
});

test('self-model: mean attention and latency are measured, not assumed', () => {
  const { kernel, self } = rig();
  kernel.clock.advance(10);
  self.observe({ strategy: 'gather', kind: 'research', succeeded: true, confidence: 0.6, attention: 4, startedAt: mkTick(6) });

  const record = self.record('gather', 'research');
  assert.ok(record !== undefined);
  assert.equal(record.meanAttention, 4);
  assert.equal(record.meanLatency, 4, 'ten ticks elapsed from a start of six');
});

test('self-model: outcomes are announced on the bus', () => {
  const { kernel, self } = rig();
  const events: Record<string, unknown>[] = [];
  kernel.bus.on('self:observed', (e) => events.push({ ...e.payload }));

  practice(self, 'recall', 'k', 1, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.['strategy'], 'recall');
});

// ── Efficiency, not raw success ─────────────────────────────────────────────

test('self-model: a cheaper strategy can outrank a slightly more accurate one', () => {
  const { self } = rig();
  // Thorough: 90% success, ten units of attention each time.
  practice(self, 'gather', 'diagnosis', 20, 18, 10);
  // Cheap: 80% success, one unit each time.
  practice(self, 'recall', 'diagnosis', 20, 16, 1);

  const cheap = self.record('recall', 'diagnosis');
  const thorough = self.record('gather', 'diagnosis');
  assert.ok(cheap !== undefined && thorough !== undefined);

  assert.ok(thorough.efficacy > cheap.efficacy, 'the thorough one really is more accurate');
  assert.ok(
    cheap.efficiency > thorough.efficiency,
    `but the cheap one is the better choice per unit of attention: ${cheap.efficiency} vs ${thorough.efficiency}`,
  );
});

test('self-model: the recommendation follows the efficiency measurement', () => {
  const { self } = rig({ evidenceThreshold: 3 });
  practice(self, 'gather', 'diagnosis', 20, 18, 10);
  practice(self, 'recall', 'diagnosis', 20, 16, 1);

  const recommendation = self.recommend({ kind: 'diagnosis', description: 'the pump is failing' });
  // Raw success rate would pick `gather`. A mind that did not measure its own
  // costs would keep making that mistake.
  assert.equal(recommendation.strategy, 'recall');
  assert.match(recommendation.reason, /attention/);
});

test('self-model: attention scale makes efficiency readable', () => {
  const kernel = new Kernel();
  const self = new SelfModel({ clock: kernel.clock, bus: kernel.bus, attentionScale: 1 });
  practice(self, 'recall', 'k', 10, 10, 0);

  const record = self.record('recall', 'k');
  assert.ok(record !== undefined);
  // A free, always-correct strategy is the reference point: efficiency 1.
  // Asserted with a tolerance because the figure is rounded for reporting and
  // 1/1.000001 is not exactly 1.
  assert.ok(Math.abs(record.efficiency - 1) < 1e-4, `got ${record.efficiency}`);
});

// ── Selection from evidence ─────────────────────────────────────────────────

test('self-model: with no evidence, selection falls back to a stated heuristic', () => {
  const { self } = rig({ evidenceThreshold: 3 });
  const recommendation = self.recommend({ kind: 'unfamiliar', description: 'something new' });

  assert.equal(recommendation.record, undefined);
  assert.match(recommendation.reason, /no strong signal|familiar|stakes/i);
  assert.ok(recommendation.confidence <= 0.5, 'a heuristic should not sound confident');
});

test('self-model: high stakes on an unfamiliar problem gets the expensive route', () => {
  const { self } = rig({ evidenceThreshold: 3 });
  const recommendation = self.recommend({
    kind: 'novel',
    description: 'an unprecedented situation',
    stakes: 0.9,
    familiarity: 0.1,
  });
  assert.equal(recommendation.strategy, 'decompose');
});

test('self-model: high stakes with familiarity gets more evidence rather than decomposition', () => {
  const { self } = rig({ evidenceThreshold: 3 });
  const recommendation = self.recommend({
    kind: 'known',
    description: 'a situation seen before',
    stakes: 0.9,
    familiarity: 0.7,
  });
  assert.equal(recommendation.strategy, 'gather');
});

test('self-model: a familiar low-stakes problem gets the cheapest route', () => {
  const { self } = rig({ evidenceThreshold: 3 });
  const recommendation = self.recommend({
    kind: 'routine',
    description: 'the same thing as always',
    stakes: 0.2,
    familiarity: 0.9,
  });
  assert.ok(['apply-skill', 'recall'].includes(recommendation.strategy));
});

test('self-model: low stakes and no familiarity makes deferring defensible', () => {
  const { self } = rig({ evidenceThreshold: 3 });
  const recommendation = self.recommend({
    kind: 'trivia',
    description: 'a pointless question',
    stakes: 0.1,
    familiarity: 0.1,
  });
  // Declining is sometimes the correct answer, and almost never modelled.
  assert.equal(recommendation.strategy, 'defer');
});

test('self-model: a heuristic naming an unavailable strategy defers instead', () => {
  const { self } = rig({ evidenceThreshold: 3 });
  const recommendation = self.recommend(
    { kind: 'novel', description: 'x', stakes: 0.9, familiarity: 0.1 },
    { available: ['recall'] },
  );
  assert.equal(recommendation.strategy, 'defer');
  assert.match(recommendation.reason, /unavailable/);
});

test('self-model: real evidence replaces the heuristic rather than blending with it', () => {
  const { self } = rig({ evidenceThreshold: 3 });
  // The heuristic would say `decompose` for this profile. The evidence says
  // `recall`.
  practice(self, 'recall', 'novel', 10, 9, 1);

  const recommendation = self.recommend({
    kind: 'novel',
    description: 'x',
    stakes: 0.9,
    familiarity: 0.1,
  });

  assert.equal(recommendation.strategy, 'recall', 'measurement wins');
  assert.ok(recommendation.record !== undefined, 'and the recommendation says it came from evidence');
  assert.match(recommendation.reason, /worked/);
});

test('self-model: below the evidence threshold the heuristic still applies', () => {
  const { self } = rig({ evidenceThreshold: 5 });
  practice(self, 'recall', 'novel', 2, 2, 1);

  const recommendation = self.recommend({ kind: 'novel', description: 'x', stakes: 0.9, familiarity: 0.1 });
  assert.equal(recommendation.record, undefined, 'two attempts is not evidence');
  assert.equal(recommendation.strategy, 'decompose');
});

test('self-model: selection is confined to the available strategies', () => {
  const { self } = rig({ evidenceThreshold: 2 });
  practice(self, 'recall', 'k', 5, 5, 1);
  practice(self, 'gather', 'k', 5, 1, 5);

  const recommendation = self.recommend({ kind: 'k', description: 'x' }, { available: ['gather'] });
  assert.equal(recommendation.strategy, 'gather', 'recall was not on offer');
});

test('self-model: a confident recommendation needs a clear margin', () => {
  const close = rig({ evidenceThreshold: 2 });
  practice(close.self, 'recall', 'k', 10, 6, 1);
  practice(close.self, 'infer', 'k', 10, 6, 1);
  const closeCall = close.self.recommend({ kind: 'k', description: 'x' });

  const clear = rig({ evidenceThreshold: 2 });
  practice(clear.self, 'recall', 'k', 10, 10, 1);
  practice(clear.self, 'infer', 'k', 10, 1, 5);
  const clearCall = clear.self.recommend({ kind: 'k', description: 'x' });

  // Two strategies within noise of each other should produce a hesitant answer,
  // not a decisive one.
  assert.ok(
    clearCall.confidence > closeCall.confidence,
    `a clear winner should be recommended more confidently: ${clearCall.confidence} vs ${closeCall.confidence}`,
  );
});

test('self-model: the recommendation exposes everything it considered', () => {
  const { self } = rig({ evidenceThreshold: 2 });
  practice(self, 'recall', 'k', 5, 4, 1);
  practice(self, 'infer', 'k', 5, 2, 1);
  practice(self, 'gather', 'k', 5, 1, 3);

  const recommendation = self.recommend({ kind: 'k', description: 'x' });
  assert.ok(recommendation.considered.length >= 3, 'the alternatives are inspectable');
  const efficiencies = recommendation.considered.map((r) => r.efficiency);
  assert.deepEqual(efficiencies, [...efficiencies].sort((a, b) => b - a), 'best first');
});

test('self-model: recommendations are announced and journalled', () => {
  const { kernel, self } = rig();
  const events: Record<string, unknown>[] = [];
  kernel.bus.on('self:recommended', (e) => events.push({ ...e.payload }));

  self.recommend({ kind: 'k', description: 'x' });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.['fromEvidence'], false);

  assert.equal(self.journal.length, 1);
  assert.equal(self.journal[0]?.kind, 'k');
});

test('self-model: the journal records what was chosen and what it beat', () => {
  const { self } = rig({ evidenceThreshold: 2 });
  practice(self, 'recall', 'k', 5, 5, 1);
  practice(self, 'infer', 'k', 5, 2, 1);
  self.recommend({ kind: 'k', description: 'x' });

  const entry = self.journal[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.chosen, 'recall');
  assert.equal(entry.alternative, 'infer');
  assert.match(entry.detail, /measured/);
});

test('self-model: an empty kind is refused at recommendation time too', () => {
  const { self } = rig();
  assert.throws(() => self.recommend({ kind: '', description: 'x' }), LogosError);
});

// ── Confidence adjustment ───────────────────────────────────────────────────

test('self-model: confidence is adjusted down when the mind is overconfident here', () => {
  const { self } = rig({ evidenceThreshold: 3 });
  // Says 90%, succeeds 50% of the time.
  practice(self, 'infer', 'estimates', 10, 5, 1, 1, 0.9);

  const adjusted = self.adjustConfidence(0.9, 'estimates');
  assert.ok(adjusted < 0.9, `the mind should discount itself here: ${adjusted}`);
});

test('self-model: confidence is adjusted up when the mind is underconfident here', () => {
  const { self } = rig({ evidenceThreshold: 3 });
  // Says 30%, succeeds 90% of the time.
  practice(self, 'infer', 'estimates', 10, 9, 1, 1, 0.3);

  const adjusted = self.adjustConfidence(0.3, 'estimates');
  assert.ok(adjusted > 0.3, `the mind should trust itself more here: ${adjusted}`);
});

test('self-model: confidence is left alone with too little evidence', () => {
  const { self } = rig({ evidenceThreshold: 10 });
  practice(self, 'infer', 'estimates', 3, 1, 1, 1, 0.9);

  // A mind should not revise its self-assessment on three data points.
  assert.equal(self.adjustConfidence(0.9, 'estimates'), 0.9);
});

test('self-model: confidence is left alone when the gap is nil', () => {
  const { self } = rig({ evidenceThreshold: 3 });
  practice(self, 'infer', 'estimates', 10, 7, 1, 1, 0.7);

  // Stated 0.7 and succeeded 0.7 of the time, so there is nothing to correct.
  // Compared with a tolerance because the mean of ten 0.7s is not exactly 0.7
  // in binary floating point.
  assert.ok(Math.abs(self.adjustConfidence(0.7, 'estimates') - 0.7) < 1e-9);
});

test('self-model: adjustment is per-kind rather than global', () => {
  const { self } = rig({ evidenceThreshold: 3 });
  practice(self, 'infer', 'unreliable', 10, 2, 1, 1, 0.9);
  practice(self, 'infer', 'reliable', 10, 9, 1, 1, 0.9);

  assert.ok(self.adjustConfidence(0.9, 'unreliable') < self.adjustConfidence(0.9, 'reliable'));
});

test('self-model: a calibrator is folded in when one is attached', () => {
  const withCal = rig({ evidenceThreshold: 3, withCalibrator: true });
  const withoutCal = rig({ evidenceThreshold: 3, withCalibrator: true });

  // Both self-models are silent about this kind; only the calibrator has an
  // opinion, and only in one of them.
  for (let i = 0; i < 40; i += 1) {
    const prediction = withCal.calibrator.predict('a claim', 0.9, { domain: 'weather' });
    withCal.calibrator.resolve(prediction.id, i % 2 === 0);
  }

  const adjusted = withCal.self.adjustConfidence(0.9, 'weather');
  const unadjusted = withoutCal.self.adjustConfidence(0.9, 'weather');

  assert.ok(adjusted < unadjusted, `the calibrator's verdict should matter: ${adjusted} vs ${unadjusted}`);
});

test('self-model: adjustment never leaves the unit interval', () => {
  const { self } = rig({ evidenceThreshold: 3 });
  practice(self, 'infer', 'k', 20, 0, 1, 1, 1);
  assert.ok(self.adjustConfidence(1, 'k') >= 0);
  assert.ok(self.adjustConfidence(1, 'k') <= 1);
  assert.ok(self.adjustConfidence(0, 'k') >= 0);
  assert.ok(self.adjustConfidence(0, 'k') <= 1);
});

// ── Introspection and integrity ─────────────────────────────────────────────

test('self-model: records can be listed globally or per kind', () => {
  const { self } = rig();
  practice(self, 'recall', 'a', 5, 4);
  practice(self, 'infer', 'b', 5, 3);

  assert.equal(self.records().length, 2);
  assert.equal(self.records('a').length, 1);
  assert.deepEqual([...self.kinds].sort(), ['a', 'b']);
});

test('self-model: records are ordered by efficiency', () => {
  const { self } = rig();
  practice(self, 'recall', 'k', 10, 9, 1);
  practice(self, 'gather', 'k', 10, 9, 20);

  const records = self.records('k');
  assert.equal(records[0]?.strategy, 'recall');
});

test('self-model: describe gives a one-line summary', () => {
  const { self } = rig();
  practice(self, 'recall', 'k', 3, 3);
  const line = self.describe();
  assert.match(line, /self\[decisions=/);
  assert.match(line, /kinds=1/);
});

test('self-model: the decision counter advances', () => {
  const { self } = rig();
  assert.equal(self.decisions, 0);
  self.recommend({ kind: 'a', description: 'x' });
  self.recommend({ kind: 'b', description: 'y' });
  assert.equal(self.decisions, 2);
});

test('self-model: check is clean after ordinary use', () => {
  const { self } = rig({ evidenceThreshold: 2 });
  practice(self, 'recall', 'a', 6, 4, 2);
  practice(self, 'infer', 'a', 6, 2, 5);
  practice(self, 'gather', 'b', 3, 3, 1);
  self.recommend({ kind: 'a', description: 'x' });

  assert.deepEqual(self.check(), []);
});

test('self-model: the journal is bounded', () => {
  const { self } = rig();
  for (let i = 0; i < 400; i += 1) self.recommend({ kind: `k${i}`, description: 'x' });
  assert.ok(self.journal.length <= 256);
});

test('self-model: clear resets everything', () => {
  const { self } = rig();
  practice(self, 'recall', 'k', 5, 5);
  self.recommend({ kind: 'k', description: 'x' });
  self.clear();

  assert.equal(self.records().length, 0);
  assert.equal(self.journal.length, 0);
  assert.equal(self.decisions, 0);
  assert.deepEqual(self.kinds, []);
});

test('self-model: the record count is bounded, shedding the least-exercised first', () => {
  const kernel = new Kernel();
  const self = new SelfModel({ clock: kernel.clock, bus: kernel.bus, capacity: 16 });

  practice(self, 'recall', 'important', 30, 30, 1);
  for (let i = 0; i < 40; i += 1) practice(self, 'infer', `trivial${i}`, 1, 1, 1);

  // A strategy tried once on a kind is a hypothesis, and hypotheses are the
  // right thing to lose first.
  assert.ok(self.record('recall', 'important') !== undefined, 'the well-exercised record survived');
  assert.ok(self.records().length < 41);
});

test('self-model: the same history produces the same recommendation', () => {
  const run = (): string => {
    const { self } = rig({ evidenceThreshold: 2 });
    practice(self, 'gather', 'diagnosis', 12, 10, 8);
    practice(self, 'recall', 'diagnosis', 12, 9, 1);
    practice(self, 'infer', 'diagnosis', 12, 4, 2);
    const r = self.recommend({ kind: 'diagnosis', description: 'x' });
    return `${r.strategy}:${r.confidence}`;
  };
  assert.equal(run(), run());
});
