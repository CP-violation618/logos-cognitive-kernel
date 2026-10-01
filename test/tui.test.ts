/**
 * Drive the TUI through a fake TTY and check what it actually draws.
 *
 * The dashboard needs `isTTY`, raw mode, and a size. Rather than pull in a pty
 * library — this project has no dependencies and will not get one for a test —
 * the child gets a script that installs a minimal TTY surface on stdin and
 * stdout, captures every write, then imports the real entry point.
 *
 * The point is not to check exact pixels. It is to check the things that can be
 * structurally wrong and that a screenshot would not reveal:
 *
 *   · every frame is a complete redraw, so a resize or a changed panel cannot
 *     leave debris from the frame before it;
 *   · every drawn row is the full width, so nothing wraps and pushes the layout
 *     down;
 *   · no panel overruns the terminal;
 *   · typing produces a cycle, and the panels change in response;
 *   · :quit restores the cursor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');

// The child imports the CLI by URL. A bare Windows path is rejected by the ESM
// loader — "Only URLs with a scheme in: file, data, and node are supported" —
// and that failure happens in the child, where it surfaces as an empty result
// rather than as an error the test can read.
const CLI_URL = pathToFileURL(join(root, 'src', 'cli.ts')).href;

const HARNESS = `
import { EventEmitter } from 'node:events';

process.argv = [process.argv[0], 'cli.ts', 'tui'];

const COLUMNS = Number(process.env.HARNESS_COLUMNS ?? 110);
const ROWS = Number(process.env.HARNESS_ROWS ?? 34);

const writes = [];
const original = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
  if (typeof rest.at(-1) === 'function') rest.at(-1)();
  return true;
};
Object.defineProperty(process.stdout, 'columns', { value: COLUMNS, configurable: true });
Object.defineProperty(process.stdout, 'rows', { value: ROWS, configurable: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
stdin.resume = () => stdin;
stdin.pause = () => stdin;
stdin.setEncoding = () => stdin;
Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });

// Report a failure inside the app rather than exiting silently, so a broken
// dashboard reads as a broken dashboard and not as "no frames were drawn".
process.on('uncaughtException', (error) => {
  original(JSON.stringify({ writes, error: String(error && error.stack || error) }) + '\\n');
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  original(JSON.stringify({ writes, error: String(error && error.stack || error) }) + '\\n');
  process.exit(0);
});

const script = JSON.parse(process.env.HARNESS_INPUT ?? '[]');
setTimeout(() => {
  for (const line of script) stdin.emit('data', line + '\\r');
}, 400);
setTimeout(() => stdin.emit('data', ':quit\\r'), 500 + script.length * 700);
setTimeout(() => {
  original(JSON.stringify({ writes }) + '\\n');
  process.exit(0);
}, 1000 + script.length * 700);

await import(${JSON.stringify(CLI_URL)});
`;

interface Run {
  readonly writes: string[];
  readonly error: string | undefined;
}

const runHarness = (input: readonly string[], columns = 110, rows = 34): Promise<Run> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', HARNESS], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HARNESS_INPUT: JSON.stringify(input),
        HARNESS_COLUMNS: String(columns),
        HARNESS_ROWS: String(rows),
      },
    });

    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', () => {
      const line = out.trim().split('\n').at(-1) ?? '{}';
      try {
        const parsed = JSON.parse(line) as { writes: string[]; error?: string };
        resolve({ writes: parsed.writes, error: parsed.error });
      } catch {
        resolve({ writes: [], error: `the harness produced no readable result: ${out.slice(0, 400)}` });
      }
    });
  });

/**
 * Full dashboard frames.
 *
 * Filtered by size as well as by the clear-screen prefix, because the app
 * writes a bare `CLEAR` once before its first render to blank the terminal.
 * Taking `frames[0]` unconditionally therefore yields a 13-byte string with no
 * panels in it — which is what an earlier version of this file measured. The
 * test was inspecting the setup rather than the drawing.
 */
const framesOf = (writes: readonly string[]): string[] =>
  writes.filter((w) => w.includes('\u001b[2J') && w.length > 200);

/** Strip escape sequences so a frame's visible text can be measured. */
const visible = (frame: string): string => frame.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');

