/**
 * LOGOS :: CLI tests
 * ---------------------------------------------------------------------------
 * The CLI is the part of this project a stranger meets first, and it was the
 * part with no tests at all. That showed: `--preset` was documented as a general
 * option and silently ignored by every command that a user would actually reach
 * for, so `logos demo --preset research` ran the default configuration and said
 * nothing about it.
 *
 * These tests run the real binary in a child process. A CLI is a contract about
 * arguments, exit codes and output streams, and the only way to test that
 * contract is to invoke it the way a person would.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const cli = (...args: readonly string[]): Promise<Run> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'src', 'cli.ts'), ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });

/**
 * Drive the REPL with a scripted session.
 *
 * Lines are written WITHOUT waiting between them, which is the whole point: the
 * defects this covers were timing defects, and a test that politely paused
 * between inputs would have passed while the real thing was broken.
 */
const repl = (lines: readonly string[]): Promise<Run> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'src', 'cli.ts'), 'repl'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    // `:quit` is appended so a session that forgets to end cannot hang the run.
    child.stdin.end(`${[...lines, ':quit'].join('\n')}\n`);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });

// ── help and unknown input ──────────────────────────────────────────────────

test('cli: help lists every command and exits 0', async () => {
  const run = await cli('help');
  assert.equal(run.code, 0);
  for (const command of ['demo', 'repl', 'inspect', 'bench', 'help']) {
    assert.match(run.stdout, new RegExp(`\\b${command}\\b`), `help does not mention "${command}"`);
  }
});

test('cli: no arguments prints help rather than doing something', async () => {
  const run = await cli();
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Usage:/);
});

test('cli: an unknown command fails with a non-zero exit code', async () => {
  const run = await cli('frobnicate');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /unknown command/);
  // The help text goes to stderr alongside the error, so a user who mistyped
  // does not have to run a second command to find out what they meant.
  assert.match(run.stderr, /Usage:/);
});

// ── the seed reaches the scenario ───────────────────────────────────────────

test('cli: the same seed produces identical output', async () => {
  const a = await cli('demo', '--seed', '1234', '--quiet');
  const b = await cli('demo', '--seed', '1234', '--quiet');
  assert.equal(a.stdout, b.stdout);
});

test('cli: different seeds produce different output', async () => {
  const a = await cli('demo', '--seed', '111', '--quiet');
  const b = await cli('demo', '--seed', '222', '--quiet');
  // A same-seed check alone passes trivially when nothing varies, so this
  // direction is the one that proves the seed is actually reaching the RNG.
  assert.notEqual(a.stdout, b.stdout, 'two different seeds produced identical output');
});

test('cli: a hex seed is accepted', async () => {
  const run = await cli('demo', '--seed', '0x5eed', '--quiet');
  assert.equal(run.code, 0);
  assert.match(run.stdout, /summary:/);
});

// ── preset actually does something ──────────────────────────────────────────

test('cli: inspect reflects the requested preset', async () => {
  // The defect this test exists for: these two used to print the same thing.
  const minimal = await cli('inspect', '--preset', 'minimal');
  const research = await cli('inspect', '--preset', 'research');

  assert.equal(minimal.code, 0);
  assert.equal(research.code, 0);

  const slots = (output: string): number => Number(/working memory\s+\d+\/(\d+) slots/.exec(output)?.[1]);
  const minimalSlots = slots(minimal.stdout);
  const researchSlots = slots(research.stdout);

  assert.ok(Number.isFinite(minimalSlots) && Number.isFinite(researchSlots), 'could not read the slot counts');
  assert.ok(
    researchSlots > minimalSlots,
    `the research preset should hold more than the minimal one: ${researchSlots} vs ${minimalSlots}`,
  );
});

test('cli: demo reflects the requested preset and says which one it used', async () => {
  const minimal = await cli('demo', '--preset', 'minimal', '--quiet');
  const research = await cli('demo', '--preset', 'research', '--quiet');

  assert.match(minimal.stdout, /preset minimal/);
  assert.match(research.stdout, /preset research/);
  assert.notEqual(minimal.stdout, research.stdout, 'the preset changed nothing');
});

