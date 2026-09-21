# LOGOS — Architecture

The long-form design argument. The README says *what* exists; this says *why*,
what the alternatives were, and what each choice costs.

---

## The premise

Most systems called "agents" are orchestration. They call a model in a loop,
manage the plumbing, and hope that enough calls in the right order produce
something that looks like thinking.

LOGOS starts from a different premise, and it is one that can be checked:

> Cognition is not what happens when you call a model. It is what happens when
> a system has **finite attention, fallible memory, and the ability to notice it
> was wrong.**

Each of those three is a constraint, not a feature. A system with unlimited
attention never needs to form a concept, because it can hold everything. A
system with perfect memory never needs to generalise, because it can always
look up the specific case. A system that cannot be wrong never needs to learn
anything, because it never is.

So every layer here exists to make one of those constraints *real*, and the
test suite exists to prove it is real rather than decorative. Surprise is a
number. Calibration is a number. Forgetting is a curve with a half-life.
Where a claim cannot be measured, it does not belong in this codebase.

---

## Layering

Six layers. Dependencies point strictly downward. Layers do not call each other
sideways; they announce facts on the event bus and subscribe to facts they care
about.

```
  5  metacognition   calibration · bias correction
  4  planning        goals · hierarchical task networks
  3  reasoning       world model · beliefs
  2  perception      the attentional gate
  1  memory          working · episodic · semantic · consolidation · recall
  0  kernel          clock · bus · scheduler · rng · config
```

That single rule — no sideways imports — is what keeps a ten-module cognitive
architecture from becoming a ten-way tangle, and it is what makes replay
possible: an agent's entire mental history is the ordered sequence of events
that crossed the bus.

The ordering is exported as data rather than living only in prose:

```ts
import { LAYERS } from './src/index.ts';
```

A layering rule that cannot be checked is a layering rule that will be broken.

**What the layering costs.** Some things are genuinely awkward to express. The
perceptual gate needs the world model's predictions, but the world model is
built *from* the memories the gate produces, so the gate is constructed first
and the predictor attached afterwards via a setter. That is an admission that
the dependency graph has a cycle in it, resolved by construction order rather
than by design. It is documented at the call site rather than hidden.

---

## Layer 0 — Kernel

### Logical time is not wall time

`Clock` maintains both. Wall time is for timeouts and log lines; logical ticks
are what the mind reasons in, and they are monotonic, freezable, and steppable
by hand.

**Why it matters.** Every interesting claim about a cognitive architecture is a
claim about *ordering* — which memory was consolidated before which plan was
revised — and ordering is untestable if it is expressed in milliseconds
produced by a real machine under real load. A test can drive a thousand
simulated cycles in microseconds and assert on the resulting mental state.

### The event bus dispatches synchronously

Listeners run immediately, in registration order, with no microtask boundary.

**Why.** A microtask boundary would turn "consolidate before revise" into a
race. Cognitive ordering must be exact.

A listener that throws cannot break dispatch. The error is routed to
`onListenerError` and the remaining listeners still run. One broken module must
not blind the mind.

### The scheduler models attention as scarcity

This is the most consequential design decision in the kernel, and it is easy to
mistake for a task queue.

Every unit of thinking is a `CognitiveTask` that asks for a slice of a finite
per-tick budget. When the budget runs out, a task is *asked to yield*. It may
refuse (short tasks finish atomically), it may accept (long deliberation
resumes next tick), and it must report how confident it currently is.

Three properties follow, and none of them are available if you just `await`
everything:

1. **Bounded work per tick.** The mind can never be lost to one runaway
   computation. A tick is a hard ceiling on effort.
2. **Interruptibility as a first-class state.** "Half-finished thought" is a
   real, addressable thing rather than a lost stack frame.
3. **Determinism.** Ordering is a three-key total order — priority descending,
   deadline ascending, insertion sequence ascending — with the insertion key
   removing `Array.prototype.sort` stability from the correctness argument.

