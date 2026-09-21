/**
 * LOGOS :: Planning :: Goals and planner tests
 * ---------------------------------------------------------------------------
 * Two families of claim under test.
 *
 * GOALS: structure propagates (achieving subgoals achieves the parent),
 * priority is a judgement rather than a stored number, deadlines create
 * urgency, and abandonment is a reasoned act rather than a timeout.
 *
 * PLANNING: decomposition is recursive with backtracking, preconditions are
 * checked against the evolving state, cycles are caught rather than exhausted,
 * and failure explains itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { GoalSystem } from '../src/planning/goals.ts';
import {
  Planner,
  conditionHolds,
  applyEffects,
  describePlan,
  flattenSteps,
  unmetConditions,
} from '../src/planning/planner.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import { LogosError, tick as mkTick } from '../src/kernel/types.ts';

const goalRig = (options: { readonly maxActive?: number; readonly stallTicks?: number } = {}): {
  readonly kernel: Kernel;
  readonly goals: GoalSystem;
} => {
  const kernel = new Kernel();
  const goals = new GoalSystem({
    clock: kernel.clock,
    bus: kernel.bus,
    ...options,
  });
  return { kernel, goals };
};

const planRig = (options: { readonly maxDepth?: number; readonly maxNodes?: number } = {}): {
  readonly kernel: Kernel;
  readonly planner: Planner;
} => {
  const kernel = new Kernel();
  const planner = new Planner({ clock: kernel.clock, bus: kernel.bus, ...options });
  return { kernel, planner };
};

// ═══════════════════════════════════════════════════════════════════════════
// Goals
// ═══════════════════════════════════════════════════════════════════════════

test('goals: a declared goal starts pending with its stated utility', () => {
  const { goals } = goalRig();
  const goal = goals.declare('the report is delivered', { utility: 0.8 });

  assert.equal(goal.status, 'pending');
  assert.equal(goal.utility, 0.8);
  assert.equal(goal.cost, 0);
  assert.deepEqual(goal.children, []);
});

test('goals: an empty description is refused', () => {
  const { goals } = goalRig();
  assert.throws(() => goals.declare('   '), LogosError);
});

test('goals: subgoals inherit depth and record their parent', () => {
  const { goals } = goalRig();
  const parent = goals.declare('ship the release');
  const child = goals.declare('the tests pass', { parent: parent.id });

  assert.equal(child.parent, parent.id);
  assert.equal(child.depth, 1);
  assert.deepEqual(goals.get(parent.id)?.children, [child.id]);
  assert.deepEqual(goals.check(), []);
});

test('goals: decomposition beyond the depth limit is refused', () => {
  const { goals } = goalRig();
  // The default limit is 6, so levels 0..6 are legal and level 7 is not.
  let parent = goals.declare('level 0');
  for (let i = 1; i <= 6; i += 1) {
    parent = goals.declare(`level ${i}`, { parent: parent.id });
  }
  assert.equal(parent.depth, 6, 'the last legal level was created');

  const deepest = parent;
  assert.throws(() => goals.declare('one level too many', { parent: deepest.id }), LogosError);
});

test('goals: a missing parent is refused rather than silently ignored', () => {
  const { goals } = goalRig();
  assert.throws(() => goals.declare('orphan', { parent: 'goal_does_not_exist' }), LogosError);
});

test('goals: achieving every subgoal achieves an "all" parent', () => {
  const { goals } = goalRig();
  const parent = goals.declare('the launch succeeds', { composition: 'all' });
  const a = goals.declare('the rocket is fuelled', { parent: parent.id });
  const b = goals.declare('the weather is clear', { parent: parent.id });

  goals.achieve(a.id);
  assert.equal(goals.get(parent.id)?.status, 'pending', 'one of two is not enough');

  goals.achieve(b.id);
  assert.equal(goals.get(parent.id)?.status, 'achieved', 'the parent completes when all children do');
});

test('goals: achieving one subgoal achieves an "any" parent', () => {
  const { goals } = goalRig();
  const parent = goals.declare('the parcel arrives', { composition: 'any' });
  const a = goals.declare('by courier', { parent: parent.id });
  goals.declare('by post', { parent: parent.id });

  goals.achieve(a.id);
  assert.equal(goals.get(parent.id)?.status, 'achieved');
});

test('goals: completion propagates through several levels', () => {
  const { goals } = goalRig();
  const root = goals.declare('the mission is complete');
  const middle = goals.declare('every stage is complete', { parent: root.id });
  const leaf = goals.declare('the final stage is complete', { parent: middle.id });

  goals.achieve(leaf.id);

  assert.equal(goals.get(middle.id)?.status, 'achieved');
  assert.equal(goals.get(root.id)?.status, 'achieved', 'success rolled all the way up');
});

test('goals: failing a required subgoal fails an "all" parent', () => {
  const { goals } = goalRig();
  const parent = goals.declare('the plan works', { composition: 'all' });
  const a = goals.declare('step one', { parent: parent.id });
  goals.declare('step two', { parent: parent.id });

  goals.fail(a.id, 'the resource was unavailable');

  assert.equal(goals.get(parent.id)?.status, 'failed');
  assert.match(goals.get(parent.id)?.outcome ?? '', /required subgoal/);
});

test('goals: failing one route does not fail an "any" parent', () => {
  const { goals } = goalRig();
  const parent = goals.declare('the parcel arrives', { composition: 'any' });
  const a = goals.declare('by courier', { parent: parent.id });
  const b = goals.declare('by post', { parent: parent.id });

  goals.fail(a.id, 'the courier is on strike');
  assert.notEqual(goals.get(parent.id)?.status, 'failed', 'another route remains');

  goals.achieve(b.id);
  assert.equal(goals.get(parent.id)?.status, 'achieved');
});

test('goals: a terminal goal ignores further transitions', () => {
  const { goals } = goalRig();
  const goal = goals.declare('finished business');
  goals.achieve(goal.id);
  goals.fail(goal.id, 'too late');
  assert.equal(goals.get(goal.id)?.status, 'achieved', 'the first outcome stands');
});

// ── dependencies and attention ──────────────────────────────────────────────

test('goals: an unmet prerequisite blocks activation rather than failing it', () => {
  const { goals } = goalRig();
  const foundation = goals.declare('the foundation is poured');
  const building = goals.declare('the walls are up', { requires: [foundation.id] });

  const activated = goals.activate(building.id);
  assert.equal(activated?.status, 'blocked', 'blocked is not failed — the goal is still wanted');
  assert.match(activated?.outcome ?? '', /prerequisite/);

  goals.achieve(foundation.id);
  const retried = goals.activate(building.id);
  assert.equal(retried?.status, 'active');
});

test('goals: requiring a missing goal is refused', () => {
  const { goals } = goalRig();
  assert.throws(() => goals.declare('needs a ghost', { requires: ['goal_missing'] }), LogosError);
});

test('goals: no more than maxActive goals are pursued at once', () => {
  const { goals } = goalRig({ maxActive: 2 });
  const ids = ['a', 'b', 'c', 'd'].map((name) => goals.declare(`objective ${name}`, { utility: 0.5 }).id);

  const promoted = goals.schedule();
  assert.equal(promoted.length, 2);
  assert.equal(goals.activeCount, 2);

  // Finishing one frees a slot.
  goals.achieve(ids[0] as string);
  const more = goals.schedule();
  assert.equal(more.length, 1, 'the next goal starts when attention frees up');
  assert.equal(goals.activeCount, 2);
});

test('goals: a goal can be suspended without being abandoned', () => {
  const { goals } = goalRig();
  const goal = goals.declare('a lower priority matter');
  goals.activate(goal.id);
  goals.suspend(goal.id, 'something else came up');

  const suspended = goals.get(goal.id);
  assert.equal(suspended?.status, 'suspended');
  assert.equal(goals.abandonments.length, 0, 'setting aside is not giving up');
});

test('goals: a "not before" instant holds pursuit until it passes', () => {
  const { kernel, goals } = goalRig();
  const goal = goals.declare('a scheduled task', { notBefore: mkTick(20) });

  assert.equal(goals.activate(goal.id)?.status, 'blocked');
  kernel.clock.advance(20);
  assert.equal(goals.activate(goal.id)?.status, 'active');
});

// ── priority ────────────────────────────────────────────────────────────────

test('goals: a more valuable goal has higher priority, all else equal', () => {
  const { goals } = goalRig();
  const cheap = goals.declare('a minor convenience', { utility: 0.2 });
  const dear = goals.declare('a critical objective', { utility: 0.95 });

  assert.ok((goals.get(dear.id)?.priority ?? 0) > (goals.get(cheap.id)?.priority ?? 0));
});

test('goals: an achievable goal outranks an equally valuable impossible one', () => {
  const { goals } = goalRig();
  const doable = goals.declare('something within reach', { utility: 0.8 });
  const hopeless = goals.declare('something out of reach', { utility: 0.8 });

  goals.setFeasibility(doable.id, 0.95);
  goals.setFeasibility(hopeless.id, 0.05);

  assert.ok((goals.get(doable.id)?.priority ?? 0) > (goals.get(hopeless.id)?.priority ?? 0));
});

test('goals: a deadline makes a goal urgent as it approaches', () => {
  const { kernel, goals } = goalRig();
  const goal = goals.declare('a deadline-driven task', { utility: 0.5, deadline: mkTick(100) });
  const early = goals.get(goal.id)?.priority ?? 0;

  kernel.clock.advance(90);
  goals.setFeasibility(goal.id, 0.5); // triggers a reprioritise without changing feasibility
  const late = goals.get(goal.id)?.priority ?? 0;

  assert.ok(late > early, `urgency should grow: ${early} -> ${late}`);
});

test('goals: an overdue goal is maximally urgent', () => {
  const { kernel, goals } = goalRig();
  const goal = goals.declare('the overdue task', { utility: 0.5, deadline: mkTick(10) });
  kernel.clock.advance(50);
  goals.setFeasibility(goal.id, 0.5);

  const overdue = goals.get(goal.id)?.priority ?? 0;
  const fresh = goals.declare('a task with time to spare', { utility: 0.5, deadline: mkTick(5_000) });
  assert.ok(overdue > (goals.get(fresh.id)?.priority ?? 0));
});

test('goals: sunk cost raises priority but cannot dominate it', () => {
  const { goals } = goalRig();
  const invested = goals.declare('a goal already paid for', { utility: 0.3 });
  const fresh = goals.declare('a goal not yet started', { utility: 0.3 });

  goals.chargeCost(invested.id, 100);
  assert.ok(
    (goals.get(invested.id)?.priority ?? 0) > (goals.get(fresh.id)?.priority ?? 0),
    'effort already spent is a reason to continue',
  );

  const muchBetter = goals.declare('a far more valuable goal', { utility: 1 });
  assert.ok(
    (goals.get(muchBetter.id)?.priority ?? 0) > (goals.get(invested.id)?.priority ?? 0),
    'but it must not trap the mind in a poor commitment',
  );
});

test('goals: a goal under a dead ancestor is suppressed', () => {
  const { goals } = goalRig();
  const parent = goals.declare('an objective that will be abandoned');
  const child = goals.declare('a subgoal of it', { parent: parent.id, utility: 1 });

  const before = goals.get(child.id)?.priority ?? 0;
  goals.abandon(parent.id, 'no longer worth pursuing');

  assert.ok(
    (goals.get(child.id)?.priority ?? 0) < before,
    'pursuing a subgoal of a dead objective is wasted effort however attractive it looks',
  );
});

test('goals: focus returns only active goals, best first', () => {
  const { goals } = goalRig({ maxActive: 2 });
  goals.declare('low value', { utility: 0.1 });
  goals.declare('high value', { utility: 0.9 });
  goals.declare('middle value', { utility: 0.5 });
  goals.schedule();

  const focused = goals.focus();
  assert.equal(focused.length, 2);
  assert.match(focused[0]?.description ?? '', /high value/);
  assert.ok(focused.every((g) => g.status === 'active'));
});

// ── abandonment ─────────────────────────────────────────────────────────────

test('goals: abandonment records the reason and the arithmetic behind it', () => {
  const { goals } = goalRig();
  const goal = goals.declare('a doubtful objective', { utility: 0.9 });
  goals.activate(goal.id);
  goals.setFeasibility(goal.id, 0.5);

  const abandoned = goals.abandon(goal.id, 'the window has closed');
  assert.equal(abandoned?.status, 'abandoned');
  assert.match(abandoned?.outcome ?? '', /window has closed/);

  const record = goals.abandonments.at(-1);
  assert.ok(record !== undefined);
  assert.equal(record.reason, 'the window has closed');
  assert.equal(typeof record.expectedValue, 'number');
  assert.equal(typeof record.cost, 'number');
});

test('goals: review abandons a goal whose expected value has collapsed', () => {
  const { goals } = goalRig();
  const goal = goals.declare('a goal that lost its point', { utility: 0.4 });
  goals.activate(goal.id);
  goals.setFeasibility(goal.id, 0.9);
  assert.equal(goals.get(goal.id)?.status, 'active');

  goals.setFeasibility(goal.id, 0.01);
  const abandoned = goals.review();

  assert.equal(abandoned.length, 1);
  assert.equal(goals.get(goal.id)?.status, 'abandoned');
  assert.match(abandoned[0]?.reason ?? '', /expected value/);
});

test('goals: review abandons subgoals of an abandoned objective', () => {
  const { goals } = goalRig();
  const parent = goals.declare('the main objective');
  const child = goals.declare('a supporting subgoal', { parent: parent.id });

  goals.abandon(parent.id, 'circumstances changed');
  goals.review();

  assert.equal(goals.get(child.id)?.status, 'abandoned');
  assert.match(goals.get(child.id)?.outcome ?? '', /parent objective/);
});

test('goals: a stalled active goal is reported as blocked, not silently kept', () => {
  const { kernel, goals } = goalRig({ stallTicks: 10 });
  const goal = goals.declare('a goal that goes nowhere');
  goals.activate(goal.id);

  kernel.clock.advance(20);
  goals.review();

  assert.equal(goals.get(goal.id)?.status, 'blocked');
  assert.match(goals.get(goal.id)?.outcome ?? '', /no progress/);
});

test('goals: noting progress prevents a stall', () => {
  const { kernel, goals } = goalRig({ stallTicks: 10 });
  const goal = goals.declare('a goal with steady progress');
  goals.activate(goal.id);

  for (let i = 0; i < 5; i += 1) {
    kernel.clock.advance(8);
    goals.noteProgress(goal.id);
    goals.review();
  }
  assert.equal(goals.get(goal.id)?.status, 'active');
});

test('goals: charging a negative cost is refused', () => {
  const { goals } = goalRig();
  const goal = goals.declare('a goal');
  assert.throws(() => goals.chargeCost(goal.id, -1), LogosError);
});

// ── conflicts ───────────────────────────────────────────────────────────────

test('goals: a declared conflict is reported rather than resolved silently', () => {
  const { goals } = goalRig();
  const a = goals.declare('spend the budget on research');
  const b = goals.declare('spend the budget on marketing', { conflictsWith: [a.id] });

  const conflicts = goals.conflicts();
  assert.equal(conflicts.length, 1);
  assert.ok([conflicts[0]?.a.id, conflicts[0]?.b.id].includes(a.id));
  assert.ok([conflicts[0]?.a.id, conflicts[0]?.b.id].includes(b.id));
});

test('goals: a terminal goal stops conflicting', () => {
  const { goals } = goalRig();
  const a = goals.declare('option one');
  const b = goals.declare('option two', { conflictsWith: [a.id] });

  goals.achieve(a.id);
  assert.equal(goals.conflicts().length, 0, 'a settled question conflicts with nothing');
  void b;
});

// ── housekeeping ────────────────────────────────────────────────────────────

test('goals: ancestry reports the chain from the root', () => {
  const { goals } = goalRig();
  const root = goals.declare('the root objective');
  const middle = goals.declare('a middle objective', { parent: root.id });
  const leaf = goals.declare('a leaf objective', { parent: middle.id });

  const chain = goals.ancestry(leaf.id).map((g) => g.description);
  assert.deepEqual(chain, ['the root objective', 'a middle objective', 'a leaf objective']);
});

test('goals: forgetting a parent orphans its children rather than deleting them', () => {
  const { goals } = goalRig();
  const parent = goals.declare('a parent');
  const child = goals.declare('a child', { parent: parent.id });

  goals.forget(parent.id);
  assert.equal(goals.get(child.id)?.parent, undefined, 'the child survives, promoted to the root');
  assert.deepEqual(goals.check(), []);
});

test('goals: check() is clean after ordinary use', () => {
  const { goals } = goalRig();
  const root = goals.declare('a root');
  const a = goals.declare('first branch', { parent: root.id });
  const b = goals.declare('second branch', { parent: root.id, requires: [a.id] });
  goals.achieve(a.id);
  goals.activate(b.id);
  assert.deepEqual(goals.check(), []);
});

test('goals: stats and describe are consistent', () => {
  const { goals } = goalRig();
  goals.declare('one');
  const two = goals.declare('two');
  goals.achieve(two.id);

  const stats = goals.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.achieved, 1);
  assert.match(goals.describe(), /goals\[n=2/);
});

// ═══════════════════════════════════════════════════════════════════════════
// Planner
// ═══════════════════════════════════════════════════════════════════════════

test('planner: a primitive method produces a plan of its actions', () => {
  const { planner } = planRig();
  planner.defineAction({ name: 'unlock the door', cost: 1 });
  planner.defineAction({ name: 'open the door', cost: 1 });
  planner.defineMethod({
    name: 'enter by the door',
    task: 'get inside',
    actions: ['unlock the door', 'open the door'],
  });

  const outcome = planner.plan('get inside', {});
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.plan.steps.length, 2);
  assert.equal(outcome.plan.steps[0]?.action.name, 'unlock the door');
  assert.equal(outcome.plan.cost, 2);
});

test('planner: a compound method decomposes recursively', () => {
  const { planner } = planRig();
  planner.defineAction({ name: 'boil water' });
  planner.defineAction({ name: 'add coffee' });
  planner.defineAction({ name: 'pour' });

  planner.defineMethod({ name: 'brew', task: 'make coffee', actions: ['boil water', 'add coffee'] });
  planner.defineMethod({ name: 'serve', task: 'have a drink', subtasks: ['make coffee', 'pour it'] });
  planner.defineMethod({ name: 'pour it', task: 'pour it', actions: ['pour'] });

  const outcome = planner.plan('have a drink', {});
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.plan.steps.length, 3);
  assert.ok(outcome.plan.depth >= 2, `decomposition should nest: depth ${outcome.plan.depth}`);
});

test('planner: preconditions are checked against the state', () => {
  const { planner } = planRig();
  planner.defineAction({ name: 'ignite', preconditions: [{ key: 'fuel', above: 0 }] });
  planner.defineMethod({ name: 'light it', task: 'start the engine', actions: ['ignite'] });

  const without = planner.plan('start the engine', { fuel: 0 });
  assert.equal(without.ok, false);
  if (!without.ok) assert.equal(without.failure.reason, 'preconditions-unmet');

  const withFuel = planner.plan('start the engine', { fuel: 5 });
  assert.equal(withFuel.ok, true);
});

test('planner: a method is skipped when its own preconditions fail, and the next is tried', () => {
  const { planner } = planRig();
  planner.defineAction({ name: 'take the lift' });
  planner.defineAction({ name: 'take the stairs' });

  planner.defineMethod({
    name: 'by lift',
    task: 'reach the fourth floor',
    priority: 0.9,
    preconditions: [{ key: 'liftWorking' }],
    actions: ['take the lift'],
  });
  planner.defineMethod({
    name: 'by stairs',
    task: 'reach the fourth floor',
    priority: 0.1,
    actions: ['take the stairs'],
  });

  const outcome = planner.plan('reach the fourth floor', { liftWorking: false });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.plan.root.method, 'by stairs', 'the fallback route was taken');
  assert.equal(outcome.plan.steps[0]?.action.name, 'take the stairs');
});

test('planner: the highest-priority applicable method wins', () => {
  const { planner } = planRig();
  planner.defineAction({ name: 'the preferred action' });
  planner.defineAction({ name: 'the fallback action' });
  planner.defineMethod({ name: 'preferred', task: 'do it', priority: 0.9, actions: ['the preferred action'] });
  planner.defineMethod({ name: 'fallback', task: 'do it', priority: 0.1, actions: ['the fallback action'] });

  const outcome = planner.plan('do it', {});
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.plan.root.method, 'preferred');
});

test('planner: effects of earlier actions satisfy later preconditions', () => {
  const { planner } = planRig();
  planner.defineAction({ name: 'fetch the key', effects: [{ key: 'hasKey', set: true }] });
  planner.defineAction({ name: 'unlock', preconditions: [{ key: 'hasKey' }] });

  planner.defineMethod({ name: 'route', task: 'open the safe', actions: ['fetch the key', 'unlock'] });

  const without = planner.plan('open the safe', {});
  assert.equal(without.ok, true, 'the method sequences the effects itself');

  // And with the action order reversed, the precondition genuinely fails.
  planner.defineMethod({ name: 'backwards', task: 'open the safe badly', actions: ['unlock', 'fetch the key'] });
  const bad = planner.plan('open the safe badly', {});
  assert.equal(bad.ok, false);
});

test('planner: a recursive method graph is detected rather than exhausted', () => {
  const { planner } = planRig({ maxDepth: 100, maxNodes: 100_000 });
  planner.defineMethod({ name: 'loop a', task: 'task a', subtasks: ['task b'] });
  planner.defineMethod({ name: 'loop b', task: 'task b', subtasks: ['task a'] });

  const outcome = planner.plan('task a', {});
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(
    outcome.failure.attempts < 20,
    `a cycle must be caught immediately, not explored to the depth limit: ${outcome.failure.attempts} attempts`,
  );
  assert.ok(outcome.failure.rejected.some((r) => r.reason.includes('recursive')));
});

test('planner: the depth limit is enforced and reported', () => {
  const { planner } = planRig({ maxDepth: 3 });
  for (let i = 0; i < 10; i += 1) {
    planner.defineMethod({ name: `level ${i}`, task: `level ${i}`, subtasks: [`level ${i + 1}`] });
  }
  planner.defineAction({ name: 'terminal' });
  planner.defineMethod({ name: 'bottom', task: 'level 10', actions: ['terminal'] });

  const outcome = planner.plan('level 0', {});
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(['depth-exceeded', 'no-method'].includes(outcome.failure.reason));
});

test('planner: planning a task with no methods explains itself', () => {
  const { planner } = planRig();
  const outcome = planner.plan('an impossible task', {});

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure.reason, 'no-method');
  assert.match(outcome.failure.detail, /no method/i);
});

test('planner: an undefined action is reported rather than silently skipped', () => {
  const { planner } = planRig();
  planner.defineMethod({ name: 'broken', task: 'do the thing', actions: ['a nonexistent action'] });

  const outcome = planner.plan('do the thing', {});
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure.reason, 'missing-action');
  assert.ok(outcome.failure.rejected.some((r) => r.reason.includes('not defined')));
});

test('planner: a method supplying both subtasks and actions is refused', () => {
  const { planner } = planRig();
  assert.throws(
    () => planner.defineMethod({ name: 'confused', task: 't', subtasks: ['a'], actions: ['b'] }),
    LogosError,
  );
  assert.throws(() => planner.defineMethod({ name: 'empty', task: 't' }), LogosError);
});

test('planner: an empty goal is refused loudly', () => {
  const { planner } = planRig();
  assert.throws(() => planner.plan('  ', {}), LogosError);
});

// ── confidence ──────────────────────────────────────────────────────────────

test('planner: plan confidence is the product of its steps by default', () => {
  const { planner } = planRig();
  planner.defineAction({ name: 'a', reliability: 0.5 });
  planner.defineAction({ name: 'b', reliability: 0.5 });
  planner.defineMethod({ name: 'chain', task: 'risky', confidence: 1, actions: ['a', 'b'] });

  const outcome = planner.plan('risky', {});
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  // A chain's reliability is the product of its links, and reporting the
  // average would hide how badly length erodes it.
  assert.ok(Math.abs(outcome.plan.confidence - 0.25) < 1e-9, `got ${outcome.plan.confidence}`);
});

test('planner: a long chain of near-certain steps is honestly reported as uncertain', () => {
  const { planner } = planRig();
  const names: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    names.push(`step ${i}`);
    planner.defineAction({ name: `step ${i}`, reliability: 0.95 });
  }
  planner.defineMethod({ name: 'long', task: 'the long haul', confidence: 1, actions: names });

  const outcome = planner.plan('the long haul', {});
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.ok(outcome.plan.confidence < 0.4, `twenty 95% steps is not a reliable plan: ${outcome.plan.confidence}`);
});

test('planner: the minimum mode takes the weakest step', () => {
  const kernel = new Kernel();
  const planner = new Planner({ clock: kernel.clock, bus: kernel.bus, confidenceMode: 'minimum' });
  planner.defineAction({ name: 'sure', reliability: 0.9 });
  planner.defineAction({ name: 'doubtful', reliability: 0.3 });
  planner.defineMethod({ name: 'mixed', task: 'uneven', confidence: 1, actions: ['sure', 'doubtful'] });

  const outcome = planner.plan('uneven', {});
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.ok(Math.abs(outcome.plan.confidence - 0.3) < 1e-9);
});

// ── inspection ──────────────────────────────────────────────────────────────

test('planner: flattenSteps lists primitive actions in execution order', () => {
  const { planner } = planRig();
  planner.defineAction({ name: 'first' });
  planner.defineAction({ name: 'second' });
  planner.defineAction({ name: 'third' });
  planner.defineMethod({ name: 'one', task: 'part one', actions: ['first', 'second'] });
  planner.defineMethod({ name: 'whole', task: 'everything', subtasks: ['part one', 'part two'] });
  planner.defineMethod({ name: 'two', task: 'part two', actions: ['third'] });

  const outcome = planner.plan('everything', {});
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.deepEqual(
    outcome.plan.steps.map((s) => s.action.name),
    ['first', 'second', 'third'],
  );
  assert.deepEqual(
    outcome.plan.steps.map((s) => s.index),
    [0, 1, 2],
  );
});

test('planner: describePlan renders an indented tree', () => {
  const { planner } = planRig();
  planner.defineAction({ name: 'the final step' });
  planner.defineMethod({ name: 'simple', task: 'a task', actions: ['the final step'] });

  const outcome = planner.plan('a task', {});
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const rendered = describePlan(outcome.plan);
  assert.match(rendered, /plan plan1 for "a task"/);
  assert.match(rendered, /the final step/);
});

test('planner: flattenSteps can be called on a node directly', () => {
  const { planner } = planRig();
  planner.defineAction({ name: 'only' });
  planner.defineMethod({ name: 'm', task: 't', actions: ['only'] });

  const outcome = planner.plan('t', {});
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const steps = flattenSteps(outcome.plan.root);
  assert.equal(steps.length, 1);
});

test('planner: plans are announced on the bus, success and failure alike', () => {
  const { kernel, planner } = planRig();
  const events: string[] = [];
  kernel.bus.on('planning:*', (e) => events.push(e.type));

  planner.defineAction({ name: 'work' });
  planner.defineMethod({ name: 'm', task: 'possible', actions: ['work'] });
  planner.plan('possible', {});
  planner.plan('impossible', {});

  assert.ok(events.includes('planning:succeeded'));
  assert.ok(events.includes('planning:failed'));
});

// ── state helpers ───────────────────────────────────────────────────────────

test('planner: conditionHolds covers every operator', () => {
  const state = { flag: true, off: false, count: 5, name: 'x' };

  assert.equal(conditionHolds({ key: 'flag' }, state), true);
  assert.equal(conditionHolds({ key: 'off' }, state), false);
  assert.equal(conditionHolds({ key: 'missing' }, state), false);
  assert.equal(conditionHolds({ key: 'missing', absent: true }, state), true);
  assert.equal(conditionHolds({ key: 'off', absent: true }, state), true, 'falsy counts as absent');
  assert.equal(conditionHolds({ key: 'name', equals: 'x' }, state), true);
  assert.equal(conditionHolds({ key: 'name', equals: 'y' }, state), false);
  assert.equal(conditionHolds({ key: 'count', above: 4 }, state), true);
  assert.equal(conditionHolds({ key: 'count', above: 5 }, state), false);
  assert.equal(conditionHolds({ key: 'count', below: 6 }, state), true);
  assert.equal(conditionHolds({ key: 'count', below: 5 }, state), false);
});

test('planner: deep equality is used for structured values', () => {
  const state = { config: { a: 1, b: [1, 2] } };
  assert.equal(conditionHolds({ key: 'config', equals: { b: [1, 2], a: 1 } }, state), true);
  assert.equal(conditionHolds({ key: 'config', equals: { a: 1, b: [1, 3] } }, state), false);
});

test('planner: unmetConditions names what failed', () => {
  const unmet = unmetConditions([{ key: 'fuel', above: 0 }, { key: 'key' }], { fuel: 0 });
  assert.equal(unmet.length, 2);
  assert.ok(unmet.some((u) => u.includes('fuel > 0')));
  assert.ok(unmet.some((u) => u.includes('key truthy')));
});

test('planner: applyEffects sets, increments and removes without mutating the input', () => {
  const original = { count: 1, name: 'x', stale: true };
  const next = applyEffects(original, [
    { key: 'count', increment: 4 },
    { key: 'name', set: 'y' },
    { key: 'stale', remove: true },
    { key: 'fresh', set: 1 },
  ]);

  assert.equal(next['count'], 5);
  assert.equal(next['name'], 'y');
  assert.equal('stale' in next, false);
  assert.equal(next['fresh'], 1);
  assert.deepEqual(original, { count: 1, name: 'x', stale: true }, 'the input state is untouched');
});

test('planner: incrementing a missing or non-numeric key starts from zero', () => {
  assert.equal(applyEffects({}, [{ key: 'n', increment: 3 }])['n'], 3);
  assert.equal(applyEffects({ n: 'text' }, [{ key: 'n', increment: 3 }])['n'], 3);
});

// ── introspection and determinism ───────────────────────────────────────────

test('planner: registered knowledge is reported', () => {
  const { planner } = planRig();
  planner.defineAction({ name: 'a' });
  planner.defineMethod({ name: 'm1', task: 't', actions: ['a'] });
  planner.defineMethod({ name: 'm2', task: 't', actions: ['a'] });

  assert.equal(planner.actionCount, 1);
  assert.equal(planner.methodCount, 2);
  assert.equal(planner.methodsFor('t').length, 2);
  assert.ok(planner.knownTasks().includes('t'));
  assert.equal(planner.action('a')?.name, 'a');
});

test('planner: methods are tried in descending priority order', () => {
  const { planner } = planRig();
  planner.defineAction({ name: 'x' });
  planner.defineMethod({ name: 'low', task: 't', priority: 0.1, actions: ['x'] });
  planner.defineMethod({ name: 'high', task: 't', priority: 0.9, actions: ['x'] });
  planner.defineMethod({ name: 'mid', task: 't', priority: 0.5, actions: ['x'] });

  assert.deepEqual(
    planner.methodsFor('t').map((m) => m.name),
    ['high', 'mid', 'low'],
  );
});

test('planner: the same knowledge and state produce the same plan', () => {
  const build = (): string => {
    const { planner } = planRig();
    planner.defineAction({ name: 'a', cost: 2 });
    planner.defineAction({ name: 'b', cost: 3 });
    planner.defineMethod({ name: 'm', task: 't', actions: ['a', 'b'] });
    const outcome = planner.plan('t', { ready: true });
    return outcome.ok ? JSON.stringify({ steps: outcome.plan.steps.map((s) => s.action.name), cost: outcome.plan.cost }) : 'failed';
  };
  assert.equal(build(), build());
});

test('planner: clear() forgets the knowledge base', () => {
  const { planner } = planRig();
  planner.defineAction({ name: 'a' });
  planner.defineMethod({ name: 'm', task: 't', actions: ['a'] });
  planner.clear();

  assert.equal(planner.actionCount, 0);
  assert.equal(planner.methodCount, 0);
  assert.equal(planner.plan('t', {}).ok, false);
});

test('planner: a plan can be inspected before anything is executed', () => {
  // Execution is optional on an action, which is what lets a caller reason
  // about a course of action before committing to it.
  const { planner } = planRig();
  planner.defineAction({ name: 'risky manoeuvre', cost: 10, reliability: 0.6 });
  planner.defineMethod({ name: 'the only way', task: 'escape', actions: ['risky manoeuvre'] });

  const outcome = planner.plan('escape', {});
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.plan.steps[0]?.action.name, 'risky manoeuvre');
  assert.equal(outcome.plan.steps[0]?.action.reliability, 0.6);
  assert.equal(outcome.plan.steps[0]?.forTask, 'escape');
});
