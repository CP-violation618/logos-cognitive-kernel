/**
 * LOGOS :: Metacognition :: Calibration tests
 * ---------------------------------------------------------------------------
 * The claims under test:
 *   · a prediction is recorded BEFORE its outcome, which is what makes the
 *     measurement mean anything at all;
 *   · overconfidence and underconfidence are distinguished by the SIGN of the
 *     bias, because they call for opposite remedies;
 *   · the calibration is applied, not merely displayed — `adjustedConfidence`
 *     moves toward the observed truth;
 *   · calibration is per-domain, so being good at arithmetic does not mask
 *     being bad at people.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Calibrator } from '../src/metacognition/calibration.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import { LogosError } from '../src/kernel/types.ts';

const harness = (options: { readonly minimumSamples?: number; readonly bins?: number } = {}): {
  readonly kernel: Kernel;
  readonly calibrator: Calibrator;
} => {
  const kernel = new Kernel();
  const calibrator = new Calibrator({ clock: kernel.clock, bus: kernel.bus, ...options });
  return { kernel, calibrator };
};

/** A perfectly calibrated mind: it says p, and is right p of the time. */
const populateWellCalibrated = (calibrator: Calibrator, domain = 'general'): void => {
  let k = 0;
  for (let i = 0; i < 10; i += 1) {
    for (let j = 0; j < 10; j += 1) {
      const confidence = (i + 1) / 10;
      const prediction = calibrator.predict(`claim ${i}-${j}`, confidence, { domain });
      // Deterministic rather than random: for each confidence level, exactly
      // that fraction of outcomes is true. A random population would make the
      // test's own error bars the thing under test.
      calibrator.resolve(prediction.id, k < Math.round(confidence * 10));
      k = (k + 1) % 10;
    }
  }
};

/** An overconfident mind: always says 90%, is right half the time. */
const populateOverconfident = (calibrator: Calibrator, domain = 'general'): void => {
  for (let i = 0; i < 40; i += 1) {
    const prediction = calibrator.predict(`confident claim ${i}`, 0.9, { domain });
    calibrator.resolve(prediction.id, i % 2 === 0);
  }
};

/** An underconfident mind: always says 30%, is right 70% of the time. */
const populateUnderconfident = (calibrator: Calibrator, domain = 'general'): void => {
  for (let i = 0; i < 40; i += 1) {
    const prediction = calibrator.predict(`hesitant claim ${i}`, 0.3, { domain });
    calibrator.resolve(prediction.id, i % 10 < 7);
  }
};

// ── Recording ───────────────────────────────────────────────────────────────

test('calibration: a prediction is recorded before its outcome is known', () => {
  const { calibrator } = harness();
  const prediction = calibrator.predict('it will rain tomorrow', 0.7, { domain: 'weather' });

  assert.equal(prediction.confidence, 0.7);
  assert.equal(prediction.outcome, undefined, 'the outcome is genuinely unknown at prediction time');
  assert.equal(prediction.resolvedAt, undefined);
  assert.equal(calibrator.pendingCount, 1);
  assert.equal(calibrator.resolvedCount, 0);
});

test('calibration: an empty claim is refused', () => {
  const { calibrator } = harness();
  assert.throws(() => calibrator.predict('  ', 0.5), LogosError);
});

test('calibration: confidence is clamped into the unit interval', () => {
  const { calibrator } = harness();
  assert.equal(calibrator.predict('too sure', 5).confidence, 1);
  assert.equal(calibrator.predict('too unsure', -3).confidence, 0);
});

test('calibration: resolving moves a prediction from pending to settled', () => {
  const { calibrator } = harness();
  const prediction = calibrator.predict('a foregone conclusion', 0.95);

  const contribution = calibrator.resolve(prediction.id, true);
  assert.ok(contribution !== undefined);
  assert.equal(calibrator.pendingCount, 0);
  assert.equal(calibrator.resolvedCount, 1);
});

