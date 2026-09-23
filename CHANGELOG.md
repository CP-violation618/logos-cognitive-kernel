# Changelog

All notable changes to LOGOS. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), and while it is
below 1.0 the API should be expected to change.

The entries below record not only what changed but, where a real defect was
found, what the wrong behaviour was — because a changelog that only says "fixed
memory bug" teaches a reader nothing about whether their understanding was
wrong too.

---

## [Unreleased]

Nothing yet. The metacognitive layer beyond calibration — a self-model and
strategy selection — is the next planned work, along with a skill registry and
optional LLM adapters layered on top.

---

## [0.1.0] — 2025-01-01

The first coherent version: seven layers, an integrated cognitive cycle, a CLI,
and 547 tests.

### Kernel

- **Clock** separating logical ticks from wall time, so an entire cognitive
  trajectory is reproducible in a test.
- **EventBus** with synchronous dispatch — a microtask boundary would turn
  "consolidate before revise" into a race — and listener isolation, so one
  broken module cannot blind the mind.
- **Scheduler** modelling attention as scarcity: a hard per-tick budget, tasks
  that yield rather than being preempted, and a rule that a task is never
  re-admitted within one tick, which is what makes yielding mean something.
- **Rng** (xoshiro128\*\*) behind one seeded source, so every stochastic choice
  is replayable.
- **Config**: one deep-frozen validated tree with named presets, refusing
  incoherent combinations at construction.

*Fixed during development:* the scheduler charged a task its full allowance even
when it completed without yielding, so the tick budget was silently consumed by
work that never happened.

### Memory

- **Working memory** with hard capacity, decay, rehearsal that lengthens the
  half-life, and biased competition between similar thoughts.
- **Vector utilities**: hashing-trick embeddings with CJK bigram tokenisation,
  and a deliberately timid stemmer.
- **Episodic memory** that is time-indexed, context-bound, and *reconstructive* —
  recall re-encodes a memory with the present context folded in, making it
  stronger and less faithful at once.
- **Semantic memory** where concepts are constructed from recurring experience,
  grounded in distinct sources, with contested properties preserved rather than
  flattened, and spreading activation over a weighted graph with recorded paths.
- **Consolidation** generalising only what recurs, marking sources rather than
  deleting them, and linking concepts that share experiences.
- **Recall** across all four systems with cross-store spreading activation in
  both directions, and mood applied once globally rather than per store.

*Fixed during development:* forgetting required only one of {strength below
threshold, protection window elapsed}, discarding vivid episodes at half
strength; and the protection window was equated with the half-life, so
significant memories drifted toward the threshold for a long time and were
discarded the moment they crossed it. Both now behave the other way round.

*Fixed during development:* concept labels were assembled alphabetically, so
"the payment gateway timed out" generalised to "gateway out payment timed".
Every test passed — labels are only compared for equality — but a phrase
depends on its word order.

*Fixed during development:* a single retrieval threshold governed both "is this
worth returning" and "is this actually about the query", so a low bar admitted
unrelated traces as direct hits and thereby suppressed the association route.

### Perception

- **Attentional gate** built on the claim that salience is intensity's opposite:
  surprise relative to expectation, with novelty, goal relevance and affect as
  secondary terms.
- **Habituation** recovering only with absence, with a floor so nothing becomes
  invisible.
- **Load adaptation** moving the threshold in whichever direction the situation
  demands.
- **World model** as its prediction source, which is what couples perception to
  reasoning instead of leaving them unrelated.

*Fixed during development:* the adaptation sign was inverted, creating a
positive feedback loop that would close the gate permanently; memory's refusals
were counted as the gate's own decisions, so a full working memory caused the
gate to lower its bar into an already-full memory; the novelty rescaling
divided by the wrong quantity and returned 0 at *maximum* dissimilarity, making
the term dead; and habituation was recorded only for admitted percepts, making
it inert for the input it exists to handle.

### Reasoning

- **World model**: a first-order Markov chain with Laplace smoothing,
  distributional prediction, reserved probability mass for unseen outcomes, and
  a `determinism` score per state.
- **Beliefs** in log-odds, so evidence is additive, order-independent, and
  retractable; with source discounting, a conflicted flag distinct from
  ignorance, and a revision log explaining every movement.

*Fixed during development:* renormalising the returned successor slice handed
back the mass smoothing had reserved, so a state observed once reported
probability 1.0 and determinism 1.0. The returned probabilities now deliberately
do not sum to 1 — the shortfall is the model admitting it has not seen
everything.

