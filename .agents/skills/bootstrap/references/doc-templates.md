# Document Templates

Customize every template below using the project details gathered in Phase 1.
Replace all `{{placeholders}}` with real values. Never leave TODO placeholders
in the final output.

---

## AGENTS.md

Target: 100–140 lines. This is the entry point for any agent working in the repo.

```markdown
# {{PROJECT_NAME}}

{{one-line description}}

## Stack

- Frontend: {{frontend stack or "N/A"}}
- Backend: {{backend stack}}
- Database: {{database}}
- Package manager: {{package manager}}

## Repo map

```text
{{project_name}}/
├── {{relevant top-level dirs with one-line descriptions}}
├── docs/           # Deep docs — start with docs/README.md
├── scripts/        # All standard commands live here
├── e2e/            # Playwright smoke and baseline tests
└── .github/        # Workflows and PR template
```

## Docs

| What                    | Where                          |
|-------------------------|--------------------------------|
| Architecture            | `docs/ARCHITECTURE.md`         |
| Agent operating contract| `docs/HARNESS.md`              |
| Repo health             | `docs/QUALITY_SCORE.md`        |
| Product behavior spec   | `docs/behaviours/platform.md`  |
| Execution plans         | `docs/exec-plans/`             |

## Standard commands

```bash
# Validate repo structure and docs
./scripts/validate-repo.sh

# Fast feedback loop (run before every PR)
./scripts/fast-feedback.sh

# UI smoke tests (for frontend changes)
./scripts/ui-smoke.sh

# Start local dev stack
./scripts/harness/run-local.sh
```

## Rules

1. Run `./scripts/fast-feedback.sh` before opening a PR. If it fails, fix it.
2. Do not edit generated files in `docs/generated/` by hand — run the generator.
3. Keep this file under 140 lines. Put detail in `docs/`.
4. When behavior changes, update `docs/behaviours/platform.md` first.
5. Every PR must follow the PR template.
```

---

## docs/README.md

```markdown
# Docs Index

## Architecture and design
- [ARCHITECTURE.md](ARCHITECTURE.md) — Module boundaries and dependency direction
- [HARNESS.md](HARNESS.md) — Agent operating contract and merge policy

## Health
- [QUALITY_SCORE.md](QUALITY_SCORE.md) — Repo health summary and incident log

## Product behavior
- [behaviours/](behaviours/) — Canonical behavior specs
  - [platform.md](behaviours/platform.md) — Full behavior spec
  - [current-state.md](behaviours/current-state.md) — What's implemented now
  - [e2e-checklist.md](behaviours/e2e-checklist.md) — Test coverage checklist

## Execution plans
- [exec-plans/](exec-plans/) — Active and completed plans
  - [active/](exec-plans/active/) — In-progress work
  - [completed/](exec-plans/completed/) — Done

## Generated docs
- [generated/](generated/) — Auto-generated docs (do not edit by hand)

## Playbooks
- [playbooks/](playbooks/) — Operational playbooks
```

---

## docs/ARCHITECTURE.md

```markdown
# Architecture

## Overview

{{PROJECT_NAME}} is a {{app type}} built with {{stack summary}}.

## Module boundaries

{{Describe the main modules/packages/services and their responsibilities.
Use a simple dependency diagram if helpful:}}

```text
┌──────────┐     ┌──────────┐
│ Frontend │────▶│   API    │
└──────────┘     └────┬─────┘
                      │
                 ┌────▼─────┐
                 │ Database │
                 └──────────┘
```

## Dependency direction

- Frontend depends on API contracts (types/schemas).
- API depends on database models.
- Database layer has no upstream dependencies.
- Shared types live in {{shared types location}}.

## Key conventions

- {{List 2-3 architectural conventions specific to this project}}
```

---

## docs/HARNESS.md

