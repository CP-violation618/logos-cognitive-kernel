/**
 * LOGOS :: Terminal dashboard
 * ---------------------------------------------------------------------------
 * A live view of a mind, in the terminal, with no dependencies.
 *
 * WHY A TERMINAL AND NOT A BROWSER. The obvious answer to "make it easier to
 * use" is a web interface, and it would cost the project its central claim: a
 * React front end is a build step, a dependency tree, and a supply chain to
 * audit, in a repository whose whole argument is that it has none. Node ships
 * everything needed to draw a dashboard — raw mode, ANSI escapes, and an HTTP
 * server — so the interface can be complete without adding a single line to
 * `package.json`.
 *
 * WHAT IT SHOWS, and why each panel is there rather than merely available:
 *
 *   ATTENTION   what got in and what was refused, because the refusals are the
 *               interesting half. A gate that never refuses is not a gate.
 *   MEMORY      the seven slots, live, with activation decaying as you watch.
 *   GOALS       priority and status, so you can see the mind choosing.
 *   WORLD       the states and transitions it has learned, and its surprise.
 *   BELIEFS     what it holds and how strongly, with conflicted beliefs marked.
 *   CALIBRATION whether its confidence means anything — the panel most worth
 *               watching, because it is the one that changes how you read every
 *               other number on screen.
 *
 * The dashboard is READ-ONLY apart from the input line. Nothing here changes
 * how the mind works; it only shows it.
 */

import type { Kernel } from './kernel/kernel.ts';
import type { CognitiveAgent } from './cognition/agent.ts';
import type { WorkingMemory } from './memory/working.ts';
import type { EpisodicMemory } from './memory/episodic.ts';
import type { SemanticMemory } from './memory/semantic.ts';
import type { WorldModel } from './reasoning/world-model.ts';
import type { BeliefStore } from './reasoning/beliefs.ts';
import type { GoalSystem } from './planning/goals.ts';
import type { Calibrator } from './metacognition/calibration.ts';
import type { SkillRegistry } from './skills/registry.ts';
import type { PerceptInput } from './perception/gate.ts';

export interface DashboardParts {
  readonly kernel: Kernel;
  readonly agent: CognitiveAgent;
  readonly working: WorkingMemory;
  readonly episodic: EpisodicMemory;
  readonly semantic: SemanticMemory;
  readonly world: WorldModel;
  readonly beliefs: BeliefStore;
  readonly goals: GoalSystem;
  readonly calibrator: Calibrator;
  readonly skills?: SkillRegistry;
}

// ── terminal control ────────────────────────────────────────────────────────

const ESC = '\u001b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const REVERSE = `${ESC}7m`;
const CLEAR = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

const fg = (n: number): string => `${ESC}38;5;${n}m`;
const bg = (n: number): string => `${ESC}48;5;${n}m`;

/** A restrained palette. Colour carries meaning or it is noise. */
const COLOUR = {
  frame: fg(240),
  title: `${BOLD}${fg(111)}`,
  label: fg(246),
  value: fg(255),
  good: fg(114),
  warn: fg(179),
  bad: fg(174),
  accent: fg(147),
  faint: `${DIM}${fg(243)}`,
} as const;

/** Visible width, ignoring escape sequences. */
const widthOf = (text: string): number => text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').length;

/** Truncate to a visible width, with an ellipsis when something was cut. */
const fit = (text: string, width: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (width <= 0) return '';
  if (widthOf(flat) <= width) return flat;
  if (width <= 1) return flat.slice(0, width);
  return `${flat.slice(0, width - 1)}…`;
};

const pad = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - widthOf(text)));

/** A labelled ratio bar. */
const bar = (value: number, width: number, colour: string): string => {
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const filled = Math.round(clamped * width);
  return `${colour}${'█'.repeat(filled)}${COLOUR.frame}${'░'.repeat(Math.max(0, width - filled))}${RESET}`;
};

// ── layout ──────────────────────────────────────────────────────────────────

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Draw a bordered panel and return the region inside it.
 *
 * Every panel is drawn to a fixed rectangle rather than appended to a stream,
 * so a long value cannot push the layout around. A dashboard that reflows while
 * you are reading it is worse than no dashboard.
 */
