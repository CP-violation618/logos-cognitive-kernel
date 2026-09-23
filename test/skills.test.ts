/**
 * LOGOS :: Skills :: Skill registry tests
 * ---------------------------------------------------------------------------
 * The claims under test, each of which is a design commitment:
 *   · SKILLS IMPROVE WITH PRACTICE, measurably;
 *   · PRACTICE MAKES A SKILL CHEAPER, not merely better — this is
 *     automatization, and it is the reason procedural memory is a separate
 *     system rather than a table of functions;
 *   · A FAILURE OF PRECONDITIONS IS NOT A FAILURE OF COMPETENCE, because
 *     conflating them teaches a mind to avoid things it is good at;
 *   · MASTERY FALLS FASTER THAN IT RISES, because success can be luck.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillRegistry, type SkillContext, type SkillStep } from '../src/skills/registry.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import { LogosError } from '../src/kernel/types.ts';

interface Rig {
  readonly kernel: Kernel;
  readonly skills: SkillRegistry;
}

const rig = (options: { readonly withScheduler?: boolean } = {}): Rig => {
  const kernel = new Kernel();
  const skills = new SkillRegistry({
    clock: kernel.clock,
    bus: kernel.bus,
    rng: kernel.rng,
    ...(options.withScheduler === true ? { scheduler: kernel.scheduler } : {}),
  });
  return { kernel, skills };
};

/** A context whose actions always succeed, recording what was attempted. */
const working = (state: Record<string, unknown> = {}, failOn?: string): SkillContext & { readonly log: string[] } => {
  const log: string[] = [];
  return {
    log,
    state,
    budget: 100,
    act: (name: string) => {
      log.push(name);
      return name !== failOn;
    },
  };
};

// ── Definition ──────────────────────────────────────────────────────────────

test('skills: a defined skill starts at its prior and is not yet competent', () => {
  const { skills } = rig();
  const skill = skills.define({
    name: 'restart the service',
    achieves: 'the service recovers',
    steps: [{ kind: 'action', name: 'stop' }, { kind: 'action', name: 'start' }],
    prior: 0.3,
  });

  assert.equal(skill.mastery, 0.3);
  assert.equal(skill.attempts, 0);
  assert.equal(skills.isCompetent('restart the service'), false);
});

test('skills: an empty name or empty step list is refused', () => {
  const { skills } = rig();
  assert.throws(() => skills.define({ name: '  ', steps: [{ kind: 'action', name: 'x' }] }), LogosError);
  assert.throws(() => skills.define({ name: 'a', steps: [] }), LogosError);
});

test('skills: a malformed step is refused at definition, not at execution', () => {
  const { skills } = rig();
  // Finding out that a skill is malformed halfway through attempting it wastes
  // the attempt and leaves the world in a partial state.
  assert.throws(() => skills.define({ name: 'bad', steps: [{ kind: 'action', name: '' }] }), LogosError);
  assert.throws(() => skills.define({ name: 'bad', steps: [{ kind: 'skill', name: '' }] }), LogosError);
  assert.throws(
    () => skills.define({ name: 'bad', steps: [{ kind: 'repeat', times: -1, body: [] }] }),
    LogosError,
  );
  assert.throws(
    () => skills.define({ name: 'bad', steps: [{ kind: 'repeat', times: 1.5, body: [] }] }),
    LogosError,
  );
  assert.throws(
    () =>
      skills.define({
        name: 'bad',
        steps: [
          { kind: 'branch', on: 'x', then: [{ kind: 'action', name: '' }] },
        ],
      }),
    LogosError,
  );
});

test('skills: an unrecognised step kind is refused', () => {
  const { skills } = rig();
  assert.throws(
    () => skills.define({ name: 'bad', steps: [{ kind: 'teleport' } as never] }),
    LogosError,
  );
});

test('skills: redefining a skill keeps its practice', () => {
  const { skills } = rig();
  skills.define({ name: 'deploy', steps: [{ kind: 'action', name: 'push' }] });
  const context = working();
  for (let i = 0; i < 5; i += 1) void skills.attempt('deploy', context);
  const practiced = skills.byName('deploy')?.mastery ?? 0;

  // Changing HOW something is done does not make a mind forget HOW TO do it.
  const redefined = skills.define({
    name: 'deploy',
    description: 'the new way',
    steps: [{ kind: 'action', name: 'push' }, { kind: 'action', name: 'verify' }],
  });

  assert.ok(redefined.mastery >= practiced - 1e-9, `mastery was lost: ${practiced} -> ${redefined.mastery}`);
  assert.equal(redefined.description, 'the new way');
  assert.equal(redefined.steps.length, 2);
});

