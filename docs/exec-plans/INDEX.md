# exec-plans Index

## Purpose

Execution plans for multi-step work that spans multiple PRs or sessions.
These plans are durable coordination artifacts for agents, not temporary notes.
Active work lives in `active/`; shipped work is archived to `completed/`; debt
that is known but unscheduled stays in the tracker.

## File conventions

- Each plan is a Markdown file with sections: Goal, Steps, Dependencies,
  Validation.
- Name plans by workstream and date (e.g., `websocket-refactor-2026-04.md`).
- Move plans to `completed/` when all steps are done and shipped.
- Record meaningful design decisions in the plan instead of assuming chat
  context will survive.

## Files

- [README.md](README.md) — Execution plans index and format guide
- [tech-debt-tracker.md](tech-debt-tracker.md) — Shared queue of known cleanup work

## Subdirectories

- [active/INDEX.md](active/INDEX.md) — In-progress plans
- [completed/INDEX.md](completed/INDEX.md) — Archived completed plans

<!-- AUTO-GENERATED FILE LINKS START -->
- [README.md](README.md)
- [tech-debt-tracker.md](tech-debt-tracker.md)
<!-- AUTO-GENERATED FILE LINKS END -->

<!-- AUTO-GENERATED SUBDIR LINKS START -->
- [active/INDEX.md](active/INDEX.md)
- [completed/INDEX.md](completed/INDEX.md)
<!-- AUTO-GENERATED SUBDIR LINKS END -->