const panel = (out: string[], rect: Rect, title: string): Rect => {
  const { x, y, w, h } = rect;
  if (w < 4 || h < 2) return { x, y, w: 0, h: 0 };

  const inner = w - 2;
  const heading = ` ${title} `;
  const rule = Math.max(0, inner - widthOf(heading) - 1);

  out.push(`${ESC}${y + 1};${x + 1}H${COLOUR.frame}┌${COLOUR.title}${heading}${COLOUR.frame}${'─'.repeat(rule)}┐${RESET}`);

  for (let row = 1; row < h - 1; row += 1) {
    out.push(`${ESC}${y + row + 1};${x + 1}H${COLOUR.frame}│${RESET}${' '.repeat(inner)}${COLOUR.frame}│${RESET}`);
  }
  if (h > 1) {
    out.push(`${ESC}${y + h};${x + 1}H${COLOUR.frame}└${'─'.repeat(inner)}┘${RESET}`);
  }

  return { x: x + 2, y: y + 1, w: w - 4, h: h - 2 };
};

/** Write one line inside a panel region. Silently clips past the bottom. */
const line = (out: string[], region: Rect, row: number, text: string): void => {
  if (row < 0 || row >= region.h || region.w <= 0) return;
  out.push(`${ESC}${region.y + row + 1};${region.x + 1}H${pad(fit(text, region.w), region.w)}${RESET}`);
};

// ── the dashboard ───────────────────────────────────────────────────────────

export interface DashboardOptions {
  readonly parts: DashboardParts;
  readonly seed: number;
  readonly presetName: string;
  readonly version: string;
  /** Rendered at the bottom left, e.g. a status or an error. */
  readonly notice?: () => string;
  /** Echoed back so the caller can redraw the prompt. */
  readonly input?: string;
}

export class Dashboard {
  readonly #parts: DashboardParts;
  readonly #seed: number;
  readonly #presetName: string;
  readonly #version: string;
  readonly #notice: () => string;
  readonly #input: string;
  #admitted: string[] = [];
  #refused: { content: string; reason: string; salience: number }[] = [];
  #lastAction = '(none yet)';
  #lastPlan: { goal: string; steps: number; confidence: number } | undefined;
  #surprise = 0;
  #frames = 0;

  constructor(options: DashboardOptions) {
    this.#parts = options.parts;
    this.#seed = options.seed;
    this.#presetName = options.presetName;
    this.#version = options.version;
    this.#notice = options.notice ?? ((): string => '');
    this.#input = options.input ?? '';
  }

  /** Feed a cycle report back so the ATTENTION panel shows live history. */
  observeCycle(report: {
    readonly perceptsAdmitted: number;
    readonly refused: readonly { readonly content: string; readonly reason: string; readonly salience: number }[];
    readonly surprise: number;
    readonly plan: { readonly goal: string; readonly steps: number; readonly confidence: number } | undefined;
    readonly action: { readonly name: string; readonly succeeded: boolean } | undefined;
  }): void {
    this.#frames += 1;
    this.#surprise = report.surprise;
    if (report.plan !== undefined) this.#lastPlan = report.plan;
    if (report.action !== undefined) {
      this.#lastAction = `${report.action.name} ${report.action.succeeded ? '✓' : '✗'}`;
    }
    this.#refused = [...report.refused, ...this.#refused].slice(0, 4);
  }

  noteAdmitted(content: string): void {
    this.#admitted = [content, ...this.#admitted].slice(0, 4);
  }

  render(): string {
    const columns = process.stdout.columns ?? 100;
    const rows = process.stdout.rows ?? 32;
    const w = Math.max(60, columns);
    const h = Math.max(20, rows);
    const out: string[] = [CLEAR];

    this.#header(out, w);
    this.#body(out, w, h);
    this.#footer(out, w, h);

    out.push(`${ESC}${h};1H${RESET}`);
    return out.join('');
  }