test('skills: names are the interface and are unique', () => {
  const { skills } = rig();
  skills.define({ name: 'unique', steps: [{ kind: 'action', name: 'x' }] });
  skills.define({ name: 'unique', steps: [{ kind: 'action', name: 'y' }] });
  assert.equal(skills.size, 1);
});

test('skills: an inverted cost configuration is refused', () => {
  const kernel = new Kernel();
  assert.throws(
    () =>
      new SkillRegistry({
        clock: kernel.clock,
        bus: kernel.bus,
        rng: kernel.rng,
        baseCostPerStep: 1,
        floorCostPerStep: 5,
      }),
    LogosError,
  );
});

// ── Execution ───────────────────────────────────────────────────────────────

test('skills: a successful attempt runs every step and reports success', async () => {
  const { skills } = rig();
  skills.define({
    name: 'greet',
    steps: [{ kind: 'action', name: 'wave' }],
  });
  const context = working();

  const attempt = await skills.attempt('greet', context);
  assert.equal(attempt.succeeded, true);
  assert.equal(attempt.failure, undefined);
  assert.equal(attempt.steps, 1);
  assert.deepEqual(context.log, ['wave']);
});

test('skills: attempting an unknown skill is refused loudly', async () => {
  const { skills } = rig();
  await assert.rejects(async () => skills.attempt('nonexistent', working()), LogosError);
});

test('skills: the first failing action stops the procedure', async () => {
  const { skills } = rig();
  skills.define({
    name: 'three steps',
    steps: [
      { kind: 'action', name: 'one' },
      { kind: 'action', name: 'two' },
      { kind: 'action', name: 'three' },
    ],
  });
  const context = working({}, 'two');

  const attempt = await skills.attempt('three steps', context);
  assert.equal(attempt.succeeded, false);
  assert.equal(attempt.failure, 'execution-failed');
  assert.deepEqual(context.log, ['one', 'two'], 'the third step was not attempted');
});

test('skills: sub-skills are executed as part of the procedure', async () => {
  const { skills } = rig();
  skills.define({ name: 'inner', steps: [{ kind: 'action', name: 'inner-action' }] });
  skills.define({
    name: 'outer',
    steps: [{ kind: 'action', name: 'before' }, { kind: 'skill', name: 'inner' }, { kind: 'action', name: 'after' }],
  });
  const context = working();

  const attempt = await skills.attempt('outer', context);
  assert.equal(attempt.succeeded, true);
  assert.deepEqual(context.log, ['before', 'inner-action', 'after']);
});

test('skills: a branch picks the arm the world selects', async () => {
  const { skills } = rig();
  const steps: readonly SkillStep[] = [
    {
      kind: 'branch',
      on: 'doorLocked',
      then: [{ kind: 'action', name: 'unlock' }],
      otherwise: [{ kind: 'action', name: 'push' }],
    },
  ];
  skills.define({ name: 'enter', steps });

  const locked = working({ doorLocked: true });
  await skills.attempt('enter', locked);
  assert.deepEqual(locked.log, ['unlock']);

  const unlocked = working({ doorLocked: false });
  await skills.attempt('enter', unlocked);
  assert.deepEqual(unlocked.log, ['push']);
});

test('skills: a branch without an else arm does nothing when the condition is false', async () => {
  const { skills } = rig();
  skills.define({
    name: 'optional',
    steps: [{ kind: 'branch', on: 'flag', then: [{ kind: 'action', name: 'fire' }] }],
  });
  const context = working({ flag: false });

  const attempt = await skills.attempt('optional', context);
  assert.equal(attempt.succeeded, true);
  assert.deepEqual(context.log, []);
});

