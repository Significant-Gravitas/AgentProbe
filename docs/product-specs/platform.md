# AgentProbe Platform Spec

## Overview

AgentProbe is a CLI for validating suites, running repeatable agent evaluations,
recording run artifacts, and rendering reports from local run history.

## Scenarios

### YAML validation succeeds for well-formed data

**Given** a suite directory containing valid endpoint, scenario, persona, and
rubric YAML files
**When** the user runs the validation command against that suite
**Then** the CLI validates the YAML structure, reports which suite files were
processed, and fails fast if the suite contract is invalid

### Evaluation run records ordered results and artifacts

**Given** valid endpoint, scenario, persona, and rubric YAML files
**When** the user runs an evaluation suite
**Then** the CLI executes the selected scenarios, records structured run history
to SQLite, preserves scenario ordering, and emits a summary that agents and
humans can use to inspect pass/fail outcomes

### Scenario filters narrow execution to matching scenarios

**Given** valid endpoint, scenario, persona, and rubric YAML files that define
multiple scenarios and tags
**When** the user runs an evaluation suite with `--scenario` (or `--scenario-id`)
or `--tags`
**Then** the CLI runs only the matching scenarios, records the selected
scenario IDs in run history, and fails fast before any endpoint traffic when no
scenario matches the requested filters. The `--scenario` flag accepts one or
more comma-separated values that match by scenario ID or scenario name. When no
match is found, the error message lists all available scenario IDs and names.

### List command shows available scenarios

**Given** a scenario file or directory containing scenario YAML files
**When** the user runs the `list` command with `--scenarios`
**Then** the CLI prints each scenario's ID, name, and tags, and returns a
non-zero exit code when no scenarios match the optional `--tags` filter

### Dry-run mode records intent without contacting external systems

**Given** valid endpoint, scenario, persona, and rubric YAML files
**When** the user runs an evaluation suite with `--dry-run`
**Then** the CLI reports the selected scenarios as passing with placeholder
scores, records the run selection metadata, and skips endpoint traffic and
judge-model calls

### Judge requests preserve cache-friendly prompt prefixes

**Given** repeated evaluations that share the same rendered rubric context
**When** AgentProbe sends judge-model requests
**Then** the CLI keeps stable rubric instructions at the start of the request,
pushes transcript-specific content to the tail, and enables supported provider
prompt caching without changing the scoring contract

### Parallel mode overlaps scenario execution while preserving ordering

**Given** valid endpoint, scenario, persona, and rubric YAML files with more
than one selected scenario
**When** the user runs an evaluation suite with `--parallel` or
`--parallel <limit>`
**Then** the CLI overlaps scenario execution, emits progress for each selected
scenario, honors the requested concurrency cap when provided, and preserves the
original scenario ordering in summaries and stored run history

### Multi-session memory scenarios preserve pinned identity and session controls

**Given** a scenario that defines multiple sessions, fresh-agent resets,
session-level `max_turns`, and context fields such as `user_name` or
`copilot_mode`
**When** the user runs that scenario against an AutoGPT memory backend
**Then** the CLI keeps one stable user identity for the full scenario, applies
session-specific turn caps without aborting later sessions, and records session
boundary metadata that agents and reports can inspect

### AutoGPT preset forges auth tokens internally

**Given** an AutoGPT preset endpoint configured for AgentProbe
**When** the CLI prepares authenticated requests for that endpoint
**Then** the CLI forges the bearer token locally, registers the user with the
backend, extracts tool-call evidence from the backend SSE stream, and does not
depend on a Supabase signup flow

### Repeat mode reruns scenarios with isolated users per iteration

**Given** one or more matching scenarios and the `--repeat` option
**When** the user runs an evaluation suite with `--repeat N`
**Then** the CLI expands the run into N ordered iterations per scenario, keeps
each iteration memory-isolated with its own pinned user identity, and exposes
iteration-specific display IDs in progress output and dashboard state

### OpenClaw CLI commands manage sessions, chat, and history

**Given** an OpenClaw websocket endpoint configured for AgentProbe
**When** the user runs `openclaw create-session`, `openclaw chat`, or
`openclaw history`
**Then** the CLI establishes the gateway connection, returns structured JSON
for the requested operation, and preserves session-specific conversation
history across commands

### Fast feedback enforces the repo quality gates

**Given** the repository's standard pre-PR workflow
**When** the user runs the fast-feedback command
**Then** the CLI runs repo validation, Biome linting, strict `tsc --noEmit`,
and Bun tests, failing fast when any quality gate is broken

### HTML report renders from recorded run history

**Given** at least one completed run in the local run-history database
**When** the user renders a report for the latest run or an explicit run ID
**Then** the CLI writes an HTML report to an explicit output path or a
discovered default location, including transcript, score, run metadata, pinned
user IDs, and parsed session-boundary details for debugging and auditability

### Dashboard mode serves live run state from a Bun HTTP server

**Given** a built dashboard bundle and a suite run started with `--dashboard`
**When** the CLI begins executing scenarios
**Then** the CLI starts a Bun HTTP server that serves the copied dashboard app
and a live `/api/state` payload with progress events, per-run details, and
repeat-aware averages without failing the suite when the dashboard bundle is
missing

### Reliability signals exist for critical command paths

**Given** the validation, run, and report commands
**When** the CLI starts, validates a suite, performs endpoint work, persists
artifacts, or renders a report
**Then** structured logs, metrics, and spans exist so agents can diagnose
failures and verify response-time budgets on critical paths
