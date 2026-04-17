# AgentProbe Server Playbook

## Trigger

Use this playbook when bringing up `agentprobe start-server` locally, exposing
it with bearer-token protection, or running the Docker-packaged SQLite server.

## Local Bring-Up

1. Install dependencies and build the dashboard bundle:

   ```bash
   bun install --frozen-lockfile
   bun run dashboard:build
   ```

2. Start the loopback server:

   ```bash
   OPEN_ROUTER_API_KEY="$OPEN_ROUTER_API_KEY" \
     bun run agentprobe start-server --data data --db .agentprobe/runs.sqlite3
   ```

3. Open `http://127.0.0.1:7878`.

4. Verify the read and write surfaces:

   ```bash
   curl -fsS http://127.0.0.1:7878/healthz
   curl -fsS http://127.0.0.1:7878/api/suites
   ```

## Token-Protected External Bind

1. Set a non-empty token and keep it out of shell history where possible:

   ```bash
   export AGENTPROBE_SERVER_TOKEN="$(openssl rand -hex 24)"
   ```

2. Start the server on an external interface:

   ```bash
   OPEN_ROUTER_API_KEY="$OPEN_ROUTER_API_KEY" \
   AGENTPROBE_SERVER_TOKEN="$AGENTPROBE_SERVER_TOKEN" \
     bun run agentprobe start-server \
       --host 0.0.0.0 \
       --port 7878 \
       --unsafe-expose \
       --data data \
       --db .agentprobe/runs.sqlite3
   ```

3. Call protected APIs with a bearer token:

   ```bash
   curl -fsS \
     -H "Authorization: Bearer $AGENTPROBE_SERVER_TOKEN" \
     http://127.0.0.1:7878/api/runs
   ```

## Docker With SQLite On Volume

1. Export required environment variables:

   ```bash
   export AGENTPROBE_SERVER_TOKEN="$(openssl rand -hex 24)"
   export OPEN_ROUTER_API_KEY="$OPEN_ROUTER_API_KEY"
   ```

2. Build and boot:

   ```bash
   docker compose up --build
   ```

3. Verify the server:

   ```bash
   curl -fsS http://127.0.0.1:7878/healthz
   curl -fsS \
     -H "Authorization: Bearer $AGENTPROBE_SERVER_TOKEN" \
     http://127.0.0.1:7878/api/presets
   ```

4. Trigger a dry-run through the API:

   ```bash
   curl -fsS \
     -H "Authorization: Bearer $AGENTPROBE_SERVER_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "endpoint": "autogpt-endpoint.yaml",
       "personas": "personas.yaml",
       "rubric": "rubric.yaml",
       "selection": [{ "file": "baseline-scenarios.yaml", "id": "task-001" }],
       "dry_run": true,
       "label": "docker-smoke"
     }' \
     http://127.0.0.1:7878/api/runs
   ```

The Compose service binds `127.0.0.1:7878:7878`, mounts `./data` read-only, and
stores SQLite history in the `agentprobe-sqlite` volume at
`/app/.agentprobe/runs.sqlite3`.

## Validation

Run these checks before handing off server changes:

```bash
bun run docs:validate
bun run test tests/unit/server
bun run test tests/integration/server
bun run test:e2e
bun run dashboard:build
bun run typecheck
bun run fast-feedback
```

## Troubleshooting

- Missing `OPEN_ROUTER_API_KEY`: run-start requests return
  `open_router_not_configured`. Set the env var and retry. Read-only browsing
  still works without it.
- Missing token with Docker or `--unsafe-expose`: boot fails because
  non-loopback binds require `AGENTPROBE_SERVER_TOKEN`.
- Missing dashboard bundle: run `bun run dashboard:build`, or set
  `AGENTPROBE_SERVER_DASHBOARD_DIST` to a valid built bundle.
- SQLite lock errors: keep one server process per SQLite volume, prefer the
  provided Compose volume, and stop old containers before starting another
  writer.
- Paths rejected by write APIs: `endpoint`, `personas`, `rubric`, and every
  `selection[].file` must resolve under `--data`.

## Postgres Backend (Phase 3)

The server accepts `sqlite:///…`, `postgres://…`, and `postgresql://…` URLs via
`--db` or `AGENTPROBE_DB_URL`. SQLite remains the default when the URL is absent
or points at a filesystem path. Postgres support ships in Phase 3 with a
dedicated migration CLI, schema-version boot gate, and credential redaction in
logs and `/api/session`.

### Setup

1. Provision Postgres 14+ (the Docker Compose example ships an optional
   `postgres:16-alpine` service).
2. Export the URL once so the CLI and the server agree:

   ```bash
   export AGENTPROBE_DB_URL="postgres://agentprobe:agentprobe@localhost:5432/agentprobe"
   ```

3. Apply migrations with the CLI before starting the server. The command is
   non-interactive and prints the backend / current / target versions plus the
   list of migrations it applied:

   ```bash
   bun src/cli/main.ts db:migrate
   # backend: postgres
   # db_url:  postgres://agentprobe:***@localhost:5432/agentprobe
   # current: 0
   # target:  1
   # applied: 1
   ```

4. Boot the server. It performs a **check-only** version probe — it will refuse
   to start when the schema is behind the expected version, with a message
   telling you to rerun `agentprobe db:migrate`:

   ```bash
   bun run agentprobe start-server --data data
   ```