test('skills: repeat runs its body the requested number of times', async () => {
  const { skills } = rig();
  skills.define({
    name: 'patrol',
    steps: [{ kind: 'repeat', times: 3, body: [{ kind: 'action', name: 'check' }] }],
  });
  const context = working();

  await skills.attempt('patrol', context);
  assert.deepEqual(context.log, ['check', 'check', 'check']);
});

test('skills: a sub-skill failure fails the whole procedure', async () => {
  const { skills } = rig();
  skills.define({ name: 'inner', steps: [{ kind: 'action', name: 'explode' }] });
  skills.define({ name: 'outer', steps: [{ kind: 'skill', name: 'inner' }] });
  const context = working({}, 'explode');

  const attempt = await skills.attempt('outer', context);
  assert.equal(attempt.succeeded, false);
  assert.equal(attempt.failure, 'execution-failed');
});

test('skills: a reference to an unknown sub-skill is reported as malformed, not as failure', async () => {
  const { skills } = rig();
  skills.define({ name: 'calls a ghost', steps: [{ kind: 'skill', name: 'ghost' }] });

  const attempt = await skills.attempt('calls a ghost', working());
  assert.equal(attempt.succeeded, false);
  // `malformed` rather than `execution-failed`: this is a defect in the skill's
  // definition, not evidence about the mind's competence.
  assert.equal(attempt.failure, 'malformed');
});

test('skills: a malformed attempt does not move mastery', async () => {
  const { skills } = rig();
  skills.define({ name: 'broken', steps: [{ kind: 'skill', name: 'missing' }], prior: 0.5 });
  const before = skills.byName('broken')?.mastery ?? 0;

  await skills.attempt('broken', working());
  assert.equal(skills.byName('broken')?.mastery, before, 'a defect in the definition is not evidence about the mind');
  assert.equal(skills.byName('broken')?.attempts, 0);
});

test('skills: nesting is bounded rather than unbounded', async () => {
  const { skills } = rig();
  // A skill that calls itself, which would recurse forever without a bound.
  skills.define({ name: 'loop', steps: [{ kind: 'skill', name: 'loop' }, { kind: 'action', name: 'never' }] });

  const attempt = await skills.attempt('loop', working());
  assert.equal(attempt.succeeded, false);
  assert.equal(attempt.failure, 'malformed');
  assert.match(attempt.detail, /nesting/);
});

test('skills: exhaustion of attention interrupts rather than fails', async () => {
  const { skills } = rig();
  const many: SkillStep[] = [];
  for (let i = 0; i < 200; i += 1) many.push({ kind: 'action', name: `step-${i}` });
  skills.define({ name: 'the long haul', steps: many });

  // The caller's budget is what caps the attempt. A procedure with more steps
  // than there is attention for cannot be afforded, and the attempt is
  // interrupted partway rather than completed or refused outright.
  const before = skills.byName('the long haul')?.mastery ?? 0;
  const context = working();
  context.budget = 5;
  const attempt = await skills.attempt('the long haul', context);

  assert.equal(attempt.succeeded, false);
  assert.equal(attempt.failure, 'interrupted');
  assert.match(attempt.detail, /attention/);
  assert.ok(attempt.steps > 0, `some steps ran before the budget gave out: ${attempt.steps}`);
  assert.ok(attempt.steps < 200, `it did not run to the end: ${attempt.steps}`);

  // An interrupted attempt is genuinely inconclusive, so it is NOT evidence
  // about competence and does not move mastery.
  const skill = skills.byName('the long haul');
  assert.equal(skill?.attempts, 0, 'an interrupted attempt is not evidence either way');
  assert.equal(skill?.mastery, before, 'mastery is unchanged');
});

test('skills: a procedure longer than the available attention is interrupted, not attempted', async () => {
  const { skills } = rig();
  skills.define({
    name: 'needs a lot',
    steps: [
      { kind: 'action', name: 'a' },
      { kind: 'action', name: 'b' },
      { kind: 'action', name: 'c' },
    ],
    prior: 0.05,
  });
  const declared = skills.costOf('needs a lot');

  const context = working();
  context.budget = declared - 0.01; // just short of what it costs
  const attempt = await skills.attempt('needs a lot', context);

  assert.equal(attempt.failure, 'interrupted');
  assert.ok(context.log.length < 3, `not every step ran: ${context.log.join(', ')}`);
});

// ── Preconditions ───────────────────────────────────────────────────────────

