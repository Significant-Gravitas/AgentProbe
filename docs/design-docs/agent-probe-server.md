# AgentProbe Server Design

Durable design for turning AgentProbe's single-run `--dashboard` into a
long-running, Dockerable control plane: `agentprobe start-server`.

Linear: [SYM-18](https://linear.app/autogpt/issue/SYM-18/agent-probe-server-design)

## 1. Goals

1. One command (`agentprobe start-server`) starts a long-lived HTTP server
   that hosts a UI and an API for controlling and inspecting AgentProbe
   evaluation runs.
2. The server is Dockerable with zero external dependencies beyond the local
   filesystem. SQLite run history and suite YAMLs mount in, OPEN_ROUTER_API_KEY
   flows in through the environment.
3. The UI lets operators start runs, watch live progress, and browse a
   history of past runs and transcripts without dropping to the shell. UI
   shape is inspired by [tolitius/cupel](https://github.com/tolitius/cupel):
   a leaderboard-style overview, filterable run list, and drill-down detail
   views wired through SSE.
4. Historical runs stay browsable: transcripts, judge scores, tool calls,
   checkpoints, and render of the existing HTML report — without re-running
   evaluations.
5. The design preserves AgentProbe's layered architecture and repo contract:
   new server code lands in `src/runtime/server/`, reuses existing
   `domains/evaluation` and `domains/reporting`, and never leaks transport
   into higher layers.

## 2. Non-goals

- Multi-tenant auth, SSO, or RBAC. Out of scope for v1. The server targets
  a single operator running on their own machine or an internal VM.
- Distributed run orchestration across workers. Runs still execute in-process
  on the host that runs the server. Concurrency is bounded by the existing
  `--parallel` semantics.
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
    reports.ts          # HTML report proxy: render + stream
    health.ts           # /healthz, /readyz
    static.ts           # dashboard/dist serving with safeStaticPath
  streams/
    events.ts           # SSE fan-out for /api/runs/:id/events
    hub.ts              # In-process pub/sub with per-run subjects
  controllers/
    run-controller.ts   # Starts, tracks, and cancels runs; owns worker slots
    suite-controller.ts # Enumerates suites from the configured data dir
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
  [--db ./runs.sqlite]        # run history database path
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
| `GET` | `/api/runs` | List runs with pagination (`?limit=&cursor=`), filters (`?status=&suite=&since=`), and summary fields |
| `GET` | `/api/runs/:runId` | Full run record: scenario list, averages, judge metadata |
| `GET` | `/api/runs/:runId/scenarios/:ordinal` | Single scenario detail: transcript, tool calls, checkpoints, judge output |
| `GET` | `/api/runs/:runId/events` | Server-Sent Events stream for live progress (see §6.3) |
| `GET` | `/api/runs/:runId/report.html` | HTML report rendered from persisted run history |
| `GET` | `/api/runs/:runId/artifacts/:name` | Raw artifact download (transcript JSON, judge JSON) |

### 6.2 Write endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/runs` | Start a run against a known suite + optional filters |
| `POST` | `/api/runs/:runId/cancel` | Signal an active run to stop after the current scenario |

`POST /api/runs` body:

```json
{
  "suite_id": "baseline",
  "endpoint": "data/endpoints/autogpt.yaml",
  "scenarios": "data/scenarios/baseline",
  "personas": "data/personas/baseline.yaml",
  "rubric": "data/rubric.yaml",
  "scenario_filter": { "ids": ["multi_session_memory"], "tags": ["memory"] },
  "parallel": { "enabled": true, "limit": 3 },
  "repeat": 5,
  "dry_run": false,
  "label": "nightly-baseline-2026-04-17"
}
```

Every field except `suite_id` (or equivalent explicit `endpoint`/
`scenarios`/`personas`/`rubric`) is optional. The handler validates the
body with a schema before calling into the run controller.

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
- Visual grammar modelled on cupel: compact top bar with global stats, a
  left-side list of runs, a right-side detail pane, and an overlay panel
  for scenario drill-down.

### 7.2 Route map

| Path | View |
|---|---|
| `/` | Overview: active runs, last N completed, aggregate pass rate |
| `/runs` | Run list with filters (status, suite, label, date range) |
| `/runs/:runId` | Live run detail: scenario table, stats bar, averages, SSE-driven updates, report link |
| `/runs/:runId/scenarios/:ordinal` | Scenario drill-down: transcript, tool calls, checkpoints, rubric scores |
| `/suites` | Discovered suites with "start run" affordance |
| `/suites/:id/start` | Form to launch a run (scenario filter, parallel, repeat, dry-run, label) |
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

### 7.6 Accessibility & theming

- Keyboard navigation: `j`/`k` through the run list, `g r` to go to runs,
  `/` to focus search. Parity with cupel's keyboard affordances.
- Dark theme default; respects `prefers-color-scheme`.
- All panels render without JS for the health/readyz pages only (server-
  rendered plain HTML) so Docker healthchecks stay trivial.

## 8. Data model

The server does not introduce a new database. All durable state reuses
`sqlite-run-history` tables. New fields needed:

- `runs.label TEXT NULL` — optional human-friendly tag supplied at start.
- `runs.trigger TEXT NOT NULL DEFAULT 'cli'` — one of `cli|server|api`, so
  operators can filter server-initiated runs.
- `runs.cancelled_at DATETIME NULL` — stamped when cancellation completes.

A migration ships with the feature and updates the read model in
`domains/reporting`. Back-filling is not required; missing values read as
`NULL`/defaults.

Suite discovery is derived state, not persisted. `SuiteController` scans
the `--data` root at request time and caches the parsed structure in memory
with a 30s TTL. Validation errors are surfaced in the UI inline rather than
being persisted.

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

A new `Dockerfile` and `docker-compose.yml` at the repo root:

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
ENTRYPOINT ["bun", "run", "./src/cli/main.ts", "start-server"]
CMD ["--host", "0.0.0.0", "--port", "7878"]
```

`docker-compose.yml` mounts `./data`, `./runs.sqlite`, and reads
`OPEN_ROUTER_API_KEY` from `.env`. It binds the host port to `127.0.0.1`
by default:

```yaml
services:
  agentprobe:
    build: .
    ports:
      - "127.0.0.1:7878:7878"
    environment:
      OPEN_ROUTER_API_KEY: ${OPEN_ROUTER_API_KEY}
      AGENTPROBE_SERVER_TOKEN: ${AGENTPROBE_SERVER_TOKEN:-}
    volumes:
      - ./data:/app/data:ro
      - ./runs.sqlite:/app/runs.sqlite
    command:
      - --host
      - 0.0.0.0
      - --port
      - "7878"
      - --unsafe-expose
      - --token
      - ${AGENTPROBE_SERVER_TOKEN}
```

Docs update: add `docs/playbooks/agent-probe-server.md` with the concrete
steps for local + Docker bring-up.

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
   auth gate). No code yet.
2. **Phase 1 — Read-only server.** Implement `start-server`, suite/runs
   read endpoints, health, static bundle, and SSE. Dashboard gets the
   overview + runs list + read-only detail views. No `POST /api/runs` yet.
3. **Phase 2 — Run control.** Add `POST /api/runs`, cancel, and the start
   form in the UI. Ship Docker and compose files.
4. **Phase 3 — Polish.** Keyboard shortcuts, SSE reconnect tuning,
   metrics, and the operational playbook.

Each phase is a PR. Phase 1 is feature-flagless; subsequent phases gate
write behavior behind explicit config if needed mid-migration.

## 14. Risks and open questions

1. **SQLite locking under server load.** The existing recorder assumes one
   writer. If the server allows concurrent runs, the recorder must either
   serialize via a per-DB mutex or open WAL mode. Decision: open WAL mode
   in `sqlite-run-history.ts` at boot when `trigger=server`, and document
   the limit as "one concurrent run per suite" for v1.
2. **Dashboard bundle location in Docker.** Today the path resolves
   relative to `src/domains/reporting/dashboard.ts`. In Docker this works
   because we copy the source tree, but a future slim image might ship
   only compiled JS. `--dashboard-dist` is the escape hatch.
3. **SSE through proxies.** Some reverse proxies buffer SSE. The docs will
   call out the required `proxy_buffering off` for nginx and equivalents.
4. **Long-running stability.** `Bun.serve` has matured, but long uptime
   under heavy load is untested in this repo. Phase 3 adds a soak-test
   harness to `tests/` that runs the server for 1h with synthetic runs.
5. **Browser caching of the SPA.** The dashboard bundle is hashed by
   Vite. Server sets `Cache-Control: public, max-age=31536000, immutable`
   for hashed assets and `no-store` for `index.html`.

## 15. Acceptance criteria for this design

- [x] Single-command start path described (`agentprobe start-server`).
- [x] UI control-dashboard shape specified, grounded in cupel inspiration
      and the existing `dashboard/` stack.
- [x] Browsable run logs: REST + SSE + HTML report reuse defined; drill-
      down routes named.
- [x] Docker packaging described with concrete Dockerfile and compose.
- [x] Security defaults (loopback, auth token, secret redaction) defined.
- [x] Boundary rules, layering, and observability mapped to repo contracts.
- [x] Phased rollout identified so implementation PRs stay reviewable.
