# Plans

Execution plans are first-class repository artifacts, not side notes.

## How plans work

- Small changes can live in a short-lived task description or PR summary.
- Multi-step or multi-session work belongs in `docs/exec-plans/`.
- Plans must be decision-complete enough that another agent can resume work
  without re-deriving the approach.
- Technical debt that is real but not yet scheduled belongs in
  `docs/exec-plans/tech-debt-tracker.md`.

## Required plan content

- Goal and why it matters
- Key design decisions and constraints
- Ordered implementation steps
- Validation and evidence expected at completion
- Known dependencies, risks, or rollout notes

## Lifecycle

- New work starts in `docs/exec-plans/active/`.
- Shipped work moves to `docs/exec-plans/completed/`.
- Debt themes stay visible in the shared tracker until converted into an active
  plan or retired by cleanup work.

## Planning rule

If work will span multiple PRs, multiple agent sessions, or non-obvious design
tradeoffs, write or update a checked-in plan before the implementation drifts.