test('skills: unmet preconditions stop the attempt without touching mastery', async () => {
  const { skills } = rig();
  skills.define({
    name: 'needs fuel',
    steps: [{ kind: 'action', name: 'ignite' }],
    preconditions: [{ key: 'fuel', above: 0 }],
    prior: 0.7,
  });

  const context = working({ fuel: 0 });
  const attempt = await skills.attempt('needs fuel', context);

  assert.equal(attempt.succeeded, false);
  assert.equal(attempt.failure, 'preconditions-unmet');
  assert.equal(attempt.masteryAfter, attempt.masteryBefore, 'the skill was not tried, so nothing was learned');
  assert.equal(attempt.cost, 0, 'nor was attention spent');
  assert.deepEqual(context.log, [], 'and nothing was done');

  const skill = skills.byName('needs fuel');
  assert.equal(skill?.attempts, 0, 'an inapplicable skill has not been attempted');
});

test('skills: preconditions cover present, equals, above and below', async () => {
  const { skills } = rig();
  const defs: readonly { readonly name: string; readonly pre: readonly { readonly key: string; readonly present?: boolean; readonly equals?: unknown; readonly above?: number; readonly below?: number }[]; readonly state: Record<string, unknown>; readonly applies: boolean }[] = [
    { name: 'needs present', pre: [{ key: 'a', present: true }], state: { a: 1 }, applies: true },
    { name: 'needs present', pre: [{ key: 'a', present: true }], state: {}, applies: false },
    { name: 'needs absent', pre: [{ key: 'a', present: false }], state: {}, applies: true },
    { name: 'needs absent', pre: [{ key: 'a', present: false }], state: { a: 1 }, applies: false },
    { name: 'needs equal', pre: [{ key: 'mode', equals: 'fast' }], state: { mode: 'fast' }, applies: true },
    { name: 'needs equal', pre: [{ key: 'mode', equals: 'fast' }], state: { mode: 'slow' }, applies: false },
    { name: 'needs above', pre: [{ key: 'n', above: 5 }], state: { n: 6 }, applies: true },
    { name: 'needs above', pre: [{ key: 'n', above: 5 }], state: { n: 5 }, applies: false },
    { name: 'needs below', pre: [{ key: 'n', below: 5 }], state: { n: 4 }, applies: true },
    { name: 'needs below', pre: [{ key: 'n', below: 5 }], state: { n: 'text' }, applies: false },
  ];

  for (const def of defs) {
    const result = skills.define({ name: def.name, steps: [{ kind: 'action', name: 'go' }], preconditions: def.pre });
    const attempt = await skills.attempt(result.name, working(def.state));
    assert.equal(
      attempt.succeeded,
      def.applies,
      `${def.name} with ${JSON.stringify(def.state)}: expected applies=${def.applies}, got failure=${attempt.failure ?? 'none'}`,
    );
  }
});

test('skills: an inapplicable attempt is announced separately from a failed one', async () => {
  const { kernel, skills } = rig();
  const events: string[] = [];
  kernel.bus.on('skill:*', (e) => events.push(e.type));

  skills.define({ name: 'conditional', steps: [{ kind: 'action', name: 'go' }], preconditions: [{ key: 'ready', present: true }] });
  await skills.attempt('conditional', working({}));

  // "I could not do this here" and "I tried and failed" are different facts, and
  // an architecture that could not tell them apart would learn the wrong lesson.
  assert.ok(events.includes('skill:inapplicable'));
  assert.ok(!events.includes('skill:failed'));
});

// ── Practice and learning ───────────────────────────────────────────────────

test('skills: mastery rises with success', async () => {
  const { skills } = rig();
  skills.define({ name: 'practice', steps: [{ kind: 'action', name: 'go' }], prior: 0.2 });
  const before = skills.byName('practice')?.mastery ?? 0;

  for (let i = 0; i < 5; i += 1) await skills.attempt('practice', working());

  const after = skills.byName('practice')?.mastery ?? 0;
  assert.ok(after > before, `${before} -> ${after}`);
});

