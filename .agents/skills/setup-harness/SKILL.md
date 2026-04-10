---
name: setup-harness
description: >
  Bootstrap a new project repository for agent-first development.
  Use this skill whenever the user wants to set up a new repo, scaffold a project,
  create an agent-ready codebase, or mentions "bootstrap", "new project setup",
  "agent-first repo", "scaffold repo", or wants to structure a repo so that
  AI agents (Claude, Copilot, etc.) can work in it effectively from day one.
  Also trigger when the user asks to add AGENTS.md, harness scripts, or
  agent-friendly CI to an existing repo.
---

# New Project Bootstrap

You are setting up a repository so that AI agents can understand the project
quickly, use the same commands every time, validate their own work, and leave
behind enough evidence for a human to audit. The core principle: when an agent
struggles, the fix is adding structure to the repo — not telling the agent to
"try harder."

## How this skill works

This is an interactive, multi-phase skill. You will interview the user, then
scaffold files in stages so they can review as you go. Do not dump everything
at once.

---

## Phase 1: Interview

Before writing any files, gather the following from the user. Ask in a natural
conversational way — not as a numbered questionnaire.

**Required:**
- **Project name** — used for directory names, package.json, README title
- **One-line description** — what the product does
- **Tech stack** — frontend framework, backend language/framework, database
- **App type** — web app, API, CLI tool, library, monorepo, etc.
- **Repo location** — are we creating a new directory or working inside an existing repo?

**Good to know (ask if not obvious):**
- Does the project have a frontend that renders in a browser? (determines whether smoke tests and UI workflows are needed)
- Will there be a local dev server or integration stack to wrap? (determines harness runner needs)
- Any existing CI or deployment setup to preserve?
- Package manager preference (npm, pnpm, yarn, pip, go modules, cargo, etc.)

Once you have enough to proceed, confirm your understanding back to the user
before writing files.

---

## Phase 2: Core documentation scaffold

Create these files first. They are short and set the foundation for everything
else.

Read `references/doc-templates.md` for the content templates. Customize every
template using the project details from Phase 1 — never leave placeholder text
that says "TODO" or "fill this in."

Every directory under `docs/` must include an `INDEX.md`. Each index explains:
- what belongs in that directory
- what filename/content format files in that directory should follow
- links to every file in that directory
- links to each child directory's `INDEX.md`

`INDEX.md` files belong only in `docs/` and its subdirectories — not in
source code, scripts, config, or other top-level directories.

### File creation order

1. **`AGENTS.md`** — the router file. 100–140 lines max. Contains: what the
   product is, main stack, repo map, links to deeper docs, standard commands,
   and a few hard rules. This is NOT a manual — it points agents to the right
   doc for the right task.

2. **`CLAUDE.md`** — symlink to AGENTS.md. Run `ln -s AGENTS.md CLAUDE.md`.
   This ensures Claude Code reads the same router file without duplicating
   content. Add `CLAUDE.md` to the repo (git tracks symlinks).

3. **`README.md`** — standard project readme for humans.

4. **`docs/INDEX.md`** — docs directory contract and full file/subdirectory
   index.

5. **`docs/README.md`** — docs index. Tells agents where to look next.

6. **`docs/ARCHITECTURE.md`** — module boundaries and dependency direction.
   Short. Updated whenever structure changes.

7. **`docs/HARNESS.md`** — the operating contract: what commands to run, what
   every PR must include, what qualifies for automerge, what needs human
   review, how failures escalate.

8. **`docs/QUALITY_SCORE.md`** — repo health summary. Tracks incidents and
   points at the next cleanup targets.

9. **`docs/behaviours/INDEX.md`** — behavior docs directory contract and full
    file index.

10. **`docs/behaviours/README.md`** — index for behavior specs.

11. **`docs/behaviours/platform.md`** — canonical product behavior spec.
   Start with 2–3 concrete scenarios based on what the user described.

12. **`docs/behaviours/current-state.md`** — summary of what's implemented.

