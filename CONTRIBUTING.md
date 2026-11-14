# Contributing

This repository is a production platform for Mashura's cabinet fleet. It is read by the people who support real
cabinets and by whoever inherits it next. The standard below exists so that reading this history — a commit, a diff, a
test — tells you an engineer built it.

**It applies to every change, whoever or whatever wrote it.** A change from a person, from an assistant, or from an
automated tool is held to exactly the same bar. There are no carve-outs, and "the tool wrote it" is not a reason to
lower anything.

## The one rule

Every change is reviewable on its own: its purpose is stated, its behaviour is pinned by a test, and the evidence that
it works is in the pull request. If a reviewer cannot tell why the code changed and how you know it works, the change
is not finished.

## Commits

- Conventional subject, and a scope that names the area: `fix(fleet-jobs): keep recovering unfinished jobs`.
- The body says what was wrong, what the change does, and what proves it. Past tense, plain sentences, no adjectives
  doing the work of evidence.
- One purpose per commit. If you reformat a function you did not otherwise change, that is a second commit and it is
  probably wrong.
- Never commit a secret, a token, a password, a connection string, or a real cabinet's data — not in a fixture, a
  comment, a test name or a log.

## Pull requests

- One item, one PR. The title mirrors the commit subject; the body carries the defect, the change, the evidence and
  what is deliberately out of scope.
- Contracts and migrations move with the code. A new operation ships with its schema in `contracts/schemas/operations/`
  and its migration, in the same PR.
- Never push to `main`. Branch, open the PR, and let the review happen on the PR.

## Tests are how you know

- The test ships with the change. A behaviour with no test is not done.
- A new test must fail without the fix. Prove it: disable the mechanism (a comparison pinned to `if (false)`, a guard
  removed — keep the file buildable), rebuild, watch the specific test go red, restore the file byte-identical
  (`cmp`), watch it go green. Put both runs in the PR.
- Never weaken or rewrite an existing assertion to make a change pass. If an existing test has to change to fit new
  behaviour, stop and say so — that is a finding, not plumbing.
- Assert behaviour and outcome, not prose or clocks. A test that pins an exact message from the operating system, or
  that passes by waiting a fixed duration, fails for reasons that have nothing to do with the code.
- Tests set up what they need and hold in any order. Reaching the new function through the module namespace keeps the
  red half buildable when the fix is reverted.

## Definition of done

- The local suite is green **at the head you are asking someone to merge**, with real numbers: tests, pass, fail,
  skipped. Posted in the PR, not summarised.
- Hosted checks on this repository carry no signal — the workflow never gets a runner on this plan. Red or absent CI is
  never a reason to hold a change and never evidence that one works. The local run at the reviewed head is the gate.
- A PR that carries open review findings does not merge. Findings are gates, not notes, and they close in writing —
  answered, or explicitly withdrawn with a reason.

## Style

- Match the code around you. The surrounding file decides naming, structure and comment density.
- No drive-by reformatting, no renames nobody asked for, no dead code left commented out, no `TODO` that names no
  owner and no behaviour.
- Comment the *why*: a surprising rule, a safety constraint, a decision that looks wrong until you know the reason.
  Never narrate what the next line plainly does.
- Errors say what happened and what to do next, in the vocabulary the operator already has. A message that describes
  state as it is not is a defect, not copy.

## Invariants — the rules that do not bend

These are safety properties of running cabinets. A change that weakens one, or a test that stops asserting one, is a
blocking finding:

- **The sync-cabinet rule.** A sync cabinet serves the satellites at its site. Disruptive work never runs against a
  sync cabinet and its satellites at the same time, regardless of the order they were chosen in.
- **One lifecycle owner per fleet job.** A job is acted on only while its lease is held. No second runner acts on it,
  and a change to the lease rules needs a test that proves exactly one owner can act.
- **Never issue a change twice.** A target that already has an outstanding command for a step never gets a second one.
  Every assertion about a command count is asserting this.
- **Writes are allowlisted, role-gated, confirmed and logged.** Read the catalog for an operation's `minimumRole` and
  `confirm` level before writing copy or a control that claims what it needs.
- **A misreport is a defect.** If the platform tells support that nothing was changed on a cabinet, that has to be
  true — including the possibility that a cabinet which was asleep wakes up and applies the change later.
- **No patient or prescription data**, ever, in any read, log, evidence bundle or test fixture.

## Where the truth lives

- `docs/spec/` is the source of truth for what the platform is meant to do. Its module table describes intent; the code
  and the migrations describe reality, and when they disagree, the code and the spec both need reading before you trust
  either.
- The operations catalogue is `contracts/schemas/operations/` — that, not a document, is the list of what exists.
- A roadmap column that says something is "to build" is planning text, never status. Check the code.
- **When your change moves behaviour the spec describes, the spec bullet moves in the same PR.** A sentence in
  `docs/spec/` that describes the old behaviour is a false statement in the authoritative document, and it is a finding
  against your PR — not a follow-up. Grep the spec for the mechanism you changed before you open the PR.