test('skills: mastery falls with failure', async () => {
  const { skills } = rig();
  skills.define({ name: 'failing', steps: [{ kind: 'action', name: 'go' }], prior: 0.9 });
  const before = skills.byName('failing')?.mastery ?? 0;

  for (let i = 0; i < 3; i += 1) await skills.attempt('failing', working({}, 'go'));

  const after = skills.byName('failing')?.mastery ?? 0;
  assert.ok(after < before, `${before} -> ${after}`);
});

test('skills: mastery falls faster than it rises', async () => {
  const rising = rig();
  const falling = rig();
  rising.skills.define({ name: 's', steps: [{ kind: 'action', name: 'go' }], prior: 0.5 });
  falling.skills.define({ name: 's', steps: [{ kind: 'action', name: 'go' }], prior: 0.5 });

  await rising.skills.attempt('s', working());
  await falling.skills.attempt('s', working({}, 'go'));

  const gain = (rising.skills.byName('s')?.mastery ?? 0) - 0.5;
  const loss = 0.5 - (falling.skills.byName('s')?.mastery ?? 0);

  // Success can be luck; failure usually is not. A mind that forgot this would
  // be persistently overconfident about anything that happened to work once.
  assert.ok(loss > gain, `a failure should move mastery more than a success: +${gain} vs -${loss}`);
});

test('skills: mastery converges rather than oscillating', async () => {
  const { skills } = rig();
  skills.define({ name: 'converging', steps: [{ kind: 'action', name: 'go' }], prior: 0.5 });

  const readings: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    await skills.attempt('converging', working());
    readings.push(skills.byName('converging')?.mastery ?? 0);
  }

  const early = (readings[1] as number) - (readings[0] as number);
  const late = (readings[19] as number) - (readings[18] as number);
  assert.ok(early > late, `the step size should shrink: ${early} vs ${late}`);
  assert.ok((readings[19] as number) > 0.9, `repeated success should approach competence: ${readings[19]}`);
});

test('skills: a success streak lifts mastery beyond the raw ratio', async () => {
  const { skills } = rig();
  skills.define({ name: 'streaky', steps: [{ kind: 'action', name: 'go' }], prior: 0.5 });

  for (let i = 0; i < 5; i += 1) await skills.attempt('streaky', working());
  const skill = skills.byName('streaky');

  assert.ok(skill !== undefined);
  assert.ok(skill.streak >= 3, `streak was ${skill.streak}`);
  assert.ok(skill.mastery > 0.9, `a run of successes should read as fluent: ${skill.mastery}`);
});

test('skills: a failure resets the streak', async () => {
  const { skills } = rig();
  skills.define({ name: 'interrupted run', steps: [{ kind: 'action', name: 'go' }], prior: 0.5 });

  for (let i = 0; i < 4; i += 1) await skills.attempt('interrupted run', working());
  assert.ok((skills.byName('interrupted run')?.streak ?? 0) >= 3);

  await skills.attempt('interrupted run', working({}, 'go'));
  assert.equal(skills.byName('interrupted run')?.streak, 0);
});

test('skills: practice eventually makes a skill competent', async () => {
  const { skills } = rig();
  skills.define({ name: 'learnable', steps: [{ kind: 'action', name: 'go' }], prior: 0.1 });
  assert.equal(skills.isCompetent('learnable'), false);

  for (let i = 0; i < 6; i += 1) await skills.attempt('learnable', working());
  assert.equal(skills.isCompetent('learnable'), true, `mastery was ${skills.byName('learnable')?.mastery}`);
});

test('skills: counters are consistent with the outcome history', async () => {
  const { skills } = rig();
  skills.define({ name: 'mixed', steps: [{ kind: 'action', name: 'go' }], prior: 0.5 });

  for (let i = 0; i < 10; i += 1) {
    await skills.attempt('mixed', working({}, i % 3 === 0 ? 'go' : undefined));
  }

  const skill = skills.byName('mixed');
  assert.ok(skill !== undefined);
  assert.equal(skill.attempts, 10);
  assert.equal(skill.successes + skill.failures, skill.attempts);
  assert.deepEqual(skills.check(), []);
});

// ── Automatization: practice makes it cheaper ───────────────────────────────

