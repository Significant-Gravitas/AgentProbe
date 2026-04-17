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

## Server control plane

Scenarios for the `agentprobe start-server` long-running control plane
described in `docs/design-docs/agent-probe-server.md`. These are the binding
product contract for the Phase 1–4 implementation PRs and remain planned until
the implementing phase lands.

### Default start-server boot binds loopback with read-only history browsing

**Given** a working directory with `./data` suites, an optional `./runs.sqlite`
history file, and no exported `OPEN_ROUTER_API_KEY`
**When** the operator runs `agentprobe start-server` with no flags
**Then** the server binds `127.0.0.1:7878`, scans `./data` for suites, opens
`./runs.sqlite` (creating it if missing), serves the bundled dashboard, exposes
read-only history and suite discovery, and blocks the shell until `SIGINT` or
`SIGTERM` triggers graceful shutdown. `OPEN_ROUTER_API_KEY` is not required for
read-only history browsing.

### Non-loopback exposure requires unsafe flag, token, and CORS origins

**Given** a `--host` value outside the loopback range (`127.0.0.0/8` or `::1`)
**When** the operator runs `agentprobe start-server`
**Then** the server refuses to start unless both `--unsafe-expose` is supplied
and a non-empty token is provided via `--token` or `AGENTPROBE_SERVER_TOKEN`,
and an explicit comma-separated `AGENTPROBE_SERVER_CORS_ORIGINS` allow-list is
set. Missing or mismatched flags fail before the listener opens with an error
that names the unsafe setting and the missing requirement.

### API CORS allows only same-origin loopback by default

**Given** an `agentprobe start-server` instance serving `/api/*`
**When** a browser sends an API request or OPTIONS preflight with an `Origin`
header
**Then** loopback servers allow only the server's own loopback origin by
default, configured `AGENTPROBE_SERVER_CORS_ORIGINS` entries are echoed exactly
when matched, OPTIONS preflights from allowed origins return `204` with
allow-methods, allow-headers, allow-credentials, and max-age headers, and
unlisted preflight origins return `403`.

### Read-only HTTP and UI surfaces browse persisted run history

**Given** an `agentprobe start-server` instance pointed at a persisted
`runs.sqlite` populated by prior runs
**When** a client calls `/healthz`, `/readyz`, `/api/suites`,
`/api/suites/:id/scenarios`, `/api/scenarios`, `/api/runs`, `/api/runs/:runId`,
`/api/runs/:runId/scenarios/:ordinal`, `/api/runs/:runId/report.html`, or opens
the dashboard overview, run list, run detail, scenario drill-down, or presets
views
**Then** every surface assembles its response from on-disk suite YAMLs and the
persisted run history without starting a new evaluation and without requiring
`OPEN_ROUTER_API_KEY`, returning JSON for `/api/*` routes and rendered HTML or
plain text for report and health routes.

### Live run events stream through Server-Sent Events with replay support

**Given** a run that is executing inside an `agentprobe start-server` instance
**When** a client subscribes to `GET /api/runs/:runId/events`
**Then** the server responds with `text/event-stream` envelopes that mirror the
run's scenario-started, scenario-completed, summary, and finished progress
events, supports reconnect via `Last-Event-ID` from an in-memory replay buffer
for the most recent events, falls back to persisted run detail for events older
than the buffer, and always emits a terminal event before closing the stream.

### Run control starts validated ad-hoc or preset-backed runs

**Given** an `agentprobe start-server` instance with a resolvable `./data` root
**When** an operator sends `POST /api/runs` with either a `preset_id` reference
or an explicit `endpoint` plus `selection[]` body
**Then** the server schema-validates the body before entering the evaluation
domain, rejects missing `OPEN_ROUTER_API_KEY` with HTTP `400` and a structured
error envelope, persists a run row tagged with `trigger=server` (plus a frozen
`preset_snapshot_json` when launched from a preset), returns the new `runId`,
and redirects the dashboard to the live run detail view subscribed to the SSE
stream.

### Cancellation cooperatively stops a server-managed run

**Given** an in-flight run launched through `agentprobe start-server`
**When** the operator sends `POST /api/runs/:runId/cancel`
**Then** the run controller flips a cooperative cancellation token that is
checked between scenarios and before each scenario dispatch, the in-flight
scenario finishes to keep SQLite and transcript state consistent, the run
persists with status `cancelled` and a `cancelled_at` timestamp, and a terminal
`run.cancelled` SSE event is emitted before the stream closes.

### Presets save cross-file scenario selections for one-click rerun

**Given** an operator who wants to reuse a run configuration
**When** the operator saves a named preset capturing a scenario selection that
spans any number of files under `data/`, a fixed endpoint, personas, rubric,
parallel factor, repeat count, and dry-run preference, then later launches the
preset by name
**Then** the server resolves the preset to concrete `{file, scenario_id}` pairs
at launch time, stores a frozen `preset_snapshot_json` on every run produced
from the preset, and later edits or soft-deletions of the preset do not
retroactively change historical runs or the comparison semantics that read the
snapshot.

### Comparison workspace diffs 2 to 10 historical runs

**Given** at least two persisted runs, preferably launched from the same preset
**When** the operator requests `GET /api/comparisons?run_ids=a,b[,...]` or opens
the `/compare` workspace
**Then** the server returns a scenario-aligned payload with per-run pass/fail,
score delta, `status_change`, and summary buckets for improved, regressed, and
unchanged scenarios; scenarios missing from one side surface as `present_in`
entries rather than failing the request; and the request rejects any count
below 2 or above 10 run IDs with a structured validation error.

### Docker image boots safely with SQLite-on-volume persistence

**Given** the shipped AgentProbe container image and a host that publishes the
server port through `127.0.0.1`
**When** the operator runs the image with `AGENTPROBE_SERVER_TOKEN` set and a
SQLite database mounted at the default volume path
**Then** the default container `CMD` binds `0.0.0.0:7878` with `--unsafe-expose`
and the required token/CORS-origin settings so the in-server non-loopback rules
still hold, the config loader refuses to boot when
`AGENTPROBE_SERVER_TOKEN` or `AGENTPROBE_SERVER_CORS_ORIGINS` is missing, the
server persists runs to the mounted `runs.sqlite` by default, and the
write-enabled server rejects Postgres database URLs until Postgres run recording
ships. Postgres remains available for explicit migration work and historical
read/preset repository operations, but `agentprobe start-server` requires a
`sqlite:///` URL while `POST /api/runs` and related run write routes are
enabled.
