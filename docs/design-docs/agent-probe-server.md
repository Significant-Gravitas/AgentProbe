# AgentProbe Server Design

Durable design for turning AgentProbe's single-run `--dashboard` into a
long-running, Dockerable control plane: `agentprobe start-server`.

Linear: [SYM-18](https://linear.app/autogpt/issue/SYM-18/agent-probe-server-design)

## 1. Goals

1. One command (`agentprobe start-server`) starts a long-lived HTTP server
   that hosts a UI and an API for controlling and inspecting AgentProbe
   evaluation runs.
2. The server is Dockerable. Default container persistence is SQLite on a
   mounted volume; when that volume is absent (ephemeral container) an
   operator can point the server at an external Postgres instance so run
   history survives container restarts. Suite YAMLs mount in,
   `OPEN_ROUTER_API_KEY` flows in through the environment.
3. The UI lets operators start runs, watch live progress, and browse a
   history of past runs and transcripts without dropping to the shell. The
   UI borrows design **direction** from
   [tolitius/cupel](https://github.com/tolitius/cupel) — palette,
   typographic density, filterable list + drill-down split layout — rather
   than copying it. Concretely that means: a compact dark theme; a
   filterable run list; drill-down detail panes; and live SSE updates.
4. The UI lets operators build a run as a **preset**: a named selection of
   scenarios chosen across any number of scenario files in `data/`, plus a
   fixed endpoint, personas, rubric, parallel factor, and repeat count. A
   preset is saved once and re-run by name. Each run is tagged with its
   originating preset so later runs of the same preset can be compared
   side-by-side.
5. Historical runs stay browsable: transcripts, judge scores, tool calls,
   checkpoints, and render of the existing HTML report — without re-running
   evaluations. Preset runs get a dedicated comparison view that diffs
   pass/fail, score deltas, and per-scenario outcome changes across two or
   more past executions.
6. The design preserves AgentProbe's layered architecture and repo contract:
   new server code lands in `src/runtime/server/`, reuses existing
   `domains/evaluation` and `domains/reporting`, and never leaks transport
   into higher layers.

## 2. Non-goals

- Multi-tenant auth, SSO, or RBAC. Out of scope for v1. The server targets
  a single operator running on their own machine or an internal VM.
- Distributed run orchestration across workers. Runs still execute in-process
  on the host that runs the server. Concurrency is bounded by the existing
  `--parallel` semantics; the parallel factor is selectable per run from the
  UI start form (see §7.6).
- Hosted, internet-facing deployments. The server binds by default to
  `127.0.0.1` and requires explicit opt-in to listen externally.
- Replacing the CLI. `agentprobe run`, `validate`, `list`, and `report` keep
  working identically. `start-server` is a new surface, not a rewrite.
- Replacing the single-run `--dashboard` flag. Single-run dashboard remains
  the quick, self-contained option; `start-server` is the long-running
  control plane.

## 3. Current state

AgentProbe already ships most of the building blocks:

- `src/domains/reporting/dashboard.ts` runs a `Bun.serve` HTTP server that
  serves the pre-built React dashboard (`dashboard/dist/`) and a
  `/api/state` JSON endpoint. It is scoped to a single in-flight run and
  stops when the run finishes.
- `dashboard/` is a Vite + React 19 + TypeScript app with components for
  scenario tables, stats bars, detail panels, conversation views, rubric
  views, and averages tables. It reads state via a polling `useDashboard`
  hook.
- `src/providers/persistence/sqlite-run-history.ts` and
  `src/domains/reporting/render-report.ts` already own run persistence and
  HTML rendering.
- `src/cli/main.ts` dispatches commands and wires `--dashboard` into the
  run flow at `main.ts:338-356`.

The server design reuses these pieces rather than inventing parallels.

## 4. System shape

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                        agentprobe start-server                          │
│                                                                         │
│   Browser / curl ──► Bun HTTP+WS ──► AppServer ──► RunController        │
│                            │               │               │            │
│                            │               │               └─► runSuite │
│                            │               │                    (evaluation)
│                            │               ├─► RunHistoryRepo           │
│                            │               │      (sqlite-run-history)  │
│                            │               ├─► SuiteRepo                │
│                            │               │      (YAML suites on disk) │
│                            │               └─► ReportRenderer           │
│                            │                      (render-report)       │
│                            │                                            │
│                            └─► Static dashboard bundle (dashboard/dist) │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Layers

New code lands under `src/runtime/server/` so it sits at the runtime layer
as defined by `docs/ARCHITECTURE.md`:

```text
src/runtime/server/
  app-server.ts         # Bun.serve entrypoint; routes, shutdown, CORS gate
  routes/
    runs.ts             # REST handlers: list, get, start, cancel
    suites.ts           # REST handlers: list suites, scenarios, personas, rubrics
    presets.ts          # REST handlers: CRUD presets + launch from preset
    comparisons.ts      # REST handlers: diff two or more runs (same preset)
    reports.ts          # HTML report proxy: render + stream
    health.ts           # /healthz, /readyz
    static.ts           # dashboard/dist serving with safeStaticPath
  streams/
    events.ts           # SSE fan-out for /api/runs/:id/events
    hub.ts              # In-process pub/sub with per-run subjects
  controllers/
    run-controller.ts   # Starts, tracks, and cancels runs; owns worker slots
    suite-controller.ts # Enumerates suites from the configured data dir
    preset-controller.ts # Persists presets; resolves scenario selection lists
    comparison-controller.ts # Aggregates historical runs for diffing
  auth/
    token.ts            # Optional shared-secret bearer check
  config.ts             # Loads AGENTPROBE_SERVER_* env into a validated struct
```

`controllers/run-controller.ts` is the only place that imports
`domains/evaluation`. REST and SSE layers only call into controllers. This
keeps transport out of business logic, per ARCHITECTURE rule 3.

### 4.2 Dependency direction

```
cli ─► runtime/server/app-server ─► controllers ─► services ─► sdk/providers
                                  └─► repositories (sqlite, suite files)
```

No domain code reaches back into `runtime/server`. The server is the
outermost shell.

## 5. CLI surface

New command: `agentprobe start-server`.

```text
agentprobe start-server \
  [--host 127.0.0.1]          # bind address; 0.0.0.0 requires --unsafe-expose
  [--port 7878]               # bind port; 0 picks an ephemeral port
  [--data ./data]             # suite root mounted into the server
  [--db ./runs.sqlite]        # SQLite path; ignored when AGENTPROBE_DB_URL is set
  [--dashboard-dist ./dashboard/dist] # override bundle location (Docker)
  [--token <shared secret>]   # enable bearer auth on /api/*
  [--unsafe-expose]           # required to bind any non-loopback host
  [--open]                    # open the browser after boot
  [--log-format json|pretty]  # defaults to json in Docker, pretty on TTY
```

Behavioral rules:

1. With no flags, the server binds `127.0.0.1:7878`, reads `./data`, writes
   run history to `./runs.sqlite`, and serves the bundled dashboard.
2. `--host` values outside the loopback range (`127.0.0.0/8`, `::1`) require
   `--unsafe-expose` _and_ a non-empty `--token`. This is enforced at boot
   in `runtime/server/config.ts`. Mismatched flags fail fast with a clear
   message.
3. `OPEN_ROUTER_API_KEY` must be present before any run starts. The server
   itself boots without it, but the `/api/runs` POST handler rejects with
   `400` until the key is supplied. This keeps read-only history browsing
   usable even when the key is missing.
4. `start-server` blocks the shell. `SIGINT`/`SIGTERM` trigger graceful
   shutdown: active runs are cancelled (see §6.4), SSE clients are sent a
   terminal event, and the server closes its listener before exiting.
5. Existing `--dashboard` flag on `agentprobe run` is unchanged. The code
   paths share `LiveDashboardState` and `startDashboardServer` internals but
   the server wraps them with durable lifecycle and repo-level concerns.

## 6. HTTP API

All JSON responses are `application/json; charset=utf-8`. All bodies follow
the same error envelope on non-2xx responses:

```json
{ "error": { "code": "string", "message": "string", "details": {} } }
```

### 6.1 Read endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness; returns 200 with build info |
| `GET` | `/readyz` | Readiness; returns 200 once the DB opened and the suite root resolved |
| `GET` | `/api/suites` | List suites discovered under `--data`, with scenario/persona/rubric counts |
| `GET` | `/api/suites/:id/scenarios` | List scenarios in a suite, including tags and repeat-friendly IDs |
| `GET` | `/api/scenarios` | Flat index of every scenario across every file under `--data`, with `{suite_id, file, id, tags, personas, rubric_ref}`. Used by the start form to build cross-file selections. |
| `GET` | `/api/runs` | List runs with pagination (`?limit=&cursor=`), filters (`?status=&suite=&preset=&since=`), and summary fields |
| `GET` | `/api/runs/:runId` | Full run record: scenario list, averages, judge metadata, preset ref |
| `GET` | `/api/runs/:runId/scenarios/:ordinal` | Single scenario detail: transcript, tool calls, checkpoints, judge output |
| `GET` | `/api/runs/:runId/events` | Server-Sent Events stream for live progress (see §6.3) |
| `GET` | `/api/runs/:runId/report.html` | HTML report rendered from persisted run history |
| `GET` | `/api/runs/:runId/artifacts/:name` | Raw artifact download (transcript JSON, judge JSON) |
| `GET` | `/api/presets` | List saved presets with last-run summary |
| `GET` | `/api/presets/:presetId` | Preset definition: resolved scenario selection, endpoint, personas, rubric, parallel factor, repeat |
| `GET` | `/api/presets/:presetId/runs` | Chronological list of runs launched from this preset |
| `GET` | `/api/comparisons` | Compare two or more runs by `?run_ids=a,b,c`. Returns scenario-aligned pass/fail, score delta, and judge-reason diffs (see §6.5) |

### 6.2 Write endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/runs` | Start a run from an ad-hoc spec (suite + filters) or a saved preset |
| `POST` | `/api/runs/:runId/cancel` | Signal an active run to stop after the current scenario |
| `POST` | `/api/presets` | Create a preset (scenario selection, endpoint, personas, rubric, parallel, repeat) |
| `PUT` | `/api/presets/:presetId` | Update a preset; older runs keep their frozen snapshot (see §8.2) |
| `DELETE` | `/api/presets/:presetId` | Soft-delete a preset; past runs remain browsable and comparable |
| `POST` | `/api/presets/:presetId/runs` | Launch a new run from a saved preset (optional `label`, `overrides`) |

`POST /api/runs` body:

```json
{
  "preset_id": "nightly-memory",
  "label": "nightly-baseline-2026-04-17",
  "overrides": {
    "parallel": { "enabled": true, "limit": 4 },
    "repeat": 3,
    "dry_run": false
  }
}
```

or, when launching ad-hoc (no preset), explicit selection:

```json
{
  "endpoint": "data/endpoints/autogpt.yaml",
  "selection": [
    { "file": "data/scenarios/baseline/memory.yaml", "id": "multi_session_memory" },
    { "file": "data/scenarios/regression/auth.yaml", "id": "signin_happy_path" }
  ],
  "personas": "data/personas/baseline.yaml",
  "rubric": "data/rubric.yaml",
  "parallel": { "enabled": true, "limit": 3 },
  "repeat": 5,
  "dry_run": false,
  "label": "exploratory-2026-04-17",
  "save_as_preset": { "name": "memory+auth-smoke", "description": "..." }
}
```

The handler validates the body with a schema before calling into the run
controller. `selection[]` accepts any mix of scenarios from any file
beneath `--data`; the controller resolves each `{file, id}` pair through
the existing scenario loader. `save_as_preset` is optional — operators
can freeze today's ad-hoc selection as a named preset in the same request.

### 6.5 Comparison payload

`GET /api/comparisons?run_ids=runA,runB,runC` (2–10 run IDs, same preset
recommended but not required) returns:

```json
{
  "runs": [
    { "run_id": "runA", "label": "2026-04-12", "started_at": "...", "pass_rate": 0.9, "score_mean": 0.81 },
    { "run_id": "runB", "label": "2026-04-17", "started_at": "...", "pass_rate": 0.7, "score_mean": 0.74 }
  ],
  "scenarios": [
    {
      "scenario_id": "multi_session_memory",
      "per_run": [
        { "run_id": "runA", "status": "pass", "score": 0.88, "judge_reason": "..." },
        { "run_id": "runB", "status": "fail", "score": 0.42, "judge_reason": "..." }
      ],
      "delta_score": -0.46,
      "status_change": "regressed"
    }
  ],
  "summary": {
    "regressed": ["multi_session_memory"],
    "improved": [],
    "unchanged": ["signin_happy_path"]
  }
}
```

Alignment is by `scenario_id` within the same preset. Runs without a
shared preset still compare by scenario ID, but missing scenarios show up
as `"present_in": ["runA"]` entries rather than failing the request.

### 6.3 Live events

`GET /api/runs/:runId/events` returns a `text/event-stream`. Events are
framed as:

```
event: run.scenario_started
data: {"ordinal": 2, "scenario_id": "multi_session_memory", ...}

event: run.scenario_completed
data: {"ordinal": 2, "status": "pass", "score": 0.82, ...}

event: run.summary
data: {"passed": 9, "failed": 1, "elapsed": 123.4}

event: run.finished
data: {"exit_code": 0}
```

Event types map 1:1 onto the existing `RunProgressEvent` kinds emitted by
`runSuite`'s `progressCallback`. A small adapter in `streams/events.ts`
normalizes them to envelope shape `{ "kind": "...", "payload": {...} }`.
Clients reconnect with `Last-Event-ID` to resume; the hub keeps the last
256 events per run in memory to replay on reconnect. Older history comes
from the DB via `/api/runs/:runId`.

### 6.4 Cancellation

`POST /api/runs/:runId/cancel` is cooperative: it flips a cancellation
token. The run controller checks the token between scenarios and before
each scenario dispatch. Cancelled runs persist with status `cancelled` and
emit a `run.cancelled` event. In-flight endpoint traffic is _not_ aborted
mid-stream — scenarios run to completion before cancellation takes effect,
to keep SQLite and transcript state consistent.

## 7. UI design

### 7.1 Stack and shape

- React 19 + Vite (same as `dashboard/`), served from
  `dashboard/dist/server/` in Docker and fallback to file system in dev.
- No new state-manager dependency. Colocated state + a small Zustand store
  only if the run detail view proves it necessary under profile, per
  `docs/design-docs/frontend-react.md`.
- Data fetching via `fetch` + SSE. No React Query unless a clear win emerges
  from three or more consumer sites.
- Visual grammar takes **design direction** from cupel rather than
  replicating it: dark-first palette with accent color on status chips,
  dense monospace-leaning typography for run/scenario tables, filterable
  list-plus-detail split layouts, and keyboard-driven navigation. Copy
  is the AgentProbe vocabulary (runs, scenarios, personas, rubrics).

### 7.2 Route map

| Path | View |
|---|---|
| `/` | Overview: active runs, last N completed, aggregate pass rate |
| `/runs` | Run list with filters (status, suite, preset, label, date range) |
| `/runs/:runId` | Live run detail: scenario table, stats bar, averages, SSE-driven updates, report link |
| `/runs/:runId/scenarios/:ordinal` | Scenario drill-down: transcript, tool calls, checkpoints, rubric scores |
| `/suites` | Discovered suites, flat scenario index, preset picker |
| `/start` | Run builder: multi-file scenario picker, parallel/repeat knobs, save-as-preset (see §7.6) |
| `/presets` | Saved presets list with last-run summary, "run again" and "edit" affordances |
| `/presets/:presetId` | Preset detail: resolved scenarios, endpoint/personas/rubric, run history timeline |
| `/compare` | Comparison workspace: pick 2–N past runs (optionally scoped to a preset) and diff (see §7.7) |
| `/settings` | Shows current server config (read-only); redacts secrets |

### 7.3 Overview page

Three panels, top to bottom:

1. **Header stats** — total runs, pass rate, failure mix (agent vs harness),
   average score, last-7-day trend sparkline. Pulled from `/api/runs?since=`
   with a single request.
2. **Active runs** — one card per live run, showing scenario progress,
   ETA, and a link into the live detail page. Driven by an SSE multiplexer
   that fans `/api/runs/:id/events` streams together.
3. **Recent runs** — paginated list, columns: label, suite, started, score,
   pass/fail, duration, link. Clicking opens the detail page.

### 7.4 Run detail

- Left: scenario list reusing `ScenarioTable` with status chips.
- Top-right: `StatsBar` and `ProgressBar`, fed by the SSE snapshot.
- Middle-right: averages (`AveragesTable`) when repeat is enabled.
- Bottom-right: log feed showing the last N SSE events with timestamps,
  expandable per event for raw JSON.
- Header: run label, suite name, command equivalent ("this is what you'd
  type on the CLI") for reproducibility, and "cancel" + "open report"
  buttons.

### 7.5 Scenario drill-down

Reuses `DetailPanel`, `ConversationView`, `RubricView` as modals or
dedicated routes. Supports deep links (`/runs/:runId/scenarios/:ordinal`)
so operators can share a URL to a specific transcript. New additions:

- Copy-as-cURL for each endpoint turn, for replay outside AgentProbe.
- "Download artifacts" button that hits `/api/runs/:runId/artifacts/...`.

### 7.6 Start run builder

`/start` is the canonical entrypoint for launching a run. Form layout,
top to bottom:

1. **Preset slot.** Dropdown of saved presets plus "new (ad-hoc)". Picking
   an existing preset hydrates the rest of the form; edits can either
   overwrite the preset (`Save`), fork it (`Save as…`), or stay as a
   one-off (`Run once`).
2. **Scenario selector.** A searchable, virtualized tree over
   `/api/scenarios`. Grouped by file with a flat "All scenarios" tab.
   Each row is a checkbox; tag and text filters narrow the tree; "select
   all visible" adds everything currently in view. The selection persists
   across group toggles and is shown as a chips row above the tree. The
   same row accepts free-text tag filters (`tags:memory status:regression`)
   that expand into concrete scenario IDs at submit time — but the
   submitted preset stores the *resolved* IDs, not the filter text, so
   re-runs stay deterministic even if new scenarios get added to `data/`
   later.
3. **Endpoint / personas / rubric.** Three selects fed by the suite
   controller. Endpoint is required; the others default to suite
   conventions.
4. **Execution knobs.**
   - Parallel factor: a stepper `1..N` (default `1`); the server caps `N`
     at the config ceiling. Shown alongside a live "estimated wall clock"
     based on the prior run's per-scenario timing when available.
   - Repeat: stepper `1..20` (default `1`).
   - Dry-run toggle.
   - Label (free-text, optional).
5. **Save as preset.** Toggle plus name/description fields. When enabled,
   the run submit also calls `POST /api/presets` in the same request so
   the operator's one-click rerun exists immediately.

Submitting sends a single `POST /api/runs` (with either `preset_id` or an
explicit `selection[]`). The UI then navigates to `/runs/:runId` and
subscribes to the SSE stream.

### 7.7 Comparison workspace

`/compare` supports two flows:

- **From a preset.** Opens `/presets/:presetId` and selects "Compare
  runs"; the picker pre-filters to that preset's run history and defaults
  to the two most-recent runs.
- **Ad-hoc.** From `/runs`, select any 2–10 runs via checkboxes, click
  "Compare selected".

The layout is a scenario-aligned table: one column per run (ordered left
→ right by `started_at`), one row per scenario. Each cell renders
`status + score + judge-reason snippet` with a hover that expands to the
full judge output. A sticky summary row at the top shows per-run pass
rate, score mean, and elapsed time. Regression rows are tinted; improved
rows get an up-arrow accent; unchanged rows are dim. A toggle switches
to "only changes" so an operator can see just the deltas.

Deep links preserve state: `/compare?run_ids=runA,runB,runC&only=changes`.

### 7.8 Accessibility & theming

- Keyboard navigation: `j`/`k` through the run list, `g r` to go to runs,
  `/` to focus search. Parity with cupel's keyboard affordances.
- Dark theme default; respects `prefers-color-scheme`.
- All panels render without JS for the health/readyz pages only (server-
  rendered plain HTML) so Docker healthchecks stay trivial.

## 8. Data model

### 8.1 Run record extensions

The server reuses the existing `sqlite-run-history` tables. New fields:

- `runs.label TEXT NULL` — optional human-friendly tag supplied at start.
- `runs.trigger TEXT NOT NULL DEFAULT 'cli'` — one of `cli|server|api`, so
  operators can filter server-initiated runs.
- `runs.cancelled_at DATETIME NULL` — stamped when cancellation completes.
- `runs.preset_id TEXT NULL` — foreign key into `presets(id)`; `NULL` for
  ad-hoc runs.
- `runs.preset_snapshot_json TEXT NULL` — the preset as it existed when the
  run started, so edits to the preset later don't retroactively rewrite
  historical runs. This is what the comparison view reads from.

### 8.2 Presets

Two new tables:

```sql
CREATE TABLE presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  endpoint TEXT NOT NULL,
  personas TEXT,
  rubric TEXT,
  parallel_enabled INTEGER NOT NULL DEFAULT 0,
  parallel_limit INTEGER NOT NULL DEFAULT 1,
  repeat INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  deleted_at DATETIME NULL
);

CREATE TABLE preset_scenarios (
  preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (preset_id, file, scenario_id)
);
```

Deletion is soft (`deleted_at`) so historical runs keep a readable preset
reference. The preset snapshot stored on each run is the source of truth
for replay and comparison semantics.

### 8.3 Persistence backends

The repo contract keeps SQLite as the default. A Postgres backend is a
**later-phase** addition for Docker deployments where the container's
volume is ephemeral:

- `AGENTPROBE_DB_URL` selects the backend. Accepted schemes: `sqlite://`
  (default when the env var is absent; path resolves like today's `--db`
  flag) and `postgres://`.
- The persistence layer already sits behind `sqlite-run-history`'s
  repository-style interface (see `docs/ARCHITECTURE.md`). Adding
  Postgres is a new implementation of the same `RunHistoryRepo` contract,
  not a rewrite of callers.
- Schema migrations live under `src/providers/persistence/migrations/`,
  one file per migration, with a dispatcher per backend. The SQL is kept
  portable where possible; backend-specific divergence (e.g., `JSONB`
  vs `TEXT` for `preset_snapshot_json`) goes through a narrow adapter.
- Presets and run records are written through the same repo, so switching
  backends swaps one provider without touching controllers or the UI.
- Operational guidance: when `AGENTPROBE_DB_URL=postgres://…`, the server
  refuses to boot if the schema is behind HEAD; operators run
  `agentprobe db:migrate` (new CLI subcommand) before starting. SQLite
  keeps its today's behavior of opening and migrating in-process.

This lands in Phase 3 (see §13). Phase 1 ships SQLite-only so shape is
validated before the second backend goes in.

### 8.4 Derived state

Suite discovery is derived state, not persisted. `SuiteController` scans
the `--data` root at request time and caches the parsed structure in
memory with a 30s TTL. Validation errors are surfaced in the UI inline
rather than being persisted.

## 9. Security posture

### 9.1 Binding and exposure

- Default bind is `127.0.0.1`. Any non-loopback host requires the
  `--unsafe-expose` flag **and** a `--token`. The server refuses to start
  otherwise.
- In Docker, publish the port explicitly (`-p 127.0.0.1:7878:7878`). The
  provided compose file documents this pattern.

### 9.2 Auth

- `--token` enables bearer auth on all `/api/*` and SSE routes. The token
  is compared with a constant-time check.
- The UI reads `/api/session` on load to discover whether auth is required;
  when it is, a minimal token entry form stores the token in
  `sessionStorage` and attaches it to every `fetch` and SSE request.
- No password flows, no OAuth, no cookies. V1 stays explicit and minimal.

### 9.3 Secret handling

- `OPEN_ROUTER_API_KEY` and other secrets come from env vars only. The
  server never persists them. `/api/session` exposes _whether_ each secret
  is configured, not the value.
- Logs, metrics, and SSE envelopes redact tokens via the same redactor that
  `sqlite-run-history` already uses for persisted artifacts.

### 9.4 Boundary validation

All inbound payloads (run start body, query strings, path params) are
parsed with a schema before entering the controller. No raw `unknown`
crosses into `domains/`. This upholds `CLAUDE.md` rule 6 and the security
boundary rules in `docs/SECURITY.md`.

### 9.5 Static file serving

Reuses the existing `safeStaticPath` helper in
`src/domains/reporting/dashboard.ts` to prevent directory traversal. The
dashboard bundle is the only tree served statically.

## 10. Reliability and observability

Follows `docs/RELIABILITY.md`:

- Structured logs at startup, request receive, request response (with
  status + latency), run start, run finish, run cancellation, and SSE
  connect/disconnect.
- Metrics: `server.http.requests` by route+status, `server.runs.active`
  gauge, `server.runs.started_total`, `server.runs.finished_total` by
  outcome, `server.sse.connections` gauge.
- Spans around `POST /api/runs` covering validation → controller →
  `runSuite` boot.
- Correlation: every request gets a `x-request-id` (generated if not
  provided). `runId` is included in every log line emitted from a run.
- `/healthz` reports server uptime and DB open status. `/readyz` fails
  until the suite root scan succeeds once.

Performance budgets (initial):

- Static asset serve: < 50ms p95 on the bundled dashboard.
- `/api/runs` list (default page, 50 rows): < 200ms p95 against a 10k-run
  history.
- `POST /api/runs` handler (start only, not the run itself): < 500ms p95.
- SSE first-event latency after a scenario transition: < 250ms p95.

These are instrumented; budgets land in `docs/RELIABILITY.md` when the
feature ships.

## 11. Docker packaging

A new `Dockerfile` and `docker-compose.yml` at the repo root.

### 11.1 Dockerfile

The image's CMD must satisfy the security contract in §5. Because binding
`127.0.0.1` inside a container isn't reachable from the host, the default
CMD binds `0.0.0.0` *and* includes `--unsafe-expose`. The required
`--token` is sourced from `AGENTPROBE_SERVER_TOKEN` at boot; if the env
var is missing, the config loader fails fast with a clear message rather
than starting an unprotected server. This keeps the server's own rules
(`non-loopback ⇒ --unsafe-expose AND --token`) intact while giving the
image a working-by-default entrypoint.

```Dockerfile
# Multi-stage: build dashboard bundle, then ship a minimal runtime image.
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile \
 && bun run dashboard:build

FROM oven/bun:1.3-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
EXPOSE 7878

# Server boot will abort if AGENTPROBE_SERVER_TOKEN is unset, per §5.
ENTRYPOINT ["bun", "run", "./src/cli/main.ts", "start-server"]
CMD ["--host", "0.0.0.0", "--port", "7878", "--unsafe-expose"]
```

`AGENTPROBE_SERVER_TOKEN` is read by `runtime/server/config.ts`; passing
it via env keeps the value out of the image history and `ps` output.

### 11.2 docker-compose.yml

Mounts `./data`, `./runs.sqlite`, and reads `OPEN_ROUTER_API_KEY` from
`.env`. Host port binds to `127.0.0.1` so exposure is explicit even when
the container binds `0.0.0.0`:

```yaml
services:
  agentprobe:
    build: .
    ports:
      - "127.0.0.1:7878:7878"
    environment:
      OPEN_ROUTER_API_KEY: ${OPEN_ROUTER_API_KEY}
      AGENTPROBE_SERVER_TOKEN: ${AGENTPROBE_SERVER_TOKEN:?set a non-empty token}
      # Optional: switch persistence to Postgres so run history survives
      # container restarts without relying on a mounted sqlite file.
      # AGENTPROBE_DB_URL: postgres://agentprobe:${PGPASSWORD}@db:5432/agentprobe
    volumes:
      - ./data:/app/data:ro
      - ./runs.sqlite:/app/runs.sqlite
```

The Compose file's `${VAR:?…}` syntax ensures `docker compose up` fails
locally if the operator forgot to set `AGENTPROBE_SERVER_TOKEN`, matching
the server's boot-time refusal.

### 11.3 Persistent storage in Docker

Two supported patterns:

- **SQLite on a volume (default).** Mount a host path at
  `/app/runs.sqlite` or use a named volume. Simple, single-process
  friendly, matches CLI behavior. Containers on the same host share run
  history across restarts.
- **Postgres (later phase).** Set `AGENTPROBE_DB_URL=postgres://…`. A
  second service in Compose runs Postgres; `./runs.sqlite` is no longer
  required. This pattern is the recommended setup for deployments where
  the AgentProbe container is ephemeral (autoscaled nodes, CI sidecars)
  because losing the container must not lose run history. See §8.3 for
  backend semantics and §13 for the phase this lands in.

Docs update: add `docs/playbooks/agent-probe-server.md` with the concrete
steps for local bring-up, SQLite-on-volume, and Postgres-backed Docker.

## 12. Testing strategy

- **Unit** (`tests/unit/server/`): config parsing, route handlers with
  mocked controllers, SSE envelope encoding, cancellation token
  behavior, auth middleware.
- **Integration** (`tests/integration/server/`): spin up the server against
  a tmp SQLite DB and a fixture suite, hit real HTTP endpoints, assert
  REST + SSE behavior including reconnect via `Last-Event-ID`.
- **E2E** (`tests/e2e/server-e2e.test.ts`): CLI-driven smoke test that
  runs `start-server` in the background, posts a dry-run, polls for
  completion, and hits `/api/runs/:id/report.html`.
- Dashboard gets component tests for the overview and run-detail routes
  using the existing Vite/React harness. No Cypress/Playwright in v1.
- Reuses `bun run docs:validate` + `bun run fast-feedback` gates. The
  server section of the product spec (`docs/product-specs/platform.md`)
  gets new scenarios before implementation.

## 13. Migration and rollout

Incremental rollout keeps the existing `--dashboard` mode stable:

1. **Phase 0 — Contract.** Add scenarios to `docs/product-specs/platform.md`
   covering `start-server` behavior (start, list, detail, SSE, cancel,
   auth gate, presets, comparison). No code yet.
2. **Phase 1 — Read-only server (SQLite).** Implement `start-server`,
   suite/runs read endpoints, health, static bundle, and SSE. Dashboard
   gets the overview + runs list + read-only detail views. No
   `POST /api/runs` yet.
3. **Phase 2 — Run control + presets.** Add `POST /api/runs`, cancel, the
   `/start` run builder (cross-file scenario selection, parallel factor,
   repeat), preset CRUD and "run from preset". Ship Dockerfile and
   docker-compose with SQLite-on-volume. This is the first phase the
   ticket's acceptance criteria describe end-to-end.
4. **Phase 3 — Comparison + Postgres.** Ship `/compare` workspace and
   `/api/comparisons`. Add Postgres backend behind `AGENTPROBE_DB_URL`
   with migration tooling and a Compose example. Document operational
   guidance for ephemeral container deployments.
5. **Phase 4 — Polish.** Keyboard shortcuts, SSE reconnect tuning,
   metrics, soak-test harness, and the operational playbook.

Each phase is a PR. Phase 1 is feature-flagless; subsequent phases gate
write behavior behind explicit config if needed mid-migration. Postgres
lands after the comparison UI because that UI is the first consumer
whose performance envelope might actually need it (SQLite handles up to
tens of thousands of runs on a single node without contention).

## 14. Risks and open questions

1. **SQLite locking under server load.** The existing recorder assumes one
   writer. If the server allows concurrent runs, the recorder must either
   serialize via a per-DB mutex or open WAL mode. Decision: open WAL mode
   in `sqlite-run-history.ts` at boot when `trigger=server`, and document
   the limit as "one concurrent run per suite" for v1.
2. **Preset drift.** Scenarios referenced by a preset can be renamed,
   moved, or deleted between runs. The resolver fails soft: missing
   `{file, id}` pairs are surfaced as warnings at preset fetch time and
   skipped (with a `skipped` outcome record) at run time, so comparison
   is still meaningful. Presets can be edited to prune stale entries.
3. **Comparison alignment.** Scenario IDs are assumed unique within a
   preset. When two presets are compared (ad-hoc flow), duplicate IDs
   from different files fall back to `{file}::{id}` as the alignment
   key, with an info banner in the UI.
4. **Postgres migration parity.** Two backends drift easily. Mitigation:
   the shared integration test suite runs against both backends in CI
   once Phase 3 lands; SQLite-only runs continue to gate earlier phases.
5. **Dashboard bundle location in Docker.** Today the path resolves
   relative to `src/domains/reporting/dashboard.ts`. In Docker this works
   because we copy the source tree, but a future slim image might ship
   only compiled JS. `--dashboard-dist` is the escape hatch.
6. **SSE through proxies.** Some reverse proxies buffer SSE. The docs will
   call out the required `proxy_buffering off` for nginx and equivalents.
7. **Long-running stability.** `Bun.serve` has matured, but long uptime
   under heavy load is untested in this repo. Phase 4 adds a soak-test
   harness to `tests/` that runs the server for 1h with synthetic runs.
8. **Browser caching of the SPA.** The dashboard bundle is hashed by
   Vite. Server sets `Cache-Control: public, max-age=31536000, immutable`
   for hashed assets and `no-store` for `index.html`.

## 15. Acceptance criteria for this design

- [x] Single-command start path described (`agentprobe start-server`).
- [x] UI control-dashboard shape specified, grounded in cupel design
      *direction* (palette, density, list+detail split, keyboard-first)
      rather than a direct copy.
- [x] Run builder supports selecting scenarios across any combination of
      scenario files under `data/`, with a parallel-factor control on the
      same form.
- [x] Presets: scenario selection + execution knobs are saved by name and
      re-runnable without re-specifying anything.
- [x] Comparison view for multiple runs of the same preset (or ad-hoc run
      sets) with scenario-aligned diffs.
- [x] Browsable run logs: REST + SSE + HTML report reuse defined; drill-
      down routes named.
- [x] Docker packaging described with concrete Dockerfile and compose;
      the default CMD satisfies the server's own non-loopback security
      contract.
- [x] Persistence path documented for ephemeral-container deployments:
      SQLite on mount by default, Postgres as a later-phase option
      behind `AGENTPROBE_DB_URL`.
- [x] Security defaults (loopback, auth token, secret redaction) defined.
- [x] Boundary rules, layering, and observability mapped to repo contracts.
- [x] Phased rollout identified so implementation PRs stay reviewable.