test('skills: a mastered skill costs less attention than a novel one', async () => {
  const { skills } = rig();
  skills.define({ name: 'novel', steps: [{ kind: 'action', name: 'go' }], prior: 0.05 });
  skills.define({ name: 'fluent', steps: [{ kind: 'action', name: 'go' }], prior: 0.95 });

  const a = skills.costOf('novel');
  const b = skills.costOf('fluent');
  assert.ok(b < a, `fluency should be cheaper: ${b} vs ${a}`);
});

test('skills: attention cost falls as mastery is gained through practice', async () => {
  const { skills } = rig();
  skills.define({ name: 'getting good', steps: [{ kind: 'action', name: 'go' }], prior: 0.1 });
  const before = skills.costOf('getting good');

  for (let i = 0; i < 8; i += 1) await skills.attempt('getting good', working());
  const after = skills.costOf('getting good');

  // This is automatization, and it is the whole reason procedural memory is a
  // separate system: a mastered skill has stopped being deliberate, so the
  // scarce resource is freed for something else.
  assert.ok(after < before, `practice should make it cheaper: ${before} -> ${after}`);
});

test('skills: cost never falls below the configured floor', async () => {
  const { skills } = rig();
  skills.define({ name: 'perfected', steps: [{ kind: 'action', name: 'go' }], prior: 1 });
  assert.ok(skills.costOf('perfected') >= 0.15, `cost was ${skills.costOf('perfected')}`);
});

test('skills: a longer procedure costs more than a shorter one', async () => {
  const { skills } = rig();
  skills.define({ name: 'short', steps: [{ kind: 'action', name: 'a' }], prior: 0.3 });
  skills.define({
    name: 'long',
    steps: [
      { kind: 'action', name: 'a' },
      { kind: 'action', name: 'b' },
      { kind: 'action', name: 'c' },
    ],
    prior: 0.3,
  });

  assert.ok(skills.costOf('long') > skills.costOf('short'));
});

test('skills: an unknown skill has no affordable cost', () => {
  const { skills } = rig();
  assert.equal(skills.costOf('nonexistent'), Number.POSITIVE_INFINITY);
});

test('skills: total attention spent is accounted for', async () => {
  const { skills } = rig();
  skills.define({ name: 'work', steps: [{ kind: 'action', name: 'go' }], prior: 0.3 });
  await skills.attempt('work', working());
  await skills.attempt('work', working());

  assert.ok(skills.stats.attentionSpent > 0);
});

// ── Scheduled practice ──────────────────────────────────────────────────────

test('skills: an interruptible attempt is charged to the scheduler', async () => {
  const { kernel, skills } = rig({ withScheduler: true });
  skills.define({ name: 'scheduled', steps: [{ kind: 'action', name: 'go' }], prior: 0.3 });

  await kernel.start();
  const attempt = await skills.attempt('scheduled', working(), { interruptible: true });
  await kernel.stop();

  assert.equal(attempt.succeeded, true);
  assert.ok((kernel.scheduler.stats().completed ?? 0) >= 1, 'the attempt competed for attention');
});

test('skills: a fast attempt does not need the scheduler', async () => {
  const { skills } = rig();
  skills.define({ name: 'trivial', steps: [{ kind: 'action', name: 'go' }] });

  // Not every operation deserves a scheduler round trip; wrapping a lookup in
  // one would flood the bus with events describing nothing.
  const attempt = await skills.attempt('trivial', working());
  assert.equal(attempt.succeeded, true);
  assert.equal(attempt.steps, 1);
});

// ── Composition and discovery ───────────────────────────────────────────────

test('skills: a skill is discoverable by what it achieves', () => {
  const { skills } = rig();
  skills.define({ name: 'by hand', achieves: 'the door is open', steps: [{ kind: 'action', name: 'push' }], prior: 0.2 });
  skills.define({ name: 'with the key', achieves: 'the door is open', steps: [{ kind: 'action', name: 'unlock' }], prior: 0.9 });
  skills.define({ name: 'unrelated', achieves: 'the light is on', steps: [{ kind: 'action', name: 'flip' }] });

  const candidates = skills.forGoal('the door is open');
  assert.equal(candidates.length, 2);
  // Best-mastered first, because a mind reaching for a way to do something
  // should reach for what it is good at.
  assert.equal(candidates[0]?.name, 'with the key');
});