*Fixed during development:* belief updates applied source discounting
incrementally, breaking the documented promise that evidence order does not
matter. The same three facts in three orders produced 0.897, 0.902 and 0.848.
The sum is now rebuilt in a canonical order.

### Planning

- **Goals** with decomposition, upward propagation of success and failure,
  priority as a judgement rather than a stored number, deadline urgency, sunk
  cost weighted below the other terms, and abandonment that records the
  arithmetic behind it.
- **HTN planner** with backtracking, cycle detection, preconditions checked
  against an evolving state, product confidence, and failures that name the
  routes they rejected.

*Fixed during development:* a local variable typed as `0 | 1` by inference made
`reduce` refuse a numeric accumulator — annotated rather than cast, because the
annotation states the intent.

### Metacognition

- **Calibration** measured by Brier score, decomposed into reliability
  (discrimination between the two failure modes via the sign of the bias) and
  resolution, with per-domain estimates and an applied correction rather than a
  displayed one.

*Fixed during development:* the baseline Brier score was written `2p(1-p)`.
Expanding "always answer the base rate" gives `p(1-p)`, so the doubling
reported a skill of 0.5 for a forecaster with no skill at all.

### Skills

- **Procedural memory**: skills with mastery estimated from outcomes rather than
  declared, composition into branches and repeats, and preconditions checked
  before an attempt so that "I cannot do this here" is never recorded as "I am
  bad at this".
- **Automatization**: attention cost falls geometrically as mastery rises, so a
  practised skill has stopped being deliberate and the scarce resource is freed
  for something else.
- Mastery falls faster than it rises, because success can be luck and failure
  usually is not; and the step size shrinks with attempts so the estimate
  converges rather than oscillating.

*Fixed during development, and this one made the whole layer inert:*

1. **Declared cost and charged cost were different quantities.** A one-step
   skill declared an attention cost of 0.57 and then charged 1.0 per step, so
   every unmastered skill was interrupted before its first action and mastery
   could never move. Both now come from one function.
2. **A floating-point remainder refused the first step.** Even after that fix,
   the budget was the ROUNDED public figure (0.694) while the charge was the
   unrounded one (0.6940000000000001), so the remainder went fractionally
   negative and the attempt was refused as "attention exhausted". The budget is
   now computed from the unrounded value, with an explicit tolerance, because an
   exact-zero remainder is success and not exhaustion.
3. **Structural steps were charged as if they were work.** A `repeat` or
   `branch` deducted a step's worth of attention for being a container, so a
   procedure cost more than the steps it performs and could be interrupted
   halfway with attention spent on nothing.
4. **A deeper frame's specific reason was overwritten by its caller's summary.**
   "Nesting exceeded the depth limit — likely a cycle in the skill graph" became
   "a step failed", discarding the only fact worth having.

### Cognition

- **CognitiveAgent** wiring every layer into one cycle: perceive, orient,
  recall, evaluate, deliberate, act, predict, reflect. Orient precedes recall so
  surprise is measured before reassurance; predict precedes reflect so
  reflection scores predictions from earlier cycles.
- **CLI** (`demo`, `repl`, `inspect`, `bench`, `help`) on `node:util` with no
  dependencies.
- **Worked scenario**: a service that fails under load across calm, incident and
  repair phases.

*Fixed during development, and each one found only by running the demo rather
than by any unit test:*

1. **Nothing ever wrote episodic memory.** The cycle perceived, reasoned,
   planned and acted but never recorded that anything had happened, so
   consolidation read an empty store and no concept was ever formed. Every test
   passed because the tests seeded episodes directly.
2. **The memory stores' own clocks never advanced.** `EpisodicMemory` and
   `SemanticMemory` keep internal ticks and the cycle advanced only the
   kernel's, so every episode sat permanently at tick zero and the
   consolidation age threshold was unsatisfiable forever.
3. **A completed plan stranded its goal**, because completion was only
   recognised inside a method that a short-circuit kept skipping.

4. `Plan.depth` reported the root node's depth, which is always 0, so every plan
   claimed to be flat.

### Infrastructure

- CI on Node 22.6, 22.x and 24.x across Linux, Windows and macOS, plus
  dedicated jobs enforcing determinism, that the examples run, and that the
  zero-runtime-dependency claim in the README is actually true.
- Dockerfile on `node:24-alpine`, running as the unprivileged user, with a
  `.dockerignore` that keeps an agent's runtime memories out of a source image.

---

[Unreleased]: https://github.com/yourname/logos-cognitive-kernel/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yourname/logos-cognitive-kernel/releases/tag/v0.1.0