The rule that makes yielding mean something: **a task is never re-admitted
within the same tick.** Without it, a task that yields is immediately the
highest-priority candidate again, so one tick would run it to completion and
yielding would be a no-op disguising an unbounded loop.

**Cost accounting.** A task that *finishes* is charged its declared effort; a
task that *yields* is charged its entire slice. Interrupting a thought is not
free — state must be parked and restored — and charging for it is what makes
the tick budget an honest ceiling rather than a suggestion.

### One seeded RNG

xoshiro128\*\* behind a single source. Every stochastic choice in the kernel is
replayable.

**Why.** Cognitive architectures make random choices constantly — which memory
to probe, which goal to pursue when two tie, which hypothesis to sample. If
those come from `Math.random()`, a bug report cannot be reproduced, a benchmark
cannot be compared across commits, and no regression test can assert on
anything that depends on ordering.

### Configuration is frozen and validated

One deep-frozen tree, with named presets that are partial overrides rather than
copies — so a preset is honest about which knob it actually turns.

Incoherent configurations are refused loudly at construction: an attention
threshold of exactly zero, more task slots than budget units, a premise
threshold of 1.0. **A configuration error in a cognitive system does not crash,
it just makes the mind subtly wrong** — which is the worst class of bug, so it
is the one class the config layer is allowed to be pedantic about.

---

## Layer 1 — Memory

Four systems with genuinely different properties, and the step that connects
them. They are not four buckets; they differ in capacity, duration, and what
they are *for*.

### Working memory: the bottleneck

Hard capacity. Exponential decay by half-life. Low-salience refusal and
displacement — a full mind rejects incoming trivia rather than forgetting what
it already holds.

Two mechanisms are worth singling out because a naive implementation gets them
wrong:

**Rehearsal lengthens the half-life, not just the activation.** Retrieving a
slot raises its activation *and* makes it structurally more durable. This is
the empirical shape of the forgetting curve, and it is why the tenth review of
a fact costs less than the first and sticks longer.

**Attention is a competition, not a filter.** The strongest slot suppresses
neighbours whose content is similar, proportionally to similarity. A mind
holding "the meeting is at three" and "the meeting is at four" resolves
decisively toward one of them, while two unrelated thoughts coexist happily.
Top-down priming from an active goal biases the competition *and* slows the
decay of what it favours — an attended thought is held, not merely boosted.

**A deliberate position on capacity.** The folk figure is "7 ± 2", but the
modern replication literature puts deliberate maintenance closer to 4. The
default is 7 because the rest of the architecture was tuned against it, but the
honest number is lower and a caller who cares should say so.

### Vector utilities: meaning without a model

There is no embedding network to call, so the hashing trick is used: every
token is hashed into a fixed-width signed vector, damped by `1 + log(tf)`, and
L2-normalised.

This is genuinely useful, not a stand-in:

- it is deterministic, so a trace re-encodes to the same place every time;
- it needs no vocabulary, no training pass, and no persistence;
- it degrades gracefully — unseen tokens still collide usefully.

**What it cannot do, tested explicitly:** two paraphrases that share no tokens
are not recognised as similar. "automobile" and "motorcar" score at the
no-overlap baseline. This is pinned down by a test, so swapping in a real
semantic model later shows up as a deliberate behavioural change rather than
silent drift. The interface provides for what the embedding cannot infer: an
explicitly declared alias is a caller's claim and is honoured directly.

**The stemmer is deliberately timid.** An aggressive stemmer is far worse than
none: folding "bridge" and "bridges" onto different stems *destroys* a match
that raw string comparison would have found. Every rule is narrow,
length-guarded, and biased toward leaving a token alone. Verified against a
labelled set of English inflection groups: 26 of 29 fold correctly with zero
false convergences. Derivational pairs like structure/structural are
deliberately *not* merged, and that limit is pinned by a test.

