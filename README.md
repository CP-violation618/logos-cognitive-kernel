<div align="center">

# LOGOS

**A cognitive kernel for AGI research.**

Layered memory · scarce attention · revisable belief · hierarchical planning · self-measurement

[![CI](https://github.com/yourname/logos-cognitive-kernel/actions/workflows/ci.yml/badge.svg)](https://github.com/yourname/logos-cognitive-kernel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.6-339933.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](#zero-dependencies)
[![Tests](https://img.shields.io/badge/tests-547%20passing-brightgreen.svg)](#testing)

</div>

---

## What this is

LOGOS is a **substrate for minds**. It implements the machinery of cognition —
memory that forgets, attention that is scarce, beliefs that can be revised,
plans that can fail — with no dependence on any particular model or model
provider. It runs on Node with **zero runtime dependencies**.

It's the engineering substrate that the gap between "agent" and "general
intelligence" is actually made of.

## What this is not

**This is not an AGI, and it does not claim to be.** Nobody has built one.
Any repository that says otherwise is optimising for stars.

**This is not an LLM wrapper.** There is no model, no API key, and no prompt
anywhere in this codebase. LOGOS is the other half: the part that decides what
to remember, what to attend to, what to believe, and what to do. Wiring a
language model into it is a later, optional step — the layers are deliberately
agnostic about where percepts come from.

**This is not a finished product.** Metacognitive reflection beyond calibration
is in progress. The API will change.

## The claim being tested

Most "agent frameworks" are orchestration: they call a model in a loop and
manage the plumbing. LOGOS takes the opposite position, and it is a position
that can be checked:

> Cognition is not what happens when you call a model. It is what happens when
> a system has **finite attention, fallible memory, and the ability to notice
> that it was wrong.**

Every module here exists to make one of those three things real rather than
metaphorical, and every one of them is measured. Surprise is a number.
Calibration is a number. Forgetting is a curve with a half-life.

## Quick start

```bash
git clone https://github.com/yourname/logos-cognitive-kernel.git
cd logos-cognitive-kernel
node src/cli.ts demo
```

No install step. Node 22.6+ strips TypeScript types natively, so the source
*is* the artifact.

```
=== LOGOS pipeline scenario (seed 0x5eed) ===

-- phase 1: calm (18 cycles) --
-- phase 2: incident (14 cycles) --
  tick 18: admitted 3/4, surprise 1.00, recalled 5, acted: warm the cache
  tick 26: admitted 1/4, surprise 0.91, recalled 6
-- phase 3: repair (12 cycles) --

  concept "monitor numeric" grounded in 3 episodes (confidence 0.38)
  actions taken: warm the cache, raise the connection pool, restart the service
  goal "the service recovers" is achieved
```

Then explore:

```bash
node src/cli.ts inspect          # what the architecture assembles to
node src/cli.ts bench            # ~3100 cognitive cycles per second
node src/cli.ts repl             # type observations at a live agent
```

## Architecture

Seven layers, strict dependency downward, cross-layer communication only on the
event bus. A layering rule that cannot be checked is a layering rule that will
be broken, so the order is exported as data:

```
  6  skills          what the mind can do, and how fluently
  5  metacognition   how well any of the above is going
  4  planning        what is wanted, and how to get it
  3  reasoning       what follows, and what to believe
  2  perception      what gets in
  1  memory          what is held, what happened, what is true
  0  kernel          time, events, attention budget, randomness
```

```ts
import { LAYERS } from './src/index.ts';
```

### 0 · Kernel

The primitives, and deliberately nothing else.

| Module | What it provides |
|---|---|
| `clock` | Logical ticks separate from wall time, steppable by hand |
| `bus` | Synchronous event dispatch; the only cross-layer channel |
| `scheduler` | Attention as scarcity — a per-tick budget that cannot be overspent |
| `rng` | One seeded source, so every stochastic choice is replayable |
| `config` | One deep-frozen validated tree, with named operating presets |

**The scheduler is not a task queue.** Every unit of thinking must ask for a
slice of a finite per-tick budget, and a task that runs out must *yield* — and
is never re-admitted within the same tick. That single rule is what makes
deliberation spread across cycles instead of running away with one.

### 1 · Memory

Four systems with genuinely different properties, plus the step that connects
them.

- **Working memory** — the bottleneck. Hard capacity, exponential decay,
  rehearsal that *lengthens the half-life* (the spacing effect), and biased
  competition where the strongest thought actively suppresses its neighbours.
- **Episodic memory** — what happened, in order. `replayFrom` walks backward to
  a cause; `replayTo` walks forward to a consequence.
- **Semantic memory** — what is true. Concepts are **constructed**: they emerge
  when several distinct episodes keep pointing at the same thing, and their
  confidence comes from how many independent sources produced them.
- **Consolidation** — where experience becomes knowledge. Only what *recurs* is
  generalised: one vivid episode forms nothing, because promoting an anecdote
  to knowledge is how a system becomes confidently wrong.

The sharpest idea in this layer is **reconsolidation**. Recall is not a read:

```ts
const { id } = episodic.encode('where I left the keys', {
  situation: 'home',
  context: { room: 'kitchen' },
});

episodic.retrieve(id, { context: { room: 'hallway' } });
// The memory is now STRONGER and LESS FAITHFUL.
// `reconsolidations` reports how many times it has been rewritten.
```

### 2 · Perception

The only path by which outside information enters the mind, built on one claim:

> **Salience is not intensity.** A bright light is not interesting. A bright
> light *when it is dark* is.

So the gate takes a prediction source rather than standing alone — which is
what couples perception to the world model instead of leaving them as two
unrelated modules. Five contributions (novelty, intensity, goal relevance,
surprise, affect) with **surprise dominant**, because being wrong is the most
informative thing that can happen.

Two mechanisms keep the gate from being either a pass-through or a wall:
**habituation**, which is the only reason a mind in a constant environment can
notice a change in it; and **load adaptation**, which moves the threshold in
whichever direction the situation demands.

### 3 · Reasoning

- **World model** — a learned model of what follows what. Prediction is
  *distributional*, smoothing reserves probability mass for outcomes never
  seen, and `determinism` reports how predictable a situation is.
- **Beliefs** — held in **log-odds**, which is not a numerical nicety but the
  thing that makes evidence *additive* (so order never matters) and
  *retractable* (so a mind can un-believe something it was told in error).

```ts
beliefs.declare('the bridge is safe', { prior: 0.5 });
beliefs.addEvidence('the bridge is safe', {
  content: 'an engineer inspected it',
  source: 'inspection-report',
  strength: 8,            // likelihood ratio
});
// A second report from the SAME source counts for less.
// Retracting one restores the prior exactly.
```

### 4 · Planning

- **Goals** with structure, price, and the option to give up. Priority is a
  *judgement* recomputed from the situation, not a stored number: value weighed
  against feasibility, deadline urgency, and sunk cost — the last weighted
  *below* the others, because an architecture that ignored expenditure would
  thrash between goals and one that obeyed it fully would persist at hopeless
  ones.
- **HTN planner** — decomposition rather than action-sequence search, because
  hierarchy is the one thing an experienced agent actually has. Backtracking
  with cycle detection, preconditions checked against an evolving state, and
  failures that explain which routes were tried and why each was rejected.

### 5 · Metacognition

Knowing how much to trust yourself. A system that reports confidence but never
checks it is not self-aware, it is merely expressive.

```ts
calibrator.predict('the deploy will succeed', 0.9, { domain: 'operations' });
calibrator.resolve(prediction.id, false);   // it did not

calibrator.report('operations');
// { brier, reliability, resolution, skill, bias, verdict: 'overconfident' }

calibrator.adjustedConfidence(0.9, 'operations');  // → 0.71
```

**Overconfidence and underconfidence have the same reliability error and need
opposite remedies** — one should gather more evidence, the other should act on
what it already has. The sign is preserved and named. And the adjustment is
*applied*, not displayed: a calibration chart nobody acts on has taught nothing.

### 6 · Skills

What the mind can **do**, as distinct from what it knows. Procedural memory is a
different kind of thing from declarative memory, and the difference is what
makes it worth building separately:

```ts
skills.define({
  name: 'restart the service',
  achieves: 'the service recovers',
  steps: [
    { kind: 'action', name: 'warm the cache' },
    { kind: 'action', name: 'raise the connection pool' },
    { kind: 'action', name: 'restart the service' },
  ],
  prior: 0.2,     // a guess, which practice replaces
});

const attempt = await skills.attempt('restart the service', context);
// { succeeded, masteryBefore: 0.2, masteryAfter: 0.39, cost: 0.69, ... }
```

Three properties, and the third is what makes this a separate system rather
than a table of functions:

- **Skills improve with practice, measurably.** Mastery rises with success and
  falls with failure — and falls *faster*, because success can be luck and
  failure usually is not.
- **A failure of preconditions is not a failure of competence.** "I cannot do
  this here" and "I am bad at this" are different facts, and conflating them
  teaches a mind to avoid things it is good at. An unmet precondition moves
  nothing and costs nothing.
- **Practice makes a skill cheaper, not just better.** This is automatization:
  a mastered skill costs less of the attention budget because it has stopped
  being deliberate, so the scarce resource is freed for something else. Measured
  at the defaults, mastering a one-step skill takes its cost from 0.69 to 0.15
  units.

Skills compose — a step may be another skill, a branch, or a repeat — and cost
accounting charges for actual work while counting structure as free.

## Zero dependencies

```
runtime dependencies: 0
devDependencies:      2   (@types/node, typescript)
```

Not a stunt. It means the entire architecture is auditable in an afternoon, it
cannot rot when a dependency does, and every behaviour is deterministic — which
is what makes a cognitive system testable at all.

Achieved by using only what Node provides: `node:test` for the runner,
`node:util` for argument parsing, native TypeScript type stripping instead of a
build step. Type checking still runs under `strict` plus
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and
`erasableSyntaxOnly`.

## Testing

```bash
node --test "test/**/*.test.ts"   # 547 tests
npx tsc --noEmit                  # type check
```

Tests are the argument, not the paperwork. Where a claim in a doc comment can
be checked, it is checked — including the *limits*:

- that priming is **lexical, not semantic**, so a synonym with no shared
  vocabulary does not get a boost — pinned down so a future embedding model
  shows up as a deliberate change rather than silent drift;
- that observing one episode repeatedly does **not** inflate a concept's
  grounding, because repetition without variety is not knowledge;
- that **always saying 50%** about a fair coin is perfectly calibrated and
  completely useless, which is why resolution and skill are reported alongside
  reliability.

Many defects found during development were found this way. Two worth naming,
because they were "obviously right" arithmetic:

- Novelty was rescaled as `1 - similarity / 0.2`, which returns **0** at
  maximum dissimilarity. Both identical text and completely unrelated text
  scored novelty 0 — the term was dead, and every percept in a novel situation
  was being scored as maximally familiar.
- The baseline Brier score was written `2p(1-p)`. Expanding "always answer the
  base rate" gives `p(1-p)`, so the doubling reported a skill of **0.5** for a
  forecaster with no skill at all.

## Determinism

Everything is seeded and reproducible. The same inputs produce the same mental
trajectory — which is the precondition for debugging a mind, and the reason a
bug report against this architecture can be a *test case* rather than a
description.

```bash
node src/cli.ts demo --seed 1234    # same every time
```

## Project layout

```
src/
  kernel/          clock · bus · scheduler · rng · config · types
  memory/          vector · working · episodic · semantic · consolidation · remember
  perception/      gate
  reasoning/       world-model · beliefs
  planning/        goals · planner
  metacognition/   calibration
  skills/          registry       ← procedural memory
  cognition/       agent          ← the integrated cycle
  scenarios/       pipeline       ← a worked demonstration
  cli.ts
test/              547 tests across every layer, plus integration
examples/          quickstart.ts  — a runnable tour
docs/              ARCHITECTURE.md — the long-form design argument
```

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the design argument in
  full: why each layer exists, what the alternatives were, and what each choice
  costs.
- **[examples/quickstart.ts](examples/quickstart.ts)** — a runnable tour of
  every layer (`node examples/quickstart.ts`).

## Status

| Layer | Tests | State |
|---|---|---|
| Kernel (clock · bus · scheduler · rng · config) | 52 | ✅ complete |
| Memory (working · episodic · semantic · consolidation · recall) | 184 | ✅ complete |
| Perception (salience · habituation · load adaptation) | 34 | ✅ complete |
| Reasoning (world model · Bayesian beliefs) | 84 | ✅ complete |
| Planning (goals · HTN planner) | 64 | ✅ complete |
| Metacognition (calibration · bias correction) | 39 | ✅ complete |
| Skills (procedural memory · practice · automatization) | 50 | ✅ complete |
| Cognition (integrated cycle) | 31 | ✅ complete |
| Integration (perception ↔ world model) | 9 | ✅ complete |
| Self-model and strategy selection | — | ⏳ planned |
| Skill registry and composition | — | ⏳ planned |
| LLM adapters (optional, layered on top) | — | ⏳ planned |

**547 tests total.** Roughly 13,000 lines of source and 8,000 lines of tests — a ratio the project is deliberate about, because the tests are the argument rather than the paperwork.

## Requirements

Node **22.6.0** or later. Nothing else.

> **Note for contributors:** if `npm install` reports "up to date" and installs
> nothing, your npm is configured with `omit=dev`. Use
> `npm install --include=dev`.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

The design draws on decades of cognitive science: Baddeley's working memory,
Tulving's episodic/semantic distinction, Ebbinghaus on forgetting and spacing,
Rescorla–Wagner on surprise-driven learning, Friston's predictive coding, and
the Newell–Laird–Rosenbloom and SOAR traditions in cognitive architecture. The
errors in interpreting that work are this project's own.