  #header(out: string[], w: number): void {
    const { kernel, agent } = this.#parts;
    const left = `${COLOUR.title}LOGOS${RESET} ${COLOUR.faint}v${this.#version}${RESET}`;
    const middle = `${COLOUR.label}seed${RESET} ${COLOUR.value}${this.#seed}${RESET}  ${COLOUR.label}preset${RESET} ${COLOUR.value}${this.#presetName}${RESET}`;
    const right = `${COLOUR.label}${kernel.phase}${RESET} ${COLOUR.faint}tick${RESET} ${COLOUR.value}${kernel.clock.current}${RESET} ${COLOUR.faint}cycles${RESET} ${COLOUR.value}${agent.cycles}${RESET}`;

    const gap = Math.max(2, w - widthOf(left) - widthOf(middle) - widthOf(right) - 2);
    out.push(`${ESC}1;2H${left}${' '.repeat(2)}${middle}${' '.repeat(gap)}${right}${RESET}`);
    out.push(`${ESC}2;1H${COLOUR.frame}${'─'.repeat(w)}${RESET}`);
  }

  #body(out: string[], w: number, h: number): void {
    // A two-column layout with a full-width calibration strip beneath it. The
    // widths are computed rather than fixed so a narrow terminal degrades
    // gracefully instead of wrapping.
    const top = 3;
    const usable = h - top - 8;
    const leftW = Math.max(30, Math.floor(w * 0.52));
    const rightW = Math.max(26, w - leftW - 1);
    const half = Math.max(6, Math.floor(usable / 2));

    const attention = panel(out, { x: 0, y: top, w: leftW, h: half }, 'attention');
    const memory = panel(out, { x: 0, y: top + half, w: leftW, h: usable - half }, 'working memory');
    const goals = panel(out, { x: leftW, y: top, w: rightW, h: half }, 'goals & action');
    const world = panel(out, { x: leftW, y: top + half, w: rightW, h: usable - half }, 'world model');

    this.#attention(out, attention);
    this.#memory(out, memory);
    this.#goals(out, goals);
    this.#world(out, world);

    const stripY = top + usable;
    this.#strip(out, { x: 0, y: stripY, w, h: 6 });
  }

  #attention(out: string[], r: Rect): void {
    let row = 0;
    line(out, r, row++, `${COLOUR.faint}${fit(this.#parts.agent.describe(), r.w)}${RESET}`);
    row += 1;

    line(out, r, row++, `${COLOUR.label}ADMITTED${RESET}`);
    if (this.#admitted.length === 0) {
      line(out, r, row++, `  ${COLOUR.faint}(nothing yet — type an observation below)${RESET}`);
    } else {
      for (const content of this.#admitted) {
        line(out, r, row++, `  ${COLOUR.good}▸${RESET} ${COLOUR.value}${fit(content, r.w - 4)}${RESET}`);
      }
    }

    row += 1;
    line(out, r, row++, `${COLOUR.label}REFUSED${RESET} ${COLOUR.faint}(why a mind can ignore things)${RESET}`);
    if (this.#refused.length === 0) {
      line(out, r, row++, `  ${COLOUR.faint}(none)${RESET}`);
    } else {
      for (const item of this.#refused) {
        const why = item.reason === 'habituated' ? COLOUR.warn : COLOUR.faint;
        line(out, r, row++, `  ${why}▸${RESET} ${COLOUR.faint}${fit(item.content, r.w - 18)}${RESET} ${why}${item.reason}${RESET}`);
      }
    }
  }

  #memory(out: string[], r: Rect): void {
    const { working } = this.#parts;
    let row = 0;
    line(out, r, row++, `${COLOUR.label}${working.size}/${working.capacity} slots${RESET}  ${COLOUR.faint}pressure ${working.pressure.toFixed(2)}${RESET}`);
    row += 1;

    const contents = working.contents();
    if (contents.length === 0) {
      line(out, r, row++, `  ${COLOUR.faint}(empty)${RESET}`);
    } else {
      const barWidth = Math.max(6, Math.min(14, r.w - 46));
      for (const item of contents.slice(0, Math.max(0, r.h - 2))) {
        const activation = item.activation;
        const colour = activation > 0.6 ? COLOUR.good : activation > 0.3 ? COLOUR.warn : COLOUR.faint;
        line(
          out,
          r,
          row++,
          `  ${bar(activation, barWidth, colour)} ${COLOUR.faint}${activation.toFixed(2)}${RESET} ${COLOUR.value}${fit(item.content, r.w - barWidth - 10)}${RESET}`,
        );
      }
    }
  }

  #goals(out: string[], r: Rect): void {
    const { goals } = this.#parts;
    let row = 0;
    const all = goals.all();

    if (all.length === 0) {
      line(out, r, row++, `${COLOUR.faint}(no goals declared)${RESET}`);
    } else {
      for (const goal of all.slice(0, Math.max(0, r.h - 5))) {
        const statusColour =
          goal.status === 'achieved' ? COLOUR.good : goal.status === 'active' ? COLOUR.accent : COLOUR.faint;
        line(
          out,
          r,
          row++,
          `${statusColour}${goal.status.padEnd(9)}${RESET} ${COLOUR.label}p=${goal.priority.toFixed(2)}${RESET} ${COLOUR.value}${fit(goal.description, r.w - 22)}${RESET}`,
        );
      }
    }

    row = Math.max(row + 1, r.h - 4);
    line(out, r, row++, `${COLOUR.label}PLAN${RESET}`);
    if (this.#lastPlan === undefined) {
      line(out, r, row++, `  ${COLOUR.faint}(none)${RESET}`);
    } else {
      line(
        out,
        r,
        row++,
        `  ${COLOUR.value}${fit(this.#lastPlan.goal, r.w - 20)}${RESET} ${COLOUR.faint}${this.#lastPlan.steps} steps @ ${this.#lastPlan.confidence.toFixed(2)}${RESET}`,
      );
    }
    line(out, r, row++, `${COLOUR.label}ACTED${RESET} ${COLOUR.value}${fit(this.#lastAction, r.w - 8)}${RESET}`);
  }

  #world(out: string[], r: Rect): void {
    const { world } = this.#parts;
    const stats = world.stats();
    let row = 0;

    line(
      out,
      r,
      row++,
      `${COLOUR.label}states${RESET} ${COLOUR.value}${stats.states}${RESET}  ${COLOUR.label}transitions${RESET} ${COLOUR.value}${stats.transitions}${RESET}  ${COLOUR.label}observations${RESET} ${COLOUR.value}${stats.observations}${RESET}`,
    );

    const surpriseColour = this.#surprise > 0.6 ? COLOUR.bad : this.#surprise > 0.3 ? COLOUR.warn : COLOUR.faint;
    line(
      out,
      r,
      row++,
      `${COLOUR.label}surprise${RESET}   ${bar(this.#surprise, Math.max(8, Math.min(20, r.w - 22)), surpriseColour)} ${COLOUR.value}${this.#surprise.toFixed(2)}${RESET}`,
    );
    row += 1;

    line(out, r, row++, `${COLOUR.label}LEARNED STATES${RESET}`);
    const known = world.knownStates(8);
    if (known.length === 0) {
      line(out, r, row++, `  ${COLOUR.faint}(nothing observed yet)${RESET}`);
    } else {
      for (const state of known.slice(0, Math.max(0, r.h - row - 1))) {
        line(
          out,
          r,
          row++,
          `  ${COLOUR.faint}${String(state.observations).padStart(3)}×${RESET} ${COLOUR.value}${fit(state.content, r.w - 12)}${RESET} ${COLOUR.faint}→${state.transitions}${RESET}`,
        );
      }
    }
  }

  /** The full-width strip: beliefs, calibration, skills. */
  #strip(out: string[], r: Rect): void {
    const { beliefs, calibrator, episodic, semantic, skills } = this.#parts;
    const inner = panel(out, r, 'beliefs, calibration, memory');
    let row = 0;

    // Beliefs, with conflicts marked — an unmarked conflicted belief is the
    // most misleading thing a belief panel can show.
    const held = beliefs.all();
    const conflicted = held.filter((b) => b.conflicted).length;
    line(
      out,
      inner,
      row++,
      `${COLOUR.label}beliefs${RESET} ${COLOUR.value}${held.length}${RESET}` +
        (conflicted > 0 ? `  ${COLOUR.bad}${conflicted} conflicted${RESET}` : '') +
        `  ${COLOUR.faint}episodes ${episodic.size} · concepts ${semantic.size}${RESET}` +
        (skills === undefined ? '' : `  ${COLOUR.faint}skills ${skills.size}${RESET}`),
    );

    for (const belief of held.filter((b) => b.conflicted).slice(0, 2)) {
      line(out, inner, row++, `  ${COLOUR.bad}⚡${RESET} ${COLOUR.value}${fit(belief.proposition, inner.w - 8)}${RESET}`);
    }
    for (const belief of held.filter((b) => !b.conflicted).slice(0, Math.max(0, 3 - conflicted))) {
      const colour = belief.credence > 0.7 ? COLOUR.good : belief.credence > 0.4 ? COLOUR.label : COLOUR.faint;
      line(
        out,
        inner,
        row++,
        `  ${colour}${belief.credence.toFixed(2)}${RESET} ${COLOUR.faint}${fit(belief.proposition, inner.w - 10)}${RESET}`,
      );
    }
    if (held.length === 0) line(out, inner, row++, `  ${COLOUR.faint}(nothing believed yet)${RESET}`);

    // Calibration: the panel that changes how you read every other number.
    const report = calibrator.report('world-model');
    const verdictColour =
      report.verdict === 'well-calibrated'
        ? COLOUR.good
        : report.verdict === 'insufficient-data'
          ? COLOUR.faint
          : report.verdict === 'uninformative'
            ? COLOUR.warn
            : COLOUR.bad;
    row = Math.max(row, inner.h - 1);
    line(
      out,
      inner,
      row,
      `${COLOUR.label}calibration${RESET} ${verdictColour}${report.verdict}${RESET} ` +
        `${COLOUR.faint}n=${report.resolved} brier=${report.brier.toFixed(3)} bias=${report.bias >= 0 ? '+' : ''}${report.bias.toFixed(3)} skill=${report.skill.toFixed(2)}${RESET}`,
    );
  }

  #footer(out: string[], w: number, h: number): void {
    const notice = this.#notice();
    const promptRow = h - 3;
    const helpRow = h - 2;

    out.push(`${ESC}${promptRow};1H${COLOUR.frame}${'─'.repeat(w)}${RESET}`);
    out.push(
      `${ESC}${promptRow + 1};1H${COLOUR.accent}›${RESET} ${COLOUR.value}${this.#input}${REVERSE} ${RESET}`,
    );
    if (notice.length > 0) {
      out.push(`${ESC}${helpRow};1H${COLOUR.warn}${fit(notice, w)}${RESET}`);
    } else {
      out.push(
        `${ESC}${helpRow};1H${COLOUR.faint}${fit('type an observation and press Enter  ·  :state :beliefs :goals :memory :help  ·  Ctrl-C to quit', w)}${RESET}`,
      );
    }
  }
}