test('calibration: a confident miss costs more than a hesitant one', () => {
  const { calibrator } = harness();
  const confident = calibrator.predict('certain but wrong', 0.95);
  const hesitant = calibrator.predict('unsure and wrong', 0.55);

  const a = calibrator.resolve(confident.id, false) ?? 0;
  const b = calibrator.resolve(hesitant.id, false) ?? 0;
  assert.ok(a > b, `a confident miss should cost more: ${a} vs ${b}`);
});

test('calibration: the same prediction cannot be resolved twice', () => {
  const { calibrator } = harness();
  const prediction = calibrator.predict('a settled matter', 0.6);

  assert.ok(calibrator.resolve(prediction.id, true) !== undefined);
  // Re-settling would let a mind recount its successes until it looked good.
  assert.equal(calibrator.resolve(prediction.id, false), undefined);
  assert.equal(calibrator.resolvedCount, 1);
});

test('calibration: resolving an unknown id returns undefined rather than throwing', () => {
  const { calibrator } = harness();
  assert.equal(calibrator.resolve('pred_nonexistent', true), undefined);
});

test('calibration: resolveWhere settles a whole batch at once', () => {
  const { calibrator } = harness();
  for (let i = 0; i < 5; i += 1) calibrator.predict(`batch claim ${i}`, 0.6, { domain: 'batch' });
  calibrator.predict('unrelated', 0.6, { domain: 'other' });

  const settled = calibrator.resolveWhere((p) => p.domain === 'batch', true);
  assert.equal(settled, 5);
  assert.equal(calibrator.pendingCount, 1);
});

test('calibration: resolution is announced on the bus', () => {
  const { kernel, calibrator } = harness();
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  kernel.bus.on('metacognition:*', (e) => events.push({ type: e.type, payload: { ...e.payload } }));

  const prediction = calibrator.predict('an announcement-worthy claim', 0.8);
  calibrator.resolve(prediction.id, true);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.payload['outcome'], true);
  assert.equal(events[0]?.payload['confidence'], 0.8);
});

// ── Measurement ─────────────────────────────────────────────────────────────

test('calibration: an empty record reports insufficient data rather than a score', () => {
  const { calibrator } = harness();
  const report = calibrator.report();

  assert.equal(report.resolved, 0);
  assert.equal(report.brier, 0);
  assert.equal(report.verdict, 'insufficient-data');
});

test('calibration: a well-calibrated mind is recognised as such', () => {
  const { calibrator } = harness();
  populateWellCalibrated(calibrator);

  const report = calibrator.report();
  assert.equal(report.resolved, 100);
  assert.equal(report.verdict, 'well-calibrated');
  assert.ok(report.reliability < 0.06, `reliability error was ${report.reliability}`);
  assert.ok(Math.abs(report.bias) < 0.06, `bias was ${report.bias}`);
});

test('calibration: always saying 50% is perfectly calibrated and completely useless', () => {
  const { calibrator } = harness();
  for (let i = 0; i < 40; i += 1) {
    const prediction = calibrator.predict('a coin flip', 0.5);
    calibrator.resolve(prediction.id, i % 2 === 0);
  }

  const report = calibrator.report();
  // Reliability alone cannot distinguish this from a good forecaster, which is
  // exactly why resolution and skill are reported alongside it.
  assert.ok(report.reliability < 0.05, 'it really is well calibrated');
  assert.ok(report.resolution < 0.01, 'but it discriminates nothing');
  assert.ok(report.skill < 0.05, 'and so has no skill over the base rate');
});

test('calibration: sharp and correct scores better than sharp and wrong', () => {
  const good = harness();
  const bad = harness();

  for (let i = 0; i < 40; i += 1) {
    const a = good.calibrator.predict('a well-judged claim', 0.9);
    good.calibrator.resolve(a.id, i < 36);
    const b = bad.calibrator.predict('a badly-judged claim', 0.9);
    bad.calibrator.resolve(b.id, i < 18);
  }

  assert.ok(
    good.calibrator.report().brier < bad.calibrator.report().brier,
    'the better forecaster should score lower',
  );
});

// ── Bias direction ──────────────────────────────────────────────────────────