### Episodic memory: retrieval is reconstruction

Time-indexed and sequence-linked, so `replayFrom` walks backward to a cause and
`replayTo` forward to a consequence. Context-bound retrieval scores situation
and context separately from content — being in the same situation is precisely
what makes a specific past event come back.

The sharpest idea in the layer is **reconsolidation**. `retrieve()` re-encodes
the episode at the current instant with the present context folded in, so
repeated recall makes a memory **both stronger and less faithful**, and
`reconsolidations` reports how many times it has been rewritten.

This is not a gimmick. Memory in biological systems is reconstructive, and the
consequence — that a confidently-held memory can be a repeatedly-rewritten one
— is exactly the kind of thing a cognitive architecture should be able to
represent rather than smooth over.

**Survival is governed by significance**, in the order surprise → self-relevance
→ affect. An uneventful hour and a shocking personal event are not given the
same shelf life, and the tests *measure* the resulting order of magnitude (21
vs 289 ticks at default settings) rather than asserting a feel.

Two design errors were found here by measurement, and both are worth recording:

- Forgetting originally required only **one** of {strength below threshold,
  protection window elapsed}. That discarded vivid episodes while they were
  still at half strength. It now requires **both**: the decay curve decides
  what is faint, the window protects what was just recalled.
- The protection window was originally equated with the half-life, so a long
  half-life implied both slow decay *and* a long window — significant memories
  spent a very long time drifting toward the threshold and were discarded the
  moment they crossed it. The window is now capped, so the strength threshold
  decides. Significant memories are the ones most worth keeping; the original
  design had it backwards.

### Semantic memory: concepts are constructed

A concept does not appear because someone declared it. It emerges when several
distinct episodes keep pointing at the same thing, and its definition is the
intersection of what those episodes had in common.

Three consequences, each implemented rather than assumed:

**Grounding counts distinct sources.** Observing the same thing five times in
one situation is one piece of evidence. Counting it as five would make a mind
wildly overconfident about whatever happened to be in front of it. Durability
is *derived* from grounding rather than accumulated alongside it, so the two
cannot drift apart — measured retention with a 100-tick base half-life:
grounding 1 survives 466 ticks, grounding 8 survives 1801.

**Disagreement is preserved.** When episodes contradict each other, both values
are kept, a majority is only recognised at 75% support, and noticing the
contradiction itself lowers confidence. A mind that has spotted a disagreement
is in a genuinely different state from one that has not, and flattening that
away is a loss of information rather than a simplification.

**Traversal is spreading activation**, with accumulation across routes,
attenuation per hop, no immediate flow back to the source, and a recorded
**path** for every association — so a connection can be explained after the
fact instead of guessed at.

### Consolidation: where experience becomes knowledge

Reads a set of episodes and writes the invariant they share. The hard part is
not summarising texts; it is deciding what deserves to become a concept at all.

**Only what recurs does.** One episode yields nothing, however vivid, because
promoting an anecdote to knowledge is how a system becomes confidently wrong.
Two fall below the default minimum of three. Many yield an entrenched concept
whose confidence and durability grow with the number of distinct sources.

Three further decisions, each a choice rather than a consequence:

- **Abstraction is by intersection, then difference.** The label is the
  vocabulary shared by *every* member — the invariant. The vocabulary that
  distinguishes members is recorded as incidental detail and discarded. A token
  present in most-but-not-all members describes the cluster's tendency rather
  than its identity, so it is not allowed into the label.
- **Clustering is single-pass and online.** Each episode joins the cluster it
  is most similar to, judged against that cluster's centroid. Agglomerative
  clustering would produce marginally tighter groups and a much worse account
  of how a mind works: you do not re-examine every past experience each time a
  new one arrives.
- **Source episodes are marked, never deleted.** Generalising does not erase
  the experiences that produced it. A mind that forgot the events but kept the
  conclusion could never re-examine its own reasoning, which is the entire
  basis of metacognition.