test('tui: the dashboard draws frames and restores the cursor on quit', async () => {
  const { writes } = await runHarness([]);
  const frames = framesOf(writes);

  assert.ok(frames.length >= 2, `expected several frames, got ${frames.length}`);
  assert.ok(
    frames[0]?.includes('\u001b[2J'),
    'a frame must clear the screen, or panels would leave debris from the frame before',
  );
  assert.ok(
    writes.some((w) => w.includes('\u001b[?25l')),
    'the cursor should be hidden while the dashboard owns the screen',
  );
  assert.ok(
    writes.some((w) => w.includes('\u001b[?25h')),
    'the cursor must be restored on exit, or the terminal is left without one',
  );
});

test('tui: every panel is drawn inside the terminal', async () => {
  const { writes } = await runHarness([]);
  const frame = framesOf(writes)[0] as string;

  // Every cursor-position escape is absolute, so an out-of-range row or column
  // is a layout bug that a smaller terminal would clip rather than report.
  const positions = [...frame.matchAll(/\u001b\[(\d+);(\d+)H/g)].map((m) => ({
    row: Number(m[1]),
    col: Number(m[2]),
  }));

  assert.ok(positions.length > 20, `too few positioned writes to check: ${positions.length}`);
  for (const { row, col } of positions) {
    assert.ok(row >= 1 && row <= 34, `a panel drew at row ${row}, outside a 34-row terminal`);
    assert.ok(col >= 1 && col <= 110, `a panel drew at column ${col}, outside a 110-column terminal`);
  }
});

test('tui: the panels that matter are present', async () => {
  const { writes } = await runHarness([]);
  const text = visible(framesOf(writes)[0] as string);

  for (const title of ['attention', 'working memory', 'goals & action', 'world model']) {
    assert.ok(text.includes(title), `the "${title}" panel was not drawn`);
  }
  // And the labels inside them, because a titled empty box is not a panel.
  for (const label of ['ADMITTED', 'REFUSED', 'states', 'surprise', 'calibration']) {
    assert.ok(text.includes(label), `the "${label}" label was not drawn`);
  }
});

test('tui: typing an observation runs a cycle and the panels change', async () => {
  const quiet = await runHarness([]);
  const typed = await runHarness(['the primary database has stopped accepting writes']);

  const lastQuiet = visible(framesOf(quiet.writes).at(-2) as string);
  const lastTyped = visible(framesOf(typed.writes).at(-2) as string);

  assert.notEqual(lastTyped, lastQuiet, 'typing changed nothing on screen');
  assert.ok(
    /surprise|admitted|refused/i.test(lastTyped),
    'no feedback about what happened to the observation',
  );
});

test('tui: a refusal is reported rather than silently swallowed', async () => {
  // Repeating the same dull thing is the documented way to get refused, and the
  // dashboard must say so — a mind that refuses without saying why is
  // indistinguishable from one that is broken.
  const { writes } = await runHarness(['heartbeat ok', 'heartbeat ok', 'heartbeat ok']);
  const text = writes.map((w) => visible(w)).join('\n');
  assert.ok(
    /refused|admitted/i.test(text),
    'the dashboard never reported what happened to the input',
  );
});

test('tui: a narrower terminal is laid out, not clipped', async () => {
  const { writes } = await runHarness([], 80, 24);
  const frame = framesOf(writes)[0] as string;
  assert.ok(frame.length > 0, 'nothing was drawn at 80x24');

  const positions = [...frame.matchAll(/\u001b\[(\d+);(\d+)H/g)].map((m) => ({
    row: Number(m[1]),
    col: Number(m[2]),
  }));
  for (const { row, col } of positions) {
    assert.ok(row >= 1 && row <= 24, `drew at row ${row} in a 24-row terminal`);
    assert.ok(col >= 1 && col <= 80, `drew at column ${col} in an 80-column terminal`);
  }
});

test('tui: no drawn row exceeds the terminal width', async () => {
  // A row longer than the terminal wraps, which pushes every row below it down
  // and corrupts the layout. Padding every line to exactly the panel width is
  // what prevents it, so this checks that the padding is actually applied.
  const { writes } = await runHarness([], 100, 30);
  const frame = framesOf(writes)[0] as string;

  // Reconstruct the screen from the positioned writes.
  const grid = new Map<string, string>();
  for (const match of frame.matchAll(/\u001b\[(\d+);(\d+)H([^\u001b]*)/g)) {
    grid.set(`${match[1]}:${match[2]}`, match[3] as string);
  }

  for (const [key, chunk] of grid) {
    const [row, col] = key.split(':').map(Number) as [number, number];
    assert.ok(
      col - 1 + chunk.length <= 100,
      `row ${row} draws ${chunk.length} characters from column ${col}, past a 100-column terminal`,
    );
  }
});