13. **`docs/behaviours/e2e-checklist.md`** — checklist derived from platform.md.

14. **`docs/exec-plans/INDEX.md`** — execution plans directory contract, file
    format expectations, and links to child directory indexes.

15. **`docs/exec-plans/README.md`** — index for execution plans, with
    `active/` and `completed/` subdirectories.

16. **`docs/exec-plans/active/INDEX.md`** — explains how active plans are named
    and structured.

17. **`docs/exec-plans/completed/INDEX.md`** — explains how completed plans are
    archived and linked back to shipped work.

18. **`docs/generated/INDEX.md`** — explains that generated docs are refreshed
    by script and should not be edited by hand.

19. **`docs/playbooks/INDEX.md`** — explains what operational playbooks belong
    here and the format they should use.

After creating these, pause and tell the user: "Core docs are scaffolded.
Want to review before I add scripts?"

---

## Phase 3: Scripts

Read `references/script-templates.md` for the implementation templates.
Adapt each script to the project's actual stack.

### Create in this order

1. **`scripts/validate-repo.sh`** — the single command that checks repo truth.
   Runs: markdown link checks, no-absolute-local-path checks, AGENTS.md drift
   checks, behavior snapshot consistency, generated-doc freshness, index
   coverage, and index freshness.

2. **`scripts/fast-feedback.sh`** — standard short loop for normal PRs.
   Runs: validate-repo, stack-specific static checks, frontend type/lint/build
   (if applicable), backend compile/test (if applicable). Must be deterministic.

3. **`scripts/ui-smoke.sh`** — only if the project has a browser frontend.
   Runs a small tagged Playwright suite. Always leaves artifacts behind.

4. **`scripts/harness/run-local.sh`** — only if the project has a local dev
   stack. Worktree-aware: derives ports from worktree name, derives isolated
   data dir, boots dependencies, writes a manifest with ports/URLs/logs/artifacts.

5. **`scripts/generate-workspace-docs.mjs`** — generates a workspace inventory
   so the repo map can be checked mechanically.

6. **`scripts/generate-index-docs.mjs`** — refreshes `INDEX.md` files under
   `docs/` so links to files and child directory indexes stay current.

7. **`scripts/check-index-docs.mjs`** — fails if any directory under `docs/`
   is missing an `INDEX.md`, or if any index is stale, missing file links, or
   missing child-directory index links.

8. **`scripts/refresh-quality-score.mjs`** — regenerates quality summary from
   current repo state.

9. **`scripts/check-doc-links.mjs`** — validates markdown links in docs/ and
   all `INDEX.md` files.

10. **`scripts/check-agents-drift.mjs`** — checks that AGENTS.md repo map
   matches actual directory structure.

11. **`scripts/check-behaviour-docs.mjs`** — validates that current-state.md
    and e2e-checklist.md are consistent with platform.md.

12. **`scripts/check-generated-docs.sh`** — CI gate: fails if generated docs
    are stale.

13. **`scripts/validate-setup.sh`** — verifies the bootstrap itself is complete.
    Checks that all expected docs, scripts, workflows, and directories exist.
    Copy this from the skill's bundled `scripts/validate-setup.sh`. It accepts
    `--has-frontend` and `--has-harness` flags to adjust expectations.

Make all `.sh` files executable. Make `.mjs` files work with `node --experimental-vm-modules`
or plain Node depending on what the project uses.

After creating scripts, pause: "Scripts are in place. Want to review before
I set up CI and the first test?"

---

## Phase 4: First smoke test

Only if the project has a browser frontend.

Create `e2e/smoke.behavior.spec.ts` with a small Playwright test suite tagged
`@smoke`. Read `references/test-templates.md` for the template.

A good first suite checks:
- The login/signup screen renders
- An authenticated user can reach the main dashboard
- A core work-queue or listing page renders

If the project doesn't have a frontend, create an equivalent backend smoke
test in the project's test framework.

Also add Playwright config (`playwright.config.ts`) if not already present,
and install Playwright as a dev dependency.

---

## Phase 5: GitHub workflows and PR template