A defect found by *running* rather than by testing: concept labels were
assembled in alphabetical order, so a cluster of "the payment gateway timed out
on ..." episodes generalised to the label "gateway out payment timed". Every
test passed, because labels are only ever compared for equality — "gateway out
payment timed" is perfectly stable and unique. It is just not a label any mind
could use, because the shared tokens are a **phrase** and a phrase depends on
its word order. Labels are now ordered by first appearance.

### Recall: one question, four stores, one answer

A facade, and the answer to "what do I know about this?"

Two mechanisms make it more than a merge of four result lists:

**Cross-store spreading activation, in two directions.**

```
episodes ──generalise to──▶ concepts ──remind of──▶ other episodes
```

A recalled episode activates the concepts it contributed to, those concepts
activate their associates, and those associates reach back into episodic memory
for other experiences of the same thing. Recalling one incident brings back
both the rule it taught and the other occasions that taught the same rule — a
two-hop round trip no single store can perform alone.

**Mood is applied once, globally.** Affective bias is a property of the
rememberer, not of a store. Applying it per store would make the bias compound
with every store consulted, so a mild low mood would become a total filter by
the fourth lookup.

A design defect found here: a single `threshold` governed both "is this worth
returning" and "is this actually about the query". A high bar for direct
matches also silenced association, while a low bar let the embedding's
no-overlap baseline (0.2) admit unrelated traces as direct hits — which then
suppressed the association route via de-duplication. `directThreshold` now sets
that bar separately.

---

## Layer 2 — Perception

The only path by which outside information enters the mind, built on a single
claim:

> **Salience is not intensity.** A bright light is not interesting. A bright
> light *when it is dark* is.

So the gate takes a `PredictionSource` rather than standing alone. That is what
couples perception to the world model instead of leaving them as two unrelated
modules, and it is why "surprise" here is a measured quantity rather than a
metaphor.

Five contributions:

| Term | Weight | What it is |
|---|---|---|
| Surprise | 0.35 | Violation of a prediction. Dominant, because being wrong is the most informative thing that can happen. |
| Novelty | 0.25 | Distance from what is *currently held*. Measured against working memory, not long-term memory: what makes something newsworthy is that it is unlike what the mind is thinking about now. |
| Relevance | 0.20 | Similarity to an active goal. This is how a goal steers perception without filtering anything out. |
| Intensity | 0.10 | Raw signal strength. The only term about the input itself, and deliberately the weakest. |
| Affect | 0.10 | Threat and reward cut through. |

Weights are normalised at construction so the terms can never sum past 1, which
would let salience exceed its own range and make the threshold meaningless.

**Habituation** is the only reason a mind in a constant environment can notice
a change in it. Response declines with the logarithm of repetition count —
the first few repetitions carry almost all of the effect — and recovers with
**absence**, and only with absence. A partial recovery growing with every
passing instant would mean a stimulus repeated every twenty ticks never
habituated at all, which is precisely the case habituation exists to handle.
It has a floor: nothing becomes invisible.

**Load adaptation** moves the threshold in whichever direction the situation
demands. A bottleneck that is always saturated stops being a filter and becomes
a wall, so the gate raises its bar when memory is under pressure and lowers it
when it has been turning everything away.

Four defects were found here, three of them in arithmetic that looked obviously
right:

1. **The adaptation sign was inverted.** It raised the threshold when the gate
   was rejecting — a positive feedback loop that would close the gate
   permanently.
2. **Memory's refusals were counted as the gate's decisions.** When working
   memory filled up, every further percept was refused *by memory*, the
   measured admission rate collapsed, and the gate "helpfully" lowered its bar
   into a memory that was already full. Refusals by memory are now tracked
   separately, and memory pressure pushes the threshold *up*.
3. **The novelty rescaling divided by the wrong quantity.** `1 - most / 0.2`
   returns 0 at maximum dissimilarity, so both identical text and completely
   unrelated text scored novelty 0. The term was dead, and every percept in a
   novel situation was being scored as maximally familiar.
