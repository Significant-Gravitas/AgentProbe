# Execution Plans

Plans for multi-step work that spans multiple PRs or sessions. Treat them as
checked-in implementation memory that another agent can resume without needing
external context.

## Active

Active execution plans live in [active/](active/). Use them for work that has
non-trivial sequencing, tradeoffs, or validation requirements.

See [active/](active/) for in-progress plans.

## Completed

See [completed/](completed/) for finished plans and [tech-debt-tracker.md](tech-debt-tracker.md)
for known cleanup work that is not yet an active project.

## Plan format

Each plan should include:
1. Goal — what we're trying to achieve
2. Steps — ordered list of discrete tasks
3. Dependencies — what blocks what
4. Validation — how we know it's done
5. Decisions — any non-obvious choices future agents must preserve