test('skills: discovery is case-insensitive and matches partial descriptions', () => {
  const { skills } = rig();
  skills.define({ name: 'a', achieves: 'The Door Is Open', steps: [{ kind: 'action', name: 'x' }] });
  assert.equal(skills.forGoal('door').length, 1);
  assert.equal(skills.forGoal('DOOR').length, 1);
});

test('skills: all() reports best-mastered first', () => {
  const { skills } = rig();
  skills.define({ name: 'weak', steps: [{ kind: 'action', name: 'x' }], prior: 0.1 });
  skills.define({ name: 'strong', steps: [{ kind: 'action', name: 'x' }], prior: 0.9 });

  assert.deepEqual(
    skills.all().map((s) => s.name),
    ['strong', 'weak'],
  );
});

test('skills: check() detects a reference to an unknown sub-skill', () => {
  const { skills } = rig();
  skills.define({ name: 'outer', steps: [{ kind: 'skill', name: 'never-defined' }] });

  const problems = skills.check();
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /never-defined/);
});

test('skills: check() is clean once the reference exists', () => {
  const { skills } = rig();
  skills.define({ name: 'inner', steps: [{ kind: 'action', name: 'x' }] });
  skills.define({ name: 'outer', steps: [{ kind: 'skill', name: 'inner' }] });
  assert.deepEqual(skills.check(), []);
});

// ── Bookkeeping ─────────────────────────────────────────────────────────────

test('skills: forgetting removes a skill and its name binding', () => {
  const { skills } = rig();
  skills.define({ name: 'temporary', steps: [{ kind: 'action', name: 'x' }] });

  assert.equal(skills.forget('temporary'), true);
  assert.equal(skills.forget('temporary'), false);
  assert.equal(skills.byName('temporary'), undefined);
  assert.equal(skills.size, 0);
});

test('skills: clear resets everything including counters', async () => {
  const { skills } = rig();
  skills.define({ name: 'a', steps: [{ kind: 'action', name: 'x' }] });
  await skills.attempt('a', working());
  skills.clear();

  assert.equal(skills.size, 0);
  assert.equal(skills.stats.attempts, 0);
  assert.equal(skills.stats.attentionSpent, 0);
});

test('skills: stats are internally consistent', async () => {
  const { skills } = rig();
  skills.define({ name: 'one', steps: [{ kind: 'action', name: 'x' }], prior: 0.2 });
  skills.define({ name: 'two', steps: [{ kind: 'action', name: 'y' }], prior: 0.8 });

  for (let i = 0; i < 6; i += 1) await skills.attempt('one', working());
  for (let i = 0; i < 4; i += 1) await skills.attempt('two', working({}, 'y'));

  const stats = skills.stats;
  assert.equal(stats.skills, 2);
  assert.equal(stats.attempts, 10);
  assert.equal(stats.successes + stats.failures, stats.attempts);
  assert.ok(stats.meanMastery >= 0 && stats.meanMastery <= 1);
  assert.ok(stats.competent >= 1);
});

test('skills: describe gives a one-line summary', () => {
  const { skills } = rig();
  skills.define({ name: 'a', steps: [{ kind: 'action', name: 'x' }] });
  assert.match(skills.describe(), /skills\[n=1/);
});

test('skills: attempts are announced on the bus with their outcome', async () => {
  const { kernel, skills } = rig();
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  kernel.bus.on('skill:*', (e) => events.push({ type: e.type, payload: { ...e.payload } }));

  skills.define({ name: 'announced', steps: [{ kind: 'action', name: 'go' }] });
  await skills.attempt('announced', working());

  const succeeded = events.find((e) => e.type === 'skill:succeeded');
  assert.ok(succeeded !== undefined);
  assert.equal(succeeded.payload['name'], 'announced');
  assert.equal(typeof succeeded.payload['mastery'], 'number');
});

test('skills: the same practice sequence produces the same mastery curve', async () => {
  const run = async (): Promise<string> => {
    const { skills } = rig();
    skills.define({ name: 's', steps: [{ kind: 'action', name: 'go' }], prior: 0.4 });
    const curve: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      await skills.attempt('s', working({}, i % 4 === 0 ? 'go' : undefined));
      curve.push(skills.byName('s')?.mastery ?? 0);
    }
    return curve.map((m) => m.toFixed(6)).join(',');
  };

  assert.equal(await run(), await run());
});