4. **Habituation was recorded only for admitted percepts.** A repeated stimulus
   that kept being refused is exactly the case habituation exists for, so the
   mechanism was inert for the input it was built to handle.

---

## Layer 3 — Reasoning

### World model: what follows what

A first-order Markov chain over observed states, with Laplace smoothing. That
is a deliberate ceiling on sophistication: the point of this layer is to make
surprise and expectation *available*, and a simple model that can be reasoned
about beats a complex one that cannot.

Three commitments:

**Prediction is distributional.** The model reports a distribution over
successors, because the interesting cases are where several outcomes are
plausible and one just occurred. Surprise is the improbability of what actually
happened — not 1 minus the probability of the most likely thing. The difference
matters: when a second-placed outcome occurs, the former reports a small
surprise while the latter would report the same surprise as a never-seen event.

**Unknown is not surprising.** An observation from an unknown state is novel,
and novelty is attention's business. `surpriseOf` returns `undefined` rather
than a number there, because conflating the two would make every first
experience maximally alarming.

**The model knows how much it knows.** Every state carries an observation
count, every prediction a support count, and every state a `determinism` score —
normalised entropy over its successors, including probability mass reserved for
outcomes never seen.

A defect found here was found by *measuring* rather than by testing:
renormalising the returned successor slice handed back exactly the probability
mass the smoothing prior had reserved, so a state observed **once** reported
its single successor at probability 1.0 and determinism 1.0. Maximally
confident after one data point is worse than no model. The unobserved mass now
stays in the distribution, and the returned probabilities deliberately do
**not** sum to 1 — the shortfall is the model admitting it has not seen
everything.

### Beliefs: log-odds, and why

Storing beliefs in log-odds is not a numerical nicety. It is what makes the
rest of the module possible:

- **Evidence accumulates by addition**, because Bayes' rule is a product of
  odds and therefore a sum. Evidence is therefore order-independent.
- **Evidence is retractable**, because each item is a term in that sum. A mind
  that cannot un-believe something after learning it was told in error is not
  reasoning, it is accumulating.
- **Extreme beliefs do not collapse.** Probabilities saturate at 0 and 1 under
  repeated float multiplication; log-odds keep growing.

Three further commitments:

**Source independence is tracked.** Ten reports from one witness are discounted
toward a floor — weak evidence, not no evidence. Reliability damps the
likelihood ratio rather than multiplying it, so an unreliable source can never
*invert* a belief: a liar who says "P" is not evidence for "not P".

**Conflict is not ignorance.** A belief with strong support on both sides sits
near 0.5 but carries a `conflicted` flag. "I have no idea" and "my evidence is
in violent conflict" call for completely different responses, so `isUndecided()`
is true for both while the flag distinguishes them.

**Why is recorded.** A bounded revision log explains every movement, because a
mind that holds a proposition and cannot say what it is based on cannot revise
it, defend it, or learn from it.

**The defect here was a broken promise rather than a bug in passing.** The
class documents that evidence order must not matter, but the implementation
applied source discounting incrementally, so the weight of a witness's second
report depended on whether an unrelated report from somebody else arrived in
between. Measured on the same three facts in three orders: 0.897, 0.902 and
0.848. The sum is now rebuilt from scratch on every change over a canonical
ordering grouped by source. A mind that reaches different conclusions from the
same facts in a different sequence is unusable, and no amount of documentation
makes it acceptable.

---

## Layer 4 — Planning

### Goals are not to-do items

**A goal has a structure.** It decomposes into subgoals, and completion
propagates upward: achieving every part of an `all` parent achieves the parent,
recursively. That is what lets a mind work on a subgoal without losing the
objective it serves.

**A goal has a price.** Priority is a judgement recomputed from the situation,
not a stored number:

