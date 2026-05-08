# Persistence

AgentProbe supports two persistence backends selected by URL scheme:

- `sqlite:///absolute/or/relative/path.sqlite3` for local development and
  single-process use.
- `postgres://...` or `postgresql://...` for production `start-server` deploys.

SQLite is the default when no database URL is provided. It creates the database
and an encryption key sidecar file automatically. Postgres is intended for
networked, durable server deployments and supports the same server features:
run recording, run history reads, preset CRUD, encrypted settings, and endpoint
overrides.

## Environment

- `AGENTPROBE_DB_URL`: full database URL. Use this for Postgres.
- `AGENTPROBE_SERVER_DB`: SQLite path or URL fallback for the server.
- `AGENTPROBE_ENCRYPTION_KEY`: 32-byte key encoded as hex or base64. Required
  for Postgres because sidecar key files do not belong next to a remote
  database URL.

## Migrations

Run migrations before starting the server against Postgres:

```bash
bun src/cli/main.ts db:migrate
```

`start-server` checks the Postgres schema version at boot and refuses to run
when the database is behind the expected version. SQLite migrations run through
the normal local database initialization path.

## Local Postgres Validation

Postgres tests are env-gated so default CI does not need a database service.
Use a throwaway database because the tests reset AgentProbe tables.

```bash
docker run --rm -d --name agentprobe-pg \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=agentprobe_test \
  postgres:16

export AGENTPROBE_POSTGRES_TEST_URL=postgres://postgres:postgres@localhost:5432/agentprobe_test
bun run test tests/unit/persistence/
```

## Human scoring track

Human-authored scores live in a separate table, `human_dimension_scores`, that
mirrors `judge_dimension_scores` so the two tracks are easy to compare side by
side. Each row is keyed by a unique `(scenario_run_id, dimension_id)` so the
queue served by `/api/human-scoring/next` can skip already-scored chats with a
single LEFT JOIN. Dimension metadata for the scoring UI is read out of each
scenario's frozen `rubric_snapshot_json`, so the UI does not depend on the
rubric YAML staying on disk after a run completes. The repository surface is
exposed via `HumanScoreRepository` in
`src/providers/persistence/types.ts`.

## Deploy Notes

For production, set `AGENTPROBE_DB_URL` and `AGENTPROBE_ENCRYPTION_KEY`
externally through the host, orchestrator, or secret manager. Keep SQLite as
the local default unless you need remote durability, shared access from the
server process, or a database managed outside the application container.