test('cli: an unknown preset is an error, not a silent fallback', async () => {
  // Falling back to the default would mean a typo produced a working run with
  // the wrong configuration — the worst outcome, because nothing looks wrong.
  const run = await cli('demo', '--preset', 'nonsense');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /unknown preset/);
  assert.match(run.stderr, /minimal/, 'the error should name the ones that exist');
});

// ── bench ───────────────────────────────────────────────────────────────────

test('cli: bench honours --cycles', async () => {
  const run = await cli('bench', '--cycles', '25');
  assert.equal(run.code, 0);
  assert.match(run.stdout, /25 cycles/);
  assert.match(run.stdout, /cycles\/second/);
});

test('cli: bench rejects a non-positive cycle count', async () => {
  const run = await cli('bench', '--cycles', '0');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--cycles must be a positive number/);
});

// ── output contracts ────────────────────────────────────────────────────────

test('cli: --json emits parseable JSON and nothing else on stdout', async () => {
  const run = await cli('inspect', '--json');
  assert.equal(run.code, 0);
  // A JSON mode that prints a banner first is not a JSON mode. Something
  // downstream parses this, so stdout has to be exactly the document.
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.ok(typeof parsed === 'object' && parsed !== null);
});

test('cli: the JSON report carries the version and the seed it used', async () => {
  const run = await cli('inspect', '--json', '--seed', '777');
  const parsed = JSON.parse(run.stdout) as { version?: string; seed?: number };
  assert.equal(parsed.version, '0.2.2');
  assert.equal(parsed.seed, 777);
});

test('cli: --quiet suppresses the narration but keeps the summary', async () => {
  const loud = await cli('demo');
  const quiet = await cli('demo', '--quiet');

  assert.ok(quiet.stdout.length < loud.stdout.length, '--quiet did not shorten the output');
  assert.match(quiet.stdout, /summary:/, '--quiet threw away the summary too');
});

test('cli: every documented command responds', async () => {
  for (const args of [['help'], ['inspect'], ['bench', '--cycles', '10']]) {
    const run = await cli(...args);
    assert.equal(run.code, 0, `"${args.join(' ')}" exited ${run.code}: ${run.stderr}`);
    assert.ok(run.stdout.length > 0, `"${args.join(' ')}" printed nothing`);
  }
});

// ── the repl ────────────────────────────────────────────────────────────────

test('repl: :quit exits cleanly rather than crashing', async () => {
  // `:quit` used to close the readline interface and then call `prompt()` on it,
  // so the polite way out produced ERR_USE_AFTER_CLOSE and status 1.
  const run = await repl([]);
  assert.equal(run.code, 0, `the REPL exited ${run.code}: ${run.stderr}`);
  assert.doesNotMatch(run.stderr, /ERR_USE_AFTER_CLOSE/, 'the REPL crashed on exit');
  assert.equal(run.stderr.trim(), '', `the REPL wrote to stderr: ${run.stderr.slice(0, 200)}`);
});

test('repl: an observation is admitted and reported', async () => {
  const run = await repl(['the primary database has stopped accepting writes']);
  assert.match(run.stdout, /admitted 1\/1/, 'the observation was not admitted');
});

test('repl: typed lines are processed in order, not concurrently', async () => {
  // The defect: a cycle is async and a `:command` is synchronous, so typing one
  // after the other ran them at the same time and `:skills` reported the state
  // from BEFORE the observation landed. Stale data is harder to notice than
  // wrong data, because it looks like an answer.
  //
  // A skill is practised by the default plan, so after one admitted observation
  // its attempt count is 1. Under the concurrent behaviour this printed 0.
  const run = await repl(['the primary database has stopped accepting writes', ':skills']);
  const attempts = /observe the situation\s+(\d+) attempts?/.exec(run.stdout)?.[1];

  assert.ok(attempts !== undefined, `the :skills output was not found in:\n${run.stdout.slice(-400)}`);
  assert.equal(
    attempts,
    '1',
    'the command ran before the preceding observation finished, so it reported stale state',
  );
});

test('repl: a refused observation says so instead of going quiet', async () => {
  const run = await repl(['heartbeat ok', 'heartbeat ok', 'heartbeat ok', 'heartbeat ok']);
  assert.match(run.stdout, /admitted \d+\/\d+/, 'no per-cycle feedback was printed at all');
});