```
priority ≈ 0.45·utility + 0.25·feasibility + 0.30·urgency + sunk
```

Sunk cost is weighted *below* the others and configurable to zero. An
architecture that ignored expenditure would thrash between goals; one that
obeyed it fully would persist at hopeless ones. The weight is the dial between,
and the dial is exposed.

**Deadlines create urgency, not just ordering.** Urgency rises steeply in the
final stretch, because the cost of missing a deadline is not linear in its
distance. That term is deliberately able to override a large utility
difference — dropping the important thing for the urgent one is what deadlines
actually do, and an architecture that cannot exhibit it cannot explain
procrastination either.

**Abandonment is a feature.** A mind that never gives up is not persistent, it
is stuck. Abandonment records the reason *and the arithmetic* — expected value,
accumulated cost — because "I decided it was not worth the cost" is the fact
about an agent that shows judgement.

### Planning is hierarchical

A classical planner searches over primitive action sequences. Its cost explodes
with the number of actions, and it discards the one thing an experienced agent
actually has: knowledge of how things are done.

HTN inverts the problem. The agent supplies methods saying "to achieve X, do A,
B and C", and the planner's job is to choose among methods and verify that
their preconditions hold. Search happens over *decompositions*, which is both
far smaller and far closer to how anyone actually plans.

- **Backtracking with a path set**, so a method graph that cycles is caught
  immediately instead of being explored to the depth limit.
- **Preconditions checked against an evolving state.** Effects produce a *new*
  state rather than mutating one, so a rejected branch cannot leave residue for
  the next method to trip over.
- **Confidence is product by default**, and that is the honest choice: a plan is
  a chain, so twenty steps at 95% each is a 36% plan. Reporting the average
  would hide how badly length erodes reliability.
- **Failure explains itself.** Rejections are collected with reasons, so "I
  cannot do this" arrives with which preconditions failed and how many routes
  were tried.

---

## Layer 5 — Metacognition

Knowing how much to trust yourself. A system that reports confidence but never
checks it is not self-aware, it is merely expressive.

Measured with **Brier score**, chosen over log loss because it is bounded,
because it degrades gracefully rather than exploding on one confident miss, and
because its decomposition is exactly the distinction needed:

- **Reliability** is the calibration gap. A system can be perfectly reliable
  and completely useless.
- **Resolution** is discrimination. A system can be sharp and badly wrong.
- **Skill** combines them against the base rate.

Three commitments:

**Predictions are recorded before their outcomes.** A mind that reconstructed
its past confidence from its present knowledge would always find itself well
calibrated and would have learned nothing about itself.

**The sign of the bias is preserved.** Overconfidence and underconfidence have
identical reliability error and need opposite remedies — one should gather more
evidence, the other should act on what it already has. A large directionless
error is called `uninformative` rather than averaged into a misleading middle.

**Calibration is applied, not displayed.** `adjustedConfidence()` returns a
corrected estimate, shrunk toward the observed frequency in proportion to the
evidence, so a mind with three data points does not violently re-scale its
self-assessment. A calibration chart nobody acts on has taught nothing.

Calibration is kept **per domain**, because a mind can be well calibrated about
arithmetic and badly overconfident about people; a single global figure would
average those into a number describing neither.

An arithmetic defect found here: the baseline Brier score was written
`2p(1-p)`. Expanding "always answer the base rate" gives `p(1-p)`, so the
doubling reported a skill of **0.5** for a forecaster with no skill at all —
the one number that must never be flattering. Found by a test asserting that
always saying 50% about a fair coin is not skill.

---

## The integrated cycle

`CognitiveAgent` wires every layer into one loop: perceive, orient, recall,
evaluate, deliberate, act, predict, reflect.

Two orderings are load-bearing:

**Orient before recall.** Surprise is measured against what the world model
already expected, before memory has supplied anything reassuring. Reversed, a
mind would rarely be surprised — it would have already talked itself into
expecting whatever it saw.

