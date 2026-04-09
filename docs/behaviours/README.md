# Behaviour Specs

## Files

- **platform.md** — Canonical product behavior spec. This is the source of truth.
- **current-state.md** — Summary of what's currently implemented. Validated against platform.md.
- **e2e-checklist.md** — Test coverage checklist derived from platform.md.

## Rules

1. When behavior changes, update `platform.md` first.
2. `current-state.md` and `e2e-checklist.md` are summary views — they must be consistent with `platform.md`.
3. Do not maintain summary views by vibes. Run `./scripts/check-behaviour-docs.py` to validate.
