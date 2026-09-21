/**
 * LOGOS :: Kernel smoke tests
 * ---------------------------------------------------------------------------
 * These are the tests that must pass before anything above the kernel layer is
 * allowed to exist. If the clock is not deterministic, if the bus can lose an
 * event, or if the scheduler can overspend a tick, then every claim made by
 * the cognition layers above is untestable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Kernel, createKernel } from '../src/kernel/kernel.ts';
import { Clock } from '../src/kernel/clock.ts';
import { EventBus, compilePattern } from '../src/kernel/bus.ts';
import { Scheduler } from '../src/kernel/scheduler.ts';
import { Rng } from '../src/kernel/rng.ts';
import { defineConfig, preset, availablePresets } from '../src/kernel/config.ts';
import { LogosError, clampCredence, fromLogOdds, toLogOdds, tick as mkTick } from '../src/kernel/types.ts';

// ── Clock ───────────────────────────────────────────────────────────────────

test('clock: logical time is monotonic and gap-free', () => {
  const clock = new Clock({ now: () => 0 });
  const seen: number[] = [];
  clock.onTick((e) => seen.push(e.tick));

  clock.advance(5);

  assert.equal(clock.current, 5);
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.equal(clock.totalSteps, 5);
});

test('clock: injected wall time makes delta deterministic', () => {
  let now = 1_000;
  const clock = new Clock({ now: () => now });

  clock.step();
  now += 250;
  const second = clock.step();

  assert.equal(second.delta, 250);
  assert.equal(second.wallTime, 1_250);
});

test('clock: a throwing listener cannot stop the heartbeat', () => {
  const clock = new Clock({ now: () => 0 });
  const errors: unknown[] = [];
  clock.onListenerError = (error) => errors.push(error);

  const reached: number[] = [];
  clock.onTick(() => {
    throw new Error('listener exploded');
  });
  clock.onTick((e) => reached.push(e.tick));

  clock.step();

  assert.equal(errors.length, 1);
  assert.deepEqual(reached, [1], 'later listeners must still run');
});

test('clock: unsubscribe stops delivery', () => {
  const clock = new Clock({ now: () => 0 });
  let count = 0;
  const off = clock.onTick(() => {
    count += 1;
  });

  clock.advance(2);
  off();
  clock.advance(2);

  assert.equal(count, 2);
});

test('clock: advance rejects non-positive input', () => {
  const clock = new Clock({ now: () => 0 });
  assert.throws(() => clock.advance(0), RangeError);
  assert.throws(() => clock.advance(-3), RangeError);
});

// ── Event bus ───────────────────────────────────────────────────────────────

test('bus: patterns match exactly as documented', () => {
  const exact = compilePattern('memory:encoded');
  assert.equal(exact('memory:encoded'), true);
  assert.equal(exact('memory:decoded'), false);

  const ns = compilePattern('memory:*');
  assert.equal(ns('memory:encoded'), true);
  assert.equal(ns('memory:'), true);
  assert.equal(ns('planning:started'), false);

  const all = compilePattern('*');
  assert.equal(all('anything:at:all'), true);

  assert.throws(() => compilePattern('me*ry:encoded'), LogosError);
});

test('bus: delivery is synchronous and ordered by subscription', () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.on('*', () => order.push('first'));
  bus.on('x:y', () => order.push('second'));

  assert.equal(bus.dispatching, false);
  bus.publish('x:y');
  assert.equal(bus.dispatching, false);

  assert.deepEqual(order, ['first', 'second']);
});

test('bus: a throwing listener does not prevent later delivery', () => {
  const bus = new EventBus();
  const errors: unknown[] = [];
  bus.onListenerError = (error) => errors.push(error);

  let delivered = false;
  bus.on('evt', () => {
    throw new Error('bad handler');
  });
  bus.on('evt', () => {
    delivered = true;
  });

  bus.publish('evt');

  assert.equal(delivered, true);
  assert.equal(errors.length, 1);
});

test('bus: once() fires exactly one time', () => {
  const bus = new EventBus();
  let n = 0;
  bus.once('ping', () => {
    n += 1;
  });

  bus.publish('ping');
  bus.publish('ping');

  assert.equal(n, 1);
  assert.equal(bus.listenerCount, 0);
});

test('bus: events are frozen and carry a monotonic sequence', () => {
  const bus = new EventBus();
  const a = bus.publish('one');
  const b = bus.publish('two');

  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(a.payload), true);
  assert.equal(b.seq, a.seq + 1);
  assert.throws(() => {
    (a as { seq: number }).seq = 99;
  }, TypeError);
});

test('bus: history is bounded and filterable', () => {
  const bus = new EventBus({ historyLimit: 3 });
  bus.publish('a:1');
  bus.publish('a:2');
  bus.publish('b:1');
  bus.publish('a:3');

  assert.equal(bus.history().length, 3, 'oldest event is dropped');
  assert.deepEqual(
    bus.history('a:*').map((e) => e.type),
    ['a:2', 'a:3'],
  );
});

test('bus: subscribing during dispatch does not affect the current publish', () => {
  const bus = new EventBus();
  let lateCalls = 0;

  bus.on('evt', () => {
    bus.on('evt', () => {
      lateCalls += 1;
    });
  });

  bus.publish('evt');
  assert.equal(lateCalls, 0, 'new subscriber must not see the in-flight event');

  bus.publish('evt');
  assert.equal(lateCalls, 1);
});

test('bus: rejects malformed event types', () => {
  const bus = new EventBus();
  assert.throws(() => bus.publish(''), LogosError);
});

// ── Scheduler ───────────────────────────────────────────────────────────────

test('scheduler: higher priority is admitted first', async () => {
  const order: string[] = [];
  const sched = new Scheduler({ budgetPerTick: 32, maxTasksPerTick: 8 });

  const mk = (name: string, priority: number) => ({
    name,
    priority,
    run: () => {
      order.push(name);
      return { status: 'done' as const };
    },
  });

  sched.enqueue(mk('low', 10));
  sched.enqueue(mk('high', 900));
  sched.enqueue(mk('mid', 100));

  await sched.drain(1);

  assert.deepEqual(order, ['high', 'mid', 'low']);
});

test('scheduler: ties are broken by insertion order, not by sort stability', async () => {
  const order: string[] = [];
  const sched = new Scheduler({ budgetPerTick: 64, maxTasksPerTick: 16 });

  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    sched.enqueue({
      name,
      priority: 50,
      run: () => {
        order.push(name);
        return { status: 'done' as const };
      },
    });
  }

  await sched.drain(1);

  assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e']);
});

test('scheduler: earlier deadlines win ties', async () => {
  const order: string[] = [];
  const sched = new Scheduler({ budgetPerTick: 64, maxTasksPerTick: 16 });

  sched.enqueue({
    name: 'late',
    priority: 50,
    deadline: 900,
    run: () => {
      order.push('late');
      return { status: 'done' as const };
    },
  });
  sched.enqueue({
    name: 'soon',
    priority: 50,
    deadline: 100,
    run: () => {
      order.push('soon');
      return { status: 'done' as const };
    },
  });

  await sched.drain(1);
  assert.deepEqual(order, ['soon', 'late']);
});

test('scheduler: yielded work resumes and finally settles', async () => {
  const sched = new Scheduler({ budgetPerTick: 8, maxTasksPerTick: 4 });
  let phase = 0;

  const { settled } = sched.enqueue({
    name: 'deliberate',
    run: (_signal, yieldTo) => {
      phase += 1;
      if (phase < 3) return { status: 'yielded', detail: `phase ${phase}` };
      return { status: 'done', value: 'concluded' };
    },
  });

  await sched.drain(1);
  assert.equal(phase, 1, 'first tick performs one phase');

  await sched.drain(5);
  const outcome = await settled;

  assert.equal(outcome.state, 'done');
  assert.equal(outcome.value, 'concluded');
  assert.equal(outcome.attempts, 3);
});

test('scheduler: never re-admits a task within the same tick', async () => {
  const sched = new Scheduler({ budgetPerTick: 10, maxTasksPerTick: 1 });
  const ran: string[] = [];

  // A task that always yields, i.e. would run forever if the tick allowed it.
  sched.enqueue({
    name: 'greedy',
    priority: 1000,
    run: () => {
      ran.push('greedy');
      return { status: 'yielded' as const };
    },
  });
  sched.enqueue({
    name: 'modest',
    priority: 1,
    run: () => {
      ran.push('modest');
      return { status: 'done' as const };
    },
  });

  const first = await sched.runTick();

  assert.deepEqual(ran, ['greedy'], 'the greedy task runs once, not until it finishes');
  assert.equal(first.admitted, 1);
  assert.equal(first.budgetUsed, 5, 'it spent its half-tick slice and the rest expired unused');
});

test('scheduler: a task that finishes early returns its slice to the tick', async () => {
  const sched = new Scheduler({ budgetPerTick: 10, maxTasksPerTick: 8 });
  const ran: string[] = [];

  sched.enqueue({
    name: 'quick',
    priority: 900,
    run: () => {
      ran.push('quick');
      return { status: 'done' as const };
    },
  });
  sched.enqueue({
    name: 'next',
    priority: 800,
    run: () => {
      ran.push('next');
      return { status: 'done' as const };
    },
  });
  sched.enqueue({
    name: 'last',
    priority: 100,
    run: () => {
      ran.push('last');
      return { status: 'done' as const };
    },
  });

  const report = await sched.runTick();

  // All three were admitted in ONE tick: a task that needs one unit of effort
  // must not lock out the other seven units of the tick's capacity.
  assert.deepEqual(ran, ['quick', 'next', 'last']);
  assert.equal(report.completed, 3);
  assert.ok(report.budgetUsed <= report.budgetTotal);
});

test('scheduler: budget per tick is a hard ceiling', async () => {
  const sched = new Scheduler({ budgetPerTick: 6, maxTasksPerTick: 6 });
  for (let i = 0; i < 20; i += 1) {
    sched.enqueue({ name: `t${i}`, run: () => ({ status: 'yielded' as const }) });
  }

  const report = await sched.runTick();

  assert.ok(report.budgetUsed <= 6, `used ${report.budgetUsed} of 6`);
  assert.ok(report.admitted <= 6, `admitted ${report.admitted} of 6 slots`);
  assert.equal(
    new Set(sched.snapshot().queue.map((q) => q.name)).size,
    20,
    'every task is still queued for a later tick',
  );
});

test('scheduler: a task gets at most one slice per tick', async () => {
  const sched = new Scheduler({ budgetPerTick: 32, maxTasksPerTick: 8 });
  let attempts = 0;

  sched.enqueue({
    name: 'eager',
    priority: 1000,
    run: () => {
      attempts += 1;
      return { status: 'yielded' as const };
    },
  });

  const a = await sched.runTick();
  const b = await sched.runTick();
  const c = await sched.runTick();

  assert.equal(attempts, 3, 'exactly one attempt per tick');
  assert.equal(a.admitted, 1);
  assert.equal(b.admitted, 1);
  assert.equal(c.admitted, 1);
});

test('scheduler: a failing task is reported, not thrown', async () => {
  const sched = new Scheduler();
  const { settled } = sched.enqueue({
    name: 'boom',
    run: () => {
      throw new Error('inner failure');
    },
  });

  await sched.drain(1);
  const outcome = await settled;

  assert.equal(outcome.state, 'failed');
  assert.equal((outcome.error as Error).message, 'inner failure');
  assert.equal(sched.stats().failed, 1);
});

test('scheduler: cancelling an aborts its signal and settles it', async () => {
  const sched = new Scheduler();
  const { id, settled } = sched.enqueue({
    name: 'cancelme',
    run: () => ({ status: 'yielded' as const }),
  });

  assert.equal(sched.cancel(id, 'no longer needed'), true);
  const outcome = await settled;

  assert.equal(outcome.state, 'cancelled');
  assert.equal(sched.getState(id), 'cancelled');
  assert.equal(sched.cancel(id), false, 'cancelling twice is a no-op');
});

test('scheduler: drain stops early once the queue is empty', async () => {
  const sched = new Scheduler({ budgetPerTick: 4, maxTasksPerTick: 2 });
  sched.enqueue({ name: 'only', run: () => ({ status: 'done' as const }) });

  const reports = await sched.drain(50);

  assert.equal(reports.length, 1, 'should not spin for 50 empty ticks');
});

test('scheduler: snapshot exposes runnable queue in execution order', async () => {
  const sched = new Scheduler();
  sched.enqueue({ name: 'later', priority: 1, run: () => ({ status: 'yielded' as const }) });
  sched.enqueue({ name: 'sooner', priority: 99, run: () => ({ status: 'yielded' as const }) });

  const snap = sched.snapshot();
  assert.deepEqual(
    snap.queue.map((q) => q.name),
    ['sooner', 'later'],
  );
});

// ── RNG ─────────────────────────────────────────────────────────────────────

test('rng: identical seeds produce identical streams', () => {
  const a = new Rng(12345);
  const b = new Rng(12345);
  const drawA = Array.from({ length: 20 }, () => a.next());
  const drawB = Array.from({ length: 20 }, () => b.next());
  assert.deepEqual(drawA, drawB);
});

test('rng: different seeds diverge', () => {
  const a = new Rng(1);
  const b = new Rng(2);
  assert.notEqual(a.next(), b.next());
});

test('rng: uniform draws stay inside the unit interval', () => {
  const rng = new Rng(0);
  for (let i = 0; i < 5_000; i += 1) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('rng: state can be saved and restored for replay', () => {
  const rng = new Rng(777);
  rng.next();
  const snapshot = rng.saveState();
  const expected = [rng.next(), rng.next(), rng.next()];

  rng.restoreState(snapshot);
  const replayed = [rng.next(), rng.next(), rng.next()];

  assert.deepEqual(replayed, expected);
});

test('rng: weighted selection respects zero-weight exclusion', () => {
  const rng = new Rng(42);
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 1_000; i += 1) {
    const picked = rng.weighted(['a', 'b'] as const, [1, 0]);
    counts[picked as 'a' | 'b'] += 1;
  }
  assert.equal(counts.b, 0);
  assert.equal(counts.a, 1_000);
});

test('rng: normal draws have roughly the requested moments', () => {
  const rng = new Rng(2024);
  const n = 20_000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    const v = rng.normal(10, 2);
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;

  assert.ok(Math.abs(mean - 10) < 0.1, `mean was ${mean}`);
  assert.ok(Math.abs(Math.sqrt(variance) - 2) < 0.1, `sd was ${Math.sqrt(variance)}`);
});

test('rng: fork gives each subsystem an independent, reproducible stream', () => {
  const parentA = new Rng(5);
  const memory = parentA.fork('memory');
  const planning = parentA.fork('planning');
  const draws = (r: Rng, n: number): number[] => Array.from({ length: n }, () => r.next());

  const memDraws = draws(memory, 5);
  const planDraws = draws(planning, 5);

  assert.notDeepEqual(memDraws, planDraws, 'different labels must not share a stream');

  // Rebuilding the parent from the same seed must reproduce both children:
  // this is what makes a random-but-replayable cognition trace possible.
  const parentB = new Rng(5);
  assert.deepEqual(draws(parentB.fork('memory'), 5), memDraws);
  assert.deepEqual(draws(parentB.fork('planning'), 5), planDraws);
});

// ── Config ──────────────────────────────────────────────────────────────────

test('config: defaults are valid and deeply frozen', () => {
  const config = defineConfig();
  assert.equal(config.memory.workingSlots, 7);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.memory), true);
  assert.equal(Object.isFrozen(config.scheduler), true);
});

test('config: overrides merge without mutating the base', () => {
  const a = defineConfig({ memory: { workingSlots: 3 } });
  const b = defineConfig();

  assert.equal(a.memory.workingSlots, 3);
  assert.equal(a.memory.retrievalLimit, b.memory.retrievalLimit, 'siblings are inherited');
  assert.equal(b.memory.workingSlots, 7, 'base is untouched');
});

test('config: undefined values mean "leave it alone"', () => {
  const config = defineConfig({ name: undefined, memory: { workingSlots: undefined } });
  assert.equal(config.name, 'logos');
  assert.equal(config.memory.workingSlots, 7);
});

test('config: incoherent values are rejected with an explanation', () => {
  assert.throws(
    () => defineConfig({ memory: { workingSlots: 0 } }),
    (error: unknown) => error instanceof LogosError && error.code === 'CONFIG_INVALID',
  );
  assert.throws(() => defineConfig({ memory: { attentionThreshold: 1.5 } }), LogosError);
  assert.throws(() => defineConfig({ scheduler: { maxTasksPerTick: 99, budgetPerTick: 4 } }), LogosError);
});

test('config: presets are coherent and change what they claim to', () => {
  for (const name of availablePresets()) {
    assert.doesNotThrow(() => preset(name), `preset ${name} must be valid`);
  }

  const reflective = preset('reflective');
  const reactive = preset('reactive');
  assert.ok(
    reflective.scheduler.budgetPerTick > reactive.scheduler.budgetPerTick,
    'reflective thinks longer per tick',
  );
  assert.ok(
    reactive.memory.workingSlots < reflective.memory.workingSlots,
    'reactive attends to less at once',
  );

  const tuned = preset('reactive', { goals: { maxActive: 8 } });
  assert.equal(tuned.goals.maxActive, 8);
  assert.equal(tuned.clock.hz, reactive.clock.hz, 'other preset fields survive');
});

test('config: unknown preset fails loudly', () => {
  assert.throws(() => preset('nonexistent' as never), LogosError);
});

// ── Types ───────────────────────────────────────────────────────────────────

test('types: credence helpers round-trip and clamp', () => {
  assert.equal(clampCredence(-1), 0);
  assert.equal(clampCredence(2), 1);
  assert.equal(clampCredence(Number.NaN), 0.5, 'NaN means total ignorance, not certainty');

  for (const p of [0.01, 0.2, 0.5, 0.8, 0.99]) {
    assert.ok(Math.abs(fromLogOdds(toLogOdds(p)) - p) < 1e-6, `round trip failed for ${p}`);
  }
});

// ── Kernel integration ──────────────────────────────────────────────────────

test('kernel: boots, ticks, and shuts down cleanly', async () => {
  const kernel = createKernel({ config: { clock: { hz: 1000 } } });
  const log: string[] = [];

  kernel.use({
    name: 'recorder',
    start(ctx) {
      log.push('start');
      ctx.bus.on('kernel:*', (e) => log.push(e.type));
    },
    stop() {
      log.push('stop');
    },
  });

  await kernel.start();
  assert.equal(kernel.phase, 'running');

  kernel.pause();
  assert.equal(kernel.phase, 'paused');
  await kernel.resume();
  assert.equal(kernel.phase, 'running');

  await kernel.stop();
  assert.equal(kernel.phase, 'stopped');

  assert.equal(log[0], 'start');
  assert.ok(log.includes('kernel:started'));
  assert.ok(log.includes('kernel:paused'));
  assert.ok(log.includes('kernel:stopped'));

  // Ordering, not position: `kernel:stopped` is announced only after every
  // subsystem has quiesced, so subscribers can rely on a fully stopped system.
  assert.ok(
    log.indexOf('stop') < log.indexOf('kernel:stopped'),
    `subsystems must stop before the kernel announces shutdown; got ${log.join(' -> ')}`,
  );
});

test('kernel: ticks advance logical time and run scheduled tasks', async () => {
  const kernel = createKernel({ config: { clock: { hz: 1000 } } });
  await kernel.start();

  let ran = 0;
  kernel.scheduler.enqueue({
    name: 'think',
    run: () => {
      ran += 1;
      return { status: 'done' as const };
    },
  });

  await kernel.tick();
  await kernel.stop();

  assert.equal(kernel.tickCount, 1);
  assert.equal(ran, 1);
});

test('kernel: run() returns the task value, runOrThrow unwraps it', async () => {
  const kernel = createKernel();
  await kernel.start();

  const value = await kernel.runOrThrow({
    name: 'answer',
    run: () => ({ status: 'done' as const, value: 6 * 7 }),
  });

  await kernel.stop();
  assert.equal(value, 42);
});

test('kernel: runOrThrow surfaces a failing task as an error', async () => {
  const kernel = createKernel();
  await kernel.start();

  await assert.rejects(
    kernel.runOrThrow({
      name: 'bad',
      run: () => {
        throw new Error('inner');
      },
    }),
    (error: unknown) => error instanceof LogosError && error.code === 'TASK_NOT_DONE',
  );

  await kernel.stop();
});

test('kernel: duplicate subsystem registration is refused', () => {
  const kernel = new Kernel();
  kernel.use({ name: 'dup', start: () => undefined });
  assert.throws(() => kernel.use({ name: 'dup', start: () => undefined }), LogosError);
});

test('kernel: a subsystem failing to start aborts the boot', async () => {
  const kernel = new Kernel();
  kernel.use({
    name: 'broken',
    start() {
      throw new Error('cannot initialise');
    },
  });

  await assert.rejects(kernel.start(), /cannot initialise/);
  assert.equal(kernel.phase, 'stopped');
});

test('kernel: a stopped kernel refuses to restart', async () => {
  const kernel = createKernel();
  await kernel.start();
  await kernel.stop();
  await assert.rejects(kernel.start(), LogosError);
});

test('kernel: health aggregates kernel and subsystem reports', async () => {
  const kernel = createKernel();
  kernel.use({
    name: 'sensor',
    start: () => undefined,
    health: () => ({
      subsystem: 'sensor',
      phase: 'running' as const,
      ok: true,
      detail: 'all senses nominal',
      metrics: { percepts: 3 },
    }),
  });

  await kernel.start();
  const reports = kernel.health();
  await kernel.stop();

  assert.equal(reports.length, 2);
  assert.equal(reports[0]?.subsystem, 'kernel');
  assert.equal(reports[1]?.detail, 'all senses nominal');
});

test('kernel: a throwing health() degrades gracefully instead of propagating', async () => {
  const kernel = createKernel();
  kernel.use({
    name: 'sick',
    start: () => undefined,
    health() {
      throw new Error('vitals unavailable');
    },
  });

  await kernel.start();
  const reports = kernel.health();
  await kernel.stop();

  const sick = reports.find((r) => r.subsystem === 'sick');
  assert.equal(sick?.ok, false);
  assert.match(sick?.detail ?? '', /vitals unavailable/);
});

test('kernel: snapshot is serialisable and self-consistent', async () => {
  const kernel = createKernel({ config: { seed: 99 } });
  await kernel.start();
  await kernel.tick();

  const snap = kernel.snapshot();
  await kernel.stop();

  assert.equal(snap.seed, 99);
  assert.equal(snap.tick, 1);
  assert.equal(snap.phase, 'running');
  assert.deepEqual(snap.subsystems, []);
  assert.doesNotThrow(() => JSON.stringify(snap));
});

test('kernel: the same seed replays the same mental trajectory', async () => {
  const runOnce = async (): Promise<number[]> => {
    const kernel = createKernel({ config: { seed: 4242, clock: { hz: 1000 } } });
    await kernel.start();
    const draws: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      kernel.scheduler.enqueue({
        name: `draw${i}`,
        priority: kernel.rng.int(1, 100),
        run: (_s, _y) => {
          draws.push(kernel.rng.next());
          return { status: 'done' as const };
        },
      });
      await kernel.tick();
    }
    await kernel.stop();
    return draws;
  };

  assert.deepEqual(await runOnce(), await runOnce());
});

test('kernel: describe() summarises state for logs', async () => {
  const kernel = createKernel();
  await kernel.start();
  const line = kernel.describe();
  await kernel.stop();

  assert.match(line, /logos\[running\]/);
  assert.match(line, /tick=0/);
});

test('kernel: bus events carry the logical tick they occurred on', async () => {
  const kernel = createKernel({ config: { clock: { hz: 1000 } } });
  const ticks: number[] = [];
  kernel.use({
    name: 'observer',
    start(ctx) {
      ctx.bus.on('probe', (e) => ticks.push(e.tick));
    },
  });

  await kernel.start();
  await kernel.advance(3);
  kernel.context.emit('probe');
  await kernel.stop();

  assert.deepEqual(ticks, [3]);
  assert.equal(mkTick(3), 3);
});
