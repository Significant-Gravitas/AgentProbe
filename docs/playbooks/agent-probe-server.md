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

Postgres support and schema migration commands are planned for the later
comparison/Postgres phase; Phase 2 remains SQLite-only.