**Predict before reflect.** Reflection scores predictions registered on
*earlier* cycles, so it must run against a record that already exists rather
than one made in the same breath. A mind that never wrote down what it expected
cannot check whether it was right.

### Three defects found only by running it

Every unit test passed while the integrated agent was quietly broken, because
every unit test supplied the input that the missing code was supposed to
produce. This is the failure mode that integration testing exists to catch, and
it is worth naming precisely:

1. **Nothing ever wrote episodic memory.** The cycle perceived, reasoned,
   planned and acted, but never recorded that anything had happened — so
   consolidation read an empty store and no concept was ever formed. The memory
   layer was half dead, and the tests all passed because they seeded episodes
   directly.
2. **The memory stores' own clocks never advanced.** `EpisodicMemory` and
   `SemanticMemory` keep internal ticks, and the cycle advanced only the
   kernel's. Every episode sat permanently at tick zero, making every one of
   them eternally "just happened" and the consolidation age threshold
   unsatisfiable forever. Memory that never ages is memory that never
   consolidates.
3. **A completed plan stranded its goal.** `#deliberate` returned an existing
   plan without checking whether it still had steps, and completion was only
   recognised inside `#act` — which `#deliberate` kept short-circuiting before
   reaching. A goal whose plan had run out stayed `active` forever.

Each was found by running the demo and *reading the numbers* — `0ep 0con` when
there should have been episodes and concepts — and each was then covered by the
unit suite.

---

## Determinism as a design constraint

Everything is seeded. The same inputs produce the same mental trajectory.

This is not a testing convenience bolted on at the end; it constrains every
layer. It is why the RNG is injected rather than global. It is why tie-breaking
uses an explicit insertion key rather than relying on sort stability. It is why
the clock is steppable by hand. It is why the belief store rebuilds its
evidence sum in a canonical order instead of accumulating increments.

The payoff is that a bug report against this architecture can be a **test
case** rather than a description.

---

## What is deliberately absent

**No LLM.** Not because language models are uninteresting, but because mixing
one in now would make it impossible to tell which behaviours come from the
architecture and which from the model. The layers are agnostic about where
percepts come from, so an adapter is a later, additive step.

**No embeddings model.** The hashing trick's limits are documented and tested,
which is more honest than a dependency that hides them.

**No persistence layer.** Memory is in-process. Snapshot and restore exist for
the stores that need it, but nothing is written to disk yet — and a distributed
or durable version of this would need a different design for the RNG, or
replay stops working.

**No UI.** The CLI is the interface: `demo`, `repl`, `inspect`, `bench`. A
cognitive architecture's interesting surface is its state, not its chrome.

---

## Influences

The design draws on decades of cognitive science, and the errors in interpreting
that work are this project's own:

- **Baddeley & Hitch** — working memory as a limited workspace.
- **Tulving** — the episodic/semantic distinction, which is functional here, not
  taxonomic: the two stores differ in capacity, durability, and retrieval.
- **Ebbinghaus** — the forgetting curve, and the spacing effect that rehearsal
  lengthens the half-life.
- **Rescorla & Wagner** — learning driven by prediction error.
- **Friston** — predictive coding, which is why salience is surprise.
- **Newell, Laird & Rosenbloom; Laird's SOAR** — hierarchical task networks and
  the case for cognitive architecture as a discipline.
- **Anderson's ACT-R** — activation-based declarative memory.

---

## Reading the code

If you are reading this repository for the first time, the order that makes the
argument clearest is:

1. `src/kernel/types.ts` — the vocabulary everything else speaks.
2. `src/kernel/scheduler.ts` — the attention-as-scarcity decision.
3. `src/memory/working.ts` — the bottleneck, decay, and biased competition.
4. `src/perception/gate.ts` — why salience is surprise.
5. `src/cognition/agent.ts` — how it all composes.

Each file's header explains the design argument for that module, including what
was rejected and why.