test('calibration: overconfidence is detected and named', () => {
  const { calibrator } = harness();
  populateOverconfident(calibrator);

  const report = calibrator.report();
  assert.equal(report.verdict, 'overconfident');
  assert.ok(report.bias > 0, `overconfidence should be positive: ${report.bias}`);
  assert.ok(report.bias > 0.3, 'saying 90% and being right half the time is a large gap');
});

test('calibration: underconfidence is detected and named', () => {
  const { calibrator } = harness();
  populateUnderconfident(calibrator);

  const report = calibrator.report();
  assert.equal(report.verdict, 'underconfident');
  assert.ok(report.bias < 0, `underconfidence should be negative: ${report.bias}`);
});

test('calibration: the two failure modes are distinguishable, not merged', () => {
  const over = harness();
  const under = harness();
  populateOverconfident(over.calibrator);
  populateUnderconfident(under.calibrator);

  // Both are badly calibrated, and the reliability error alone could not tell
  // them apart. The sign does, and they need opposite remedies.
  assert.equal(over.calibrator.report().verdict, 'overconfident');
  assert.equal(under.calibrator.report().verdict, 'underconfident');
  assert.notEqual(
    Math.sign(over.calibrator.report().bias),
    Math.sign(under.calibrator.report().bias),
  );
});

// ── Applied correction ──────────────────────────────────────────────────────

test('calibration: adjustment shrinks an overconfident estimate', () => {
  const { calibrator } = harness();
  populateOverconfident(calibrator);

  const adjusted = calibrator.adjustedConfidence(0.9);
  assert.ok(adjusted < 0.9, `an overconfident mind should discount itself: ${adjusted}`);
  assert.ok(adjusted > 0.4, `but not collapse to ignorance: ${adjusted}`);
});

test('calibration: adjustment raises an underconfident estimate', () => {
  const { calibrator } = harness();
  populateUnderconfident(calibrator);

  const adjusted = calibrator.adjustedConfidence(0.3);
  assert.ok(adjusted > 0.3, `an underconfident mind should trust itself more: ${adjusted}`);
});

test('calibration: adjustment is conservative with little evidence', () => {
  const { calibrator } = harness();
  calibrator.predict('a lone claim', 0.9);
  const only = calibrator.predict('a second claim', 0.9);
  calibrator.resolve(only.id, true);

  // Two data points is not enough to re-scale a self-assessment.
  assert.equal(calibrator.adjustedConfidence(0.9), 0.9);
});

test('calibration: adjustment does nothing when calibration is already good', () => {
  const { calibrator } = harness();
  populateWellCalibrated(calibrator);
  assert.equal(calibrator.adjustedConfidence(0.5), 0.5);
  assert.equal(calibrator.adjustedConfidence(0.9), 0.9);
});

test('calibration: adjustment never leaves the unit interval', () => {
  const { calibrator } = harness();
  populateOverconfident(calibrator);
  assert.ok(calibrator.adjustedConfidence(1) <= 1);
  assert.ok(calibrator.adjustedConfidence(0) >= 0);

  const under = harness();
  populateUnderconfident(under.calibrator);
  assert.ok(under.calibrator.adjustedConfidence(1) <= 1);
  assert.ok(under.calibrator.adjustedConfidence(0) >= 0);
});

test('calibration: observedFrequency answers what a self-model needs to know', () => {
  const { calibrator } = harness();
  populateOverconfident(calibrator);

  // "When I feel 90% sure, how often am I actually right?"
  const observed = calibrator.observedFrequency(0.9);
  assert.ok(observed !== undefined, 'the band has data');
  assert.ok(observed < 0.7, `the mind should learn it is not as sure as it feels: ${observed}`);
});

test('calibration: observedFrequency is undefined for an unpopulated band', () => {
  const { calibrator } = harness();
  const prediction = calibrator.predict('a single low-confidence claim', 0.05);
  calibrator.resolve(prediction.id, false);
  assert.equal(calibrator.observedFrequency(0.95), undefined);
});

// ── Per-domain calibration ──────────────────────────────────────────────────

