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
   curl -fsS http://127.0.0.1:7878/readyz
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

Compose also marks `agentprobe` healthy only after the in-container readiness
probe receives HTTP 200 from `/readyz`:

```bash
bun -e "fetch('http://127.0.0.1:7878/readyz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
```

Use the Compose health state before depending on the service from another
container:

```bash
docker compose ps agentprobe
docker inspect --format '{{json .State.Health}}' "$(docker compose ps -q agentprobe)"
```

When the probe fails, inspect the readiness response from inside the container
and then read the server logs:

```bash
docker compose exec agentprobe bun -e "fetch('http://127.0.0.1:7878/readyz').then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); }).catch((error) => { console.error(error); process.exit(1); })"
docker compose logs agentprobe
```

Common causes are a missing `./data` suite root, a SQLite volume that another
writer is holding open, or a Postgres schema that is behind the target migration
version.

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

The persistence layer accepts `sqlite:///…`, `postgres://…`, and
`postgresql://…` URLs via `--db` or `AGENTPROBE_DB_URL`. SQLite remains the
default when the URL is absent or points at a filesystem path. Postgres support
ships in Phase 3 with a dedicated migration CLI, schema-version boot gate for
read-only repository paths, and credential redaction in logs and `/api/session`.

Postgres is intentionally read-only for run recording in this release. The
repository supports schema migrations, preset CRUD, and historical reads for
listings and comparisons, but it does not expose the run-recorder capability.
Because `agentprobe start-server` currently exposes run write routes such as
`POST /api/runs`, preset run starts, and run cancellation, the server fails fast
when its database URL resolves to Postgres. Use `sqlite:///…` for the
write-enabled server until the Postgres recorder ships.

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

4. Use SQLite for the write-enabled server. A Postgres URL fails during config
   loading before run routes can accept traffic:

   ```bash
   bun run agentprobe start-server --data data --db sqlite:///absolute/path/to/runs.sqlite3
   ```

   The Postgres **check-only** version probe is reserved for read-only
   repository paths and future server modes that do not expose run recording.
   When enabled, it refuses to start if the schema is behind the expected
   version and tells you to rerun `agentprobe db:migrate`.

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
| `Postgres schema version N is behind expected M` | Run `agentprobe db:migrate` before using Postgres read paths. |
| `Postgres is read-only for run recording in this release` | Intentional Phase 3 scope: `agentprobe start-server` has run write routes enabled, so use SQLite for server run recording while Postgres read/compare/preset CRUD ships first. |
| `Unsupported database URL scheme` | Provide one of `sqlite:///…`, `postgres://…`, `postgresql://…`. |

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
