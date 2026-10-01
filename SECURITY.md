# Security Policy

## Scope

LOGOS is a cognitive architecture research project. It runs in-process, holds
its state in memory, and has **no runtime dependencies** — which means the
supply-chain attack surface is the Node runtime and nothing else. There is no
network code, no file parsing of untrusted input, no authentication, and no
persistence layer in this version.

That narrows the realistic concerns considerably, but does not eliminate them.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/CP-violation618/logos-cognitive-kernel/security/advisories/new)
rather than a public issue.

Please include:

- what the issue is and what it affects;
- a minimal reproduction — and if you can, **the seed**, since the whole
  architecture is deterministic and a seeded reproduction can be turned into a
  regression test directly rather than described and hoped for;
- the version or commit you tested.

Expect an acknowledgement within a few days. This is a research project
maintained by volunteers, so please calibrate your expectations accordingly —
and if that is a problem for your use case, that is useful information to have
before you depend on it.

## What counts as a vulnerability here

The usual categories are mostly absent. The ones that are genuinely relevant:

### Unbounded resource consumption

A cognitive architecture is a system that is *supposed* to be bounded — the
scheduler exists precisely to put a hard ceiling on effort per tick. A crafted
input that causes unbounded growth in memory, an unbounded loop in planning, or
a scheduler task that never yields is a real defect. The bounds are documented
and tested; finding a way around them is a legitimate report.

Relevant invariants, all of which are enforced by tests:

- the scheduler never spends more than `budgetPerTick` in one tick;
- working memory never exceeds its configured capacity;
- episodic and semantic stores shed entries at their configured capacity;
- planner decomposition is bounded by both depth and node count;
- the belief store's revision log is bounded independently of its counter.

### Determinism breaks

The architecture claims that the same seed produces the same mental trajectory.
If two runs with the same seed diverge, that is a defect worth reporting — not
because divergence is dangerous, but because determinism is load-bearing for
every other guarantee. A system whose behaviour cannot be reproduced cannot be
analysed, and an unreproducible system is one whose failures can never be
explained.

CI checks this, but only for the demo scenario. Counterexamples elsewhere are
valuable.

### Denial of service through the event bus

The bus dispatches synchronously. A listener that publishes recursively, or a
subscription pattern that matches far more than intended, can amplify a single
event into unbounded work. `maxDispatchDepth` exists to make this diagnosable;
it does not prevent it. If you can construct a practical amplification from
plausible code, that is worth knowing about.

## What is out of scope

**Anything requiring `Math.random()`.** The architecture routes all randomness
through its own seeded generator. A report that depends on ambient randomness
is reporting on something this project does not do.

**Model output.** There is no model, no prompt, and no API key in this
codebase. Reports about what an LLM might say are about the LLM.

**Missing hardening for a threat model this does not have.** There is no
network listener, no user authentication, and no persisted untrusted data.
"An attacker who can already execute code in your process can do X" is true of
every library in every language and is not a vulnerability in this one.

**Dependency vulnerabilities.** There are no runtime dependencies. If you find
one, the badge in the README is wrong and that *is* worth reporting — loudly.

## Supported versions

The project is pre-1.0 and the API changes. Security fixes are applied to
`main` only; there are no maintained release branches yet.

| Version | Supported |
|---|---|
| `main` | ✅ |
| 0.1.x | ✅ best effort |

## A note on the honest position

This is a research architecture, not a hardened service. It has not been
through a security review, it has no threat model beyond the invariants above,
and it should not be put in a position where its failure is dangerous — which
is true of any system whose behaviour its authors are still working out.

If you are building something where that matters, the interesting question is
not whether LOGOS is secure but whether a cognitive architecture is the right
component for the job yet. It probably is not.