test('calibration: domains are measured separately', () => {
  const { calibrator } = harness();
  populateOverconfident(calibrator, 'arithmetic');
  populateWellCalibrated(calibrator, 'people');

  const arithmetic = calibrator.report('arithmetic');
  const people = calibrator.report('people');

  assert.equal(arithmetic.verdict, 'overconfident');
  assert.equal(people.verdict, 'well-calibrated');
  assert.deepEqual([...calibrator.domains].sort(), ['arithmetic', 'people']);
});

test('calibration: a global score would have hidden the difference', () => {
  const { calibrator } = harness();
  populateOverconfident(calibrator, 'arithmetic');
  populateWellCalibrated(calibrator, 'people');

  const overall = calibrator.report();
  assert.ok(overall.resolved > 0, 'the summary still exists');
  // Averaging a good domain with a bad one produces a number describing
  // neither, which is why the per-domain figure is the one that matters.
  assert.ok(overall.reliability > calibrator.report('people').reliability);
});

test('calibration: per-domain adjustment uses that domain alone', () => {
  const { calibrator } = harness();
  populateOverconfident(calibrator, 'arithmetic');
  populateWellCalibrated(calibrator, 'people');

  assert.ok(calibrator.adjustedConfidence(0.9, 'arithmetic') < 0.9, 'discounted where it is overconfident');
  assert.equal(calibrator.adjustedConfidence(0.9, 'people'), 0.9, 'left alone where it is accurate');
});

test('calibration: reportAll lists domains worst-calibrated first', () => {
  const { calibrator } = harness();
  populateOverconfident(calibrator, 'badly-off');
  populateWellCalibrated(calibrator, 'accurate');

  const reports = calibrator.reportAll();
  assert.equal(reports.length, 2);
  assert.ok(
    (reports[0]?.reliability ?? 0) >= (reports[1]?.reliability ?? 0),
    'the worst domain is reported first',
  );
});

// ── Bins and resolution ─────────────────────────────────────────────────────

test('calibration: the reliability diagram has one bin per populated band', () => {
  const { calibrator } = harness({ bins: 5 });
  for (let i = 0; i < 5; i += 1) {
    const prediction = calibrator.predict(`band ${i}`, (i + 0.5) / 5);
    calibrator.resolve(prediction.id, i < 2);
  }

  const report = calibrator.report();
  assert.equal(report.bins.length, 5);
  for (const bin of report.bins) {
    assert.ok(bin.count === 1);
    assert.ok(bin.from >= 0 && bin.to <= 1);
    assert.ok(bin.frequency === 0 || bin.frequency === 1);
  }
});

test('calibration: a confidence of exactly 1 lands in the top bin', () => {
  const { calibrator } = harness({ bins: 4 });
  const certain = calibrator.predict('a certainty', 1);
  calibrator.resolve(certain.id, true);

  const report = calibrator.report();
  assert.equal(report.bins.length, 1, 'the certainty is not dropped');
  assert.equal(report.bins[0]?.to, 1);
});

test('calibration: bin gaps carry the sign of the error', () => {
  const { calibrator } = harness();
  for (let i = 0; i < 10; i += 1) {
    const prediction = calibrator.predict(`sure thing ${i}`, 0.95);
    calibrator.resolve(prediction.id, false);
  }

  const bin = calibrator.report().bins[0];
  assert.ok(bin !== undefined);
  assert.ok(bin.gap > 0, 'claiming 95% and being wrong every time is overconfidence');
  assert.equal(bin.frequency, 0);
});

// ── Housekeeping ────────────────────────────────────────────────────────────

test('calibration: skill is measured against the base rate, not against zero', () => {
  const { calibrator } = harness();
  // Everything is true and the mind says so. Predicting a certain outcome
  // perfectly should not read as skill, because it required none.
  for (let i = 0; i < 10; i += 1) {
    const prediction = calibrator.predict('always true here', 1);
    calibrator.resolve(prediction.id, true);
  }

  const report = calibrator.report();
  assert.equal(report.brier, 0);
  assert.equal(report.baselineBrier, 0, 'the base rate is degenerate');
  assert.equal(report.skill, 1, 'and the degenerate case is handled explicitly');
});