```markdown
# Agent Harness Contract

## Commands agents must run

| When                          | Command                          |
|-------------------------------|----------------------------------|
| Before every PR               | `./scripts/fast-feedback.sh`     |
| After UI changes              | `./scripts/ui-smoke.sh`          |
| To validate repo structure    | `./scripts/validate-repo.sh`     |
| To start local stack          | `./scripts/harness/run-local.sh` |

## PR requirements

Every PR must:
- [ ] Pass `fast-feedback.sh`
- [ ] Include a filled-out PR template
- [ ] Update `docs/behaviours/platform.md` if behavior changed
- [ ] Include screenshots/video for user-facing changes
- [ ] Run `ui-smoke.sh` if touching frontend code

## Automerge eligibility

### Stage 1 (current)
- Green CI
- One independent agent review
- **Human merge required**

### Stage 2 (when repo is stable)
Automerge allowed for: docs, tests, low-risk UI, non-auth service code.

### Stage 3 (when smoke/baseline loop is proven)
Wider automerge with human override.

## Always human-reviewed

These paths never automerge:
- `**/migrations/**`
- `**/auth/**`
- `**/billing/**`
- `**/.env*`, `**/credentials*`, `**/secrets*`
- `.github/**`
- `AGENTS.md`
- `docs/HARNESS.md`

## Failure escalation

1. If `fast-feedback.sh` fails: fix before merging. No exceptions.
2. If `ui-smoke.sh` fails: investigate. Do not skip.
3. If nightly baseline breaks: an auto-PR is opened. Fix forward.
4. If generated docs are stale: refresh and commit.
```

---

## docs/QUALITY_SCORE.md

```markdown
# Quality Score

Last updated: {{today's date}}

## Health summary

| Area              | Status | Notes                     |
|-------------------|--------|---------------------------|
| CI                | 🟢     | All workflows passing     |
| Test coverage     | 🟡     | Smoke tests only          |
| Doc freshness     | 🟢     | Generated docs up to date |
| Baseline debt     | 🟢     | No baselined violations   |

## Incidents

_No incidents yet._

## Next cleanup targets

1. Expand smoke test coverage beyond basic renders
2. Add integration tests for core API endpoints
3. Fill out remaining behavior scenarios in platform.md
```

---

## docs/behaviours/README.md

```markdown
# Behaviour Specs

## Files

- **platform.md** — Canonical product behavior spec. This is the source of truth.
- **current-state.md** — Summary of what's currently implemented. Validated against platform.md.
- **e2e-checklist.md** — Test coverage checklist derived from platform.md.

## Rules

1. When behavior changes, update `platform.md` first.
2. `current-state.md` and `e2e-checklist.md` are summary views — they must be consistent with `platform.md`.
3. Do not maintain summary views by vibes. Run `./scripts/check-behaviour-docs.mjs` to validate.
```

---

## docs/behaviours/platform.md

```markdown
# {{PROJECT_NAME}} — Platform Behavior Spec

## Overview

{{Brief description of what the product does and who uses it.}}

## Scenarios

### {{Scenario 1 name}}

**Given** {{precondition}}
**When** {{action}}
**Then** {{expected outcome}}

### {{Scenario 2 name}}

**Given** {{precondition}}
**When** {{action}}
**Then** {{expected outcome}}

### {{Scenario 3 name}}

**Given** {{precondition}}
**When** {{action}}
**Then** {{expected outcome}}

---

_Add new scenarios here as the product grows. Each scenario should be concrete
and testable._
```

---

## docs/behaviours/current-state.md

```markdown
# Current State

Last validated against `platform.md`: {{today's date}}

## Implemented scenarios

- [ ] {{Scenario 1}} — not yet implemented
- [ ] {{Scenario 2}} — not yet implemented
- [ ] {{Scenario 3}} — not yet implemented

## Known gaps

_List features described in platform.md that are not yet built._
```

---

## docs/behaviours/e2e-checklist.md

```markdown
# E2E Test Checklist

Derived from `platform.md`. Each scenario should have at least one test.

| Scenario              | Test file                  | Status      |
|-----------------------|----------------------------|-------------|
| {{Scenario 1}}       | `e2e/smoke.behavior.spec.ts` | ⬜ not covered |
| {{Scenario 2}}       | —                          | ⬜ not covered |
| {{Scenario 3}}       | —                          | ⬜ not covered |
```

---

## docs/exec-plans/README.md

```markdown
# Execution Plans

Plans for multi-step work that spans multiple PRs or sessions.

## Active

_No active plans._

See [active/](active/) for in-progress plans.

## Completed

See [completed/](completed/) for finished plans.

## Plan format

Each plan should include:
1. Goal — what we're trying to achieve
2. Steps — ordered list of discrete tasks
3. Dependencies — what blocks what
4. Validation — how we know it's done
```
