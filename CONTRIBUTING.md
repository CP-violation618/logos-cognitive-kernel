# Contributing to LOGOS

Thank you for considering it. This project has opinions, and they are stated
plainly so that a contribution can disagree with them deliberately rather than
accidentally.

## The two rules

**1. Zero runtime dependencies.** This is not a preference. The entire
architecture is auditable in an afternoon *because* there is nothing to audit
but the source. A pull request that adds a runtime dependency will be declined
regardless of merit — there is almost always a way to do it with what Node
provides, and if there genuinely is not, that is an interesting conversation to
have before writing the code.

Dev dependencies are a different matter. There are two, and both are for
checking rather than running.

**2. Every claim must be checkable.** The codebase is full of statements like
"salience is not intensity" and "evidence order must not matter". Each of those
is a claim, and a claim that nothing verifies is a claim that will quietly stop
being true. If you change behaviour that a doc comment describes, either keep
the comment honest or change the test that pins it — but do not leave the two
disagreeing.

## Getting started

```bash
git clone https://github.com/CP-violation618/logos-cognitive-kernel.git
cd logos-cognitive-kernel
npm install --include=dev
npm run verify
```

No build step. Node 22.18+ strips TypeScript types natively, so the source is the
artifact. `npm run verify` runs the type check, the tests, and the example.

> **If `npm install` says "up to date" and installs nothing**, your npm is
> configured with `omit=dev`. Use `npm install --include=dev`. This trips up
> roughly everyone once.

### Useful commands

```bash
npm test                       # 497 tests
npm run test:watch             # re-run on change
npm run typecheck              # strict, plus exactOptionalPropertyTypes
npm run demo                   # the worked scenario, narrated
npm run example                # a tour of every layer
node src/cli.ts repl           # drive a live agent
node src/cli.ts bench          # ~3100 cycles/second
```

## What a good contribution looks like

### Tests that state the claim

This project's tests are the argument, not the paperwork. Compare:

```ts
// Reports that a number changed. Says nothing about whether it should have.
test('attention adapts', () => {
  expect(gate.threshold).toBeGreaterThan(0);
});
```

```ts
// States the claim, and would fail if the claim stopped being true.
test('sustained memory pressure raises the bar', () => {
  // Working memory is the bottleneck, so it is memory pressure that makes a
  // gate selective. A large working memory has no pressure to respond to.
  ...
  assert.ok(
    gate.threshold > before,
    `a saturated gate must become selective: ${before} -> ${gate.threshold}`,
  );
});
```

The second kind is what the suite is made of. Assertions carry messages that
explain *why* the expectation is the expectation, so a failure tells you what
broke rather than merely that something did.

### Comments that explain why

The code says what it does. Comments say why it does *that* rather than the
obvious alternative, and what the alternative would have cost. If a line is
non-obvious, the comment should make it obvious; if a decision was made against
a plausible alternative, say which and why.

Negative results are welcome and often more valuable than positive ones:

```ts
// An aggressive stemmer is worse than none: folding "bridge" and "bridges" onto
// different stems DESTROYS a match that raw string comparison would have found.
```

### Documented limits

If something does not work, say so — preferably as a test. Several of the most
useful tests in this repository assert that something *fails*:

- priming is lexical, not semantic, so a synonym with no shared vocabulary gets
  no boost;
- synonyms with no token overlap do not merge into one concept;
- always saying 50% about a fair coin is perfectly calibrated and completely
  useless.

Pinning a limit down means that changing it later shows up as a deliberate
behavioural change rather than silent drift.

## Style

Enforced by `tsconfig.json` rather than by argument:

- `strict`, plus `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- `erasableSyntaxOnly` — no enums, no namespaces, no parameter properties,
  because Node's type stripping cannot handle them and the code must run
  directly from source
- `verbatimModuleSyntax` — `import type` for types
- Two-space indent, single quotes, semicolons, trailing commas
- Private fields with `#`, not `private`
- Named exports only; no default exports

There is no linter and no formatter configured. If you want one, that is a
legitimate pull request, but it should arrive with the formatting already
applied so the diff is readable.

## Adding a layer

Layers are numbered and strictly one-directional. Before adding one, check that
it genuinely cannot live in an existing layer — the layering is the design, and
a seventh layer that only exists because a sixth got large is worse than a
larger sixth.

If it does belong:

1. Put it in `src/<layer>/`, with an `index.ts` re-exporting the surface.
2. Export it from `src/index.ts` and add it to the `LAYERS` array — the array is
   checked by tooling, so it is not decoration.
3. Depend on layers *below* only. If you need something from above, the design
   is wrong; that circularity is what the bus exists to avoid.
4. Take `Clock`, `EventBus` and `Rng` by injection rather than importing
   globals. Determinism depends on it.
5. Write the header comment first. If the design argument cannot be stated in a
   paragraph, it is not ready to be written.

## Reporting a bug

Include the seed. Because everything is deterministic, a bug report with a seed
and an input sequence can be turned directly into a test case rather than
described and hoped for:

```bash
node src/cli.ts demo --seed 1234
```

If you can reproduce it without the CLI, a failing test is even better.

## Commit messages

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`)
with a scope naming the layer: `feat(memory):`, `fix(perception):`.

The body should explain *why*, not restate the diff. Commits in this repository
routinely record the defect that prompted the change and the reasoning that
ruled out the alternatives — because six months later, "what was I thinking"
is the only question that matters and the diff cannot answer it.

If a change fixes a real defect, say what the wrong behaviour was and how it
was found. Several of them were found by measurement rather than by testing,
and that distinction is worth preserving.

## Code of conduct

Be straightforward, be specific, and assume the other person is acting in good
faith. Critique the code, not the author. If a design decision looks wrong,
saying what it costs is more useful than saying it is wrong.