### Rollback / Reset

- To downgrade, restore from a Postgres-native backup (`pg_dump` → `pg_restore`).
  The migration dispatcher is forward-only and does not synthesise downgrade
  scripts.
- For local experiments, drop the schema and rerun `db:migrate`:

  ```bash
  psql "$AGENTPROBE_DB_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
  bun src/cli/main.ts db:migrate
  ```

### Backups

- Schedule `pg_dump -Fc "$AGENTPROBE_DB_URL" > agentprobe-$(date +%F).dump`
  daily or hourly against the operator's preferred window. Store dumps outside
  the container volume so a lost node does not take the backup with it.
- For the SQLite-on-volume path, `sqlite3 … ".backup /tmp/runs.sqlite3.bak"`
  remains the safe approach while the server is running.

### Connection errors

| Symptom | Likely cause |
| --- | --- |
| `Postgres backend requires Bun ≥ 1.2` | Runtime is too old; upgrade Bun. |
| `Failed to open Postgres connection: ECONNREFUSED` | Postgres not running or the URL host/port is wrong. |
| `Postgres schema version N is behind expected M` | Run `agentprobe db:migrate` before `start-server`. |
| `Postgres recorder failed to flush buffered events: …` | The buffered recorder exhausted its retry budget while writing to Postgres. Check database connectivity and Postgres logs; the run is marked errored and the queued events for that flush attempt were dropped. |
| `Unsupported database URL scheme` | Provide one of `sqlite:///…`, `postgres://…`, `postgresql://…`. |

### Postgres recorder flush and crash semantics

- **Buffered flush (Phase 3.1).** The recorder keeps a synchronous surface for
  the suite runner but queues each `record*` event and flushes batches through
  a single `Bun.SQL.begin` transaction. One in-flight transaction per recorder
  keeps event ordering deterministic.
- **Client-assigned IDs.** Both `runId` (UUID text) and `scenarioRunId`
  (52-bit composite: 24-bit random prefix + 28-bit monotonic counter) are
  allocated on the client so the caller can reuse them immediately without
  waiting for the flush. The counter exhausts after 2^28 scenarios per run
  (more than enough for any realistic suite); exceeding it raises an
  `AgentProbeRuntimeError`.
- **Drain on run end.** `runSuite` callers `await recorder.drain()` after the
  run completes. Drain waits for the queue to fully empty and re-throws the
  last persistent flush error as `AgentProbeRuntimeError`, which fails the
  run instead of silently dropping events.
- **SIGTERM / graceful shutdown.** The server's cancel-all path awaits
  in-flight recorder promises before flipping the run status to cancelled,
  which gives the flush worker a chance to land the remaining writes. A clean
  shutdown after cancellation emits one final `updated_at` bump through the
  repository's `markRunCancelled` and is safe to replay.
- **SIGKILL / abrupt termination.** Buffered events that never flushed are
  lost on `SIGKILL`; the next boot logs a structured `WARN` via the flush
  retry path when the reconnect succeeds but finds no trailing row for the
  last known run. Operators should treat `status = 'running'` with no recent
  `updated_at` activity as "crash-interrupted" and either mark it cancelled or
  rerun the suite.
- **Backpressure.** The queue is unbounded but each op is a small SQL tuple;
  in practice the flush loop keeps up with evaluation latency. If the queue
  length grows unboundedly, the recorder logs `postgres recorder flush
  failed` each retry cycle — that is the signal to increase DB capacity or
  fall back to SQLite for the affected run.

Credentials are never logged: `/readyz`, `/api/session`, and server boot logs
go through the same redactor (`user:***@host`).

## Comparison Semantics (Phase 3)

`GET /api/comparisons?run_ids=a,b,c,…` loads 2–10 runs and returns a payload
that powers the `/compare` dashboard workspace. Alignment is chosen in this
order of preference:

1. **Preset snapshot** — all runs share the same embedded
   `preset_snapshot_json` (endpoint/personas/rubric/selection). Preferred
   because it is the most specific match.
2. **Preset ID** — runs share `preset_id` but their snapshots differ (someone
   edited the preset between runs).
3. **Scenario ID** — no preset information is shared, so rows align by the raw
   scenario id.
4. **`file::scenario_id`** — if any run contains duplicate scenario ids across
   different YAML files, every row is keyed as `<file>::<scenario_id>` so the
   duplicates do not silently merge into one row.

Each row carries:

- `present_in`: the subset of run ids that produced the scenario.
- `entries[<run_id>]`: `{status, score, reason}` per run, with
  `status = "missing"` when the run did not produce that scenario.
- `delta_score`: last score minus first score across present runs, `null` when
  fewer than two numeric scores are available.
- `status_change`: one of `unchanged | regressed | improved | mixed`.

The HTTP endpoint:

- Rejects fewer than 2 or more than 10 run ids with
  `400 {"error":{"code":"bad_request"}}`.
- Dedupes repeated run ids in the query string.
- Returns 404 through the same error envelope when any run id cannot be
  resolved.
- Sends `cache-control: no-store` (comparison deltas must always reflect the
  current run state).

The dashboard reads `?run_ids=a,b[&only=changes]` so shared deep links survive
refresh, and the preset detail view surfaces a "Compare last two runs" CTA
that pre-selects the two most recent runs for the preset.
