<!--
  Thank you. A few things that make a pull request easy to review here.
-->

## What this changes

<!-- One or two sentences. What behaviour is different afterwards? -->

## Why

<!--
  The interesting part. If this fixes a defect, what was the wrong behaviour,
  and how did you find it? Several of this project's real bugs were found by
  measurement rather than by testing, and that distinction is worth recording.
-->

## Which layer

<!-- Kernel / Memory / Perception / Reasoning / Planning / Metacognition / Cognition / tooling -->

## How it was checked

<!--
  Every claim in this project is supposed to be checkable. What test would fail
  if this stopped working? If you changed behaviour that a doc comment
  describes, did the comment and the test stay in agreement?
-->

- [ ] `npm run verify` passes (type check, 497 tests, example)
- [ ] New behaviour is covered by a test that states the claim, not merely that a number changed
- [ ] Any doc comment this changes is still accurate

## Design notes

<!--
  Anything a reviewer would otherwise have to ask about: an alternative you
  rejected and why, a limit you chose not to work around, a tradeoff you are
  unsure about. Saying "I am not sure about this part" is welcome and more
  useful than leaving it for the reviewer to find.
-->

## Checklist

- [ ] No runtime dependency was added
- [ ] Determinism preserved — no `Math.random()`, no unseeded time, no reliance on object iteration order for anything that affects results
- [ ] If a limit is deliberate, it is documented (preferably as a test asserting the limit)