test('calibration: pendingConfidence summarises what is still open', () => {
  const { calibrator } = harness();
  assert.equal(calibrator.pendingConfidence, 0);

  calibrator.predict('a', 0.8);
  calibrator.predict('b', 0.6);
  assert.ok(Math.abs(calibrator.pendingConfidence - 0.7) < 1e-9);

  const resolved = calibrator.predict('c', 0.2);
  calibrator.resolve(resolved.id, true);
  assert.ok(Math.abs(calibrator.pendingConfidence - 0.7) < 1e-9, 'settled predictions leave the average');
});

test('calibration: forget removes a prediction and its counts', () => {
  const { calibrator } = harness();
  const prediction = calibrator.predict('to be discarded', 0.7);
  calibrator.resolve(prediction.id, true);

  assert.equal(calibrator.forget(prediction.id), true);
  assert.equal(calibrator.forget(prediction.id), false);
  assert.equal(calibrator.resolvedCount, 0);
});

test('calibration: the record is bounded, shedding the oldest settled first', () => {
  const kernel = new Kernel();
  const calibrator = new Calibrator({ clock: kernel.clock, bus: kernel.bus, capacity: 16 });

  for (let i = 0; i < 100; i += 1) {
    const prediction = calibrator.predict(`claim ${i}`, 0.5);
    calibrator.resolve(prediction.id, i % 2 === 0);
    kernel.clock.step();
  }

  assert.ok(calibrator.resolvedCount <= 16, `held ${calibrator.resolvedCount}`);
});

test('calibration: clear resets everything', () => {
  const { calibrator } = harness();
  populateOverconfident(calibrator);
  calibrator.clear();

  assert.equal(calibrator.resolvedCount, 0);
  assert.equal(calibrator.pendingCount, 0);
  assert.deepEqual(calibrator.domains, []);
  assert.equal(calibrator.report().verdict, 'insufficient-data');
});

test('calibration: describe gives a one-line self-assessment', () => {
  const { calibrator } = harness();
  populateOverconfident(calibrator, 'planning');

  const line = calibrator.describe('planning');
  assert.match(line, /calibration\[planning/);
  assert.match(line, /overconfident/);
});

test('calibration: insufficient data is reported rather than guessed at', () => {
  const { calibrator } = harness({ minimumSamples: 20 });
  populateWellCalibrated(calibrator); // 100 predictions, but only if the bar allows

  const report = calibrator.report();
  assert.equal(report.resolved, 100);
  assert.equal(report.verdict, 'well-calibrated', '100 resolves clears a bar of 20');

  const sparse = harness({ minimumSamples: 200 });
  populateWellCalibrated(sparse.calibrator);
  assert.equal(
    sparse.calibrator.report().verdict,
    'insufficient-data',
    'a mind should not claim a verdict it has not earned',
  );
});

test('calibration: systematic but directionless error is called uninformative', () => {
  const { calibrator } = harness({ minimumSamples: 8 });
  // Half wildly overconfident, half wildly underconfident: large reliability
  // error with no consistent sign.
  for (let i = 0; i < 20; i += 1) {
    const over = calibrator.predict(`over ${i}`, 0.95);
    calibrator.resolve(over.id, false);
    const under = calibrator.predict(`under ${i}`, 0.05);
    calibrator.resolve(under.id, true);
  }

  const report = calibrator.report();
  assert.ok(Math.abs(report.bias) < 0.1, `the errors should cancel: ${report.bias}`);
  assert.ok(report.reliability > 0.5, `but the reliability error is large: ${report.reliability}`);
  assert.equal(report.verdict, 'uninformative');
});

test('calibration: the same predictions produce the same report', () => {
  const build = (): string => {
    const { calibrator } = harness();
    populateWellCalibrated(calibrator);
    return JSON.stringify(calibrator.report());
  };
  assert.equal(build(), build());
});