// ── input plumbing ──────────────────────────────────────────────────────────

/**
 * Read lines from a TTY with an editable buffer, returning a disposer.
 *
 * Raw mode rather than `readline`, because the dashboard owns the whole screen
 * and readline would fight it for the cursor. The editing supported is exactly
 * what a single-line prompt needs: characters, backspace, Enter, Ctrl-C, and
 * the arrow-free basics. Anything more would be a text editor.
 */
export const readLine = (
  onLine: (text: string) => void,
  onRedraw: (buffer: string) => void,
  onCancel: () => void,
): (() => void) => {
  const stdin = process.stdin;
  let buffer = '';

  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  const onData = (chunk: string): void => {
    for (const char of chunk) {
      if (char === '\u0003') {
        onCancel();
        return;
      }
      if (char === '\r' || char === '\n') {
        const text = buffer;
        buffer = '';
        onLine(text);
        continue;
      }
      if (char === '\u007f' || char === '\b') {
        buffer = buffer.slice(0, -1);
        onRedraw(buffer);
        continue;
      }
      // Ignore other control characters rather than inserting them into the
      // prompt, where they would be invisible and impossible to delete.
      if (char < ' ' && char !== '\t') continue;
      buffer += char;
      onRedraw(buffer);
    }
  };

  stdin.on('data', onData);

  return () => {
    stdin.off('data', onData);
    if (wasRaw !== true) stdin.setRawMode(false);
    stdin.pause();
  };
};

export const terminalControl = { CLEAR, HIDE_CURSOR, SHOW_CURSOR, RESET };