Read `references/workflow-templates.md` for the workflow YAML templates.

### Create these files

1. **`.github/pull_request_template.md`** — requires: intent summary, what
   behavior changed, what validation ran, screenshots for UI changes.

2. **`.github/workflows/pr-fast.yml`** — runs `scripts/fast-feedback.sh` on
   every PR.

3. **`.github/workflows/pr-ui-smoke.yml`** — runs smoke suite on UI-relevant
   changes, uploads artifacts. Only if project has a frontend.

4. **`.github/workflows/nightly-baseline.yml`** — runs fuller browser baseline
   nightly, opens a fix-forward PR if main breaks.

5. **`.github/workflows/weekly-doc-gardening.yml`** — refreshes generated docs
   and opens a maintenance PR when needed.

6. **`.github/workflows/automerge.yml`** — staged automerge. Start conservative.

### Automerge stages

Configure **Stage 1** (the most conservative):
- Green CI required
- One independent agent review
- Human merge required

Include comments in the automerge workflow explaining Stage 2 (automerge
docs/tests/low-risk UI) and Stage 3 (wider automerge) so the team can
graduate later.

### Always human-reviewed paths

These paths must never automerge at Stage 1:
- migrations, auth, billing, credentials
- desktop runtime code
- workflow and merge-policy files (`.github/`)
- `AGENTS.md`, `docs/HARNESS.md`

---

## Phase 6: Handle existing debt (if applicable)

If this is an existing repo with violations:
- Run the validation scripts
- Baseline any existing violations into a `.baseline` file
- Commit the baseline
- Configure CI to fail only on regressions, not the baseline
- Tell the user: "There are N existing violations baselined. Burn these down
  over time."

---

## Phase 7: Validate and wrap up

After all phases complete:

1. **Run the setup validation script** to confirm the bootstrap is complete.
   The script is bundled with this skill at `scripts/validate-setup.sh`.
   Copy it into the repo as `scripts/validate-setup.sh` (if not already done
   in Phase 3), make it executable, then run it:

   ```bash
   ./scripts/validate-setup.sh --has-frontend --has-harness
   ```

   Omit `--has-frontend` if there is no browser frontend. Omit `--has-harness`
   if there is no local dev stack. The script checks every expected document,
   script, workflow, and directory — any missing items are reported as failures.
   Fix anything it flags before continuing.

2. Run `node scripts/generate-index-docs.mjs` so all indexes are normalized
   before validation.
3. Run `scripts/validate-repo.sh` to verify doc links, drift checks, index
   freshness, etc.
4. Run `scripts/fast-feedback.sh` to confirm the feedback loop works.
5. Summarize what was created, linking to each key file.
6. Suggest the Day 0 → Week 1 sequence from the reference docs for next steps.

Tell the user: "The repo is bootstrapped. A new agent can now read AGENTS.md
and find everything it needs."

---

## Important principles to follow

- **AGENTS.md is a router, not a manual.** Keep it short. Point to docs/.
- **Scripts are the source of truth for commands.** Agents run scripts, not
  ad-hoc command chains.
- **Docs can fail CI.** Generated docs have freshness checks. Links are
  validated. Drift is caught.
- **Start conservative on automerge.** Widen only after the repo proves stable.
- **If an agent keeps making the same mistake, fix the repo** — add a script,
  a check, or a doc. Do not rely on chat-based corrections.
- **Boring technology wins.** Shell scripts, standard CI, markdown docs.
  Nothing exotic.
- **Every PR must be auditable.** PR template, validation evidence, artifacts.

---

## Reference files

Read these as needed — they contain the actual templates:

- `references/doc-templates.md` — Templates for AGENTS.md, docs/README.md,
  ARCHITECTURE.md, HARNESS.md, QUALITY_SCORE.md, and behavior docs
- `references/script-templates.md` — Templates for all scripts in scripts/
- `references/workflow-templates.md` — Templates for GitHub workflows and
  PR template
- `references/test-templates.md` — Templates for smoke tests
