# AgentProbe Server Phase 3: Comparison And Postgres

## Goal

Ship historical run comparison and add a Postgres persistence backend behind
`AGENTPROBE_DB_URL`.

This phase makes presets useful over time: operators can compare multiple
executions of the same saved run shape, spot regressions, and keep history
durable when the server container is ephemeral.

## Decisions

- Comparison is an API and UI feature, not a reporting-only feature.
- `GET /api/comparisons` accepts 2 to 10 run IDs.
- Runs with the same preset align by the frozen preset snapshot first. Runs
  without a shared preset align by scenario ID, falling back to `file::id` when
  duplicate IDs would be ambiguous.
- Missing scenarios are represented in the payload instead of failing the
  request.
- Postgres is selected only by `AGENTPROBE_DB_URL=postgres://...` or
  `postgresql://...`.
- SQLite remains the default and must keep in-process migrations.
- Postgres refuses to boot when its schema is behind the expected migration.
  Operators run the new migration command first.
- Keep backend-specific SQL behind provider adapters. Controllers and routes
  depend on a repository interface, not on SQLite or Postgres modules.

## Steps

1. Extract a persistence contract.
   - Add a provider-facing interface for run history, scenario history,
     presets, comparison reads, and recorder creation.
   - Keep existing TypeScript types in `src/shared/types/contracts.ts` unless
     they are server-only.
   - Move backend selection into a small factory that accepts a normalized DB
     URL and returns the proper repository implementation.
   - Preserve existing `sqlite-run-history.ts` exports as compatibility
     wrappers where older CLI/report code still imports them.

2. Add migration infrastructure.
   - Create `src/providers/persistence/migrations/`.
   - Store one migration per backend and version.
   - Include migrations for the schema state after Phase 2.
   - Add a migration dispatcher that can report current version, expected
     version, pending migrations, and backend type.
   - SQLite keeps open-and-migrate behavior for local CLI compatibility.
   - Postgres exposes check-only-on-boot and migrate-through-CLI behavior.

3. Add Postgres provider.
   - Use Bun's built-in Postgres client if the repo's Bun version and
     `bun-types` support it; otherwise add one minimal Postgres dependency
     with a short rationale in the PR.
   - Implement the same repository contract as SQLite:
     run list, run detail, scenario detail, reports, presets, recorder writes,
     cancellation, and comparison reads.
   - Use transactions for run/scenario artifact writes.
   - Store JSON as `jsonb` where it materially helps querying; convert through
     the same TypeScript boundary types used by SQLite.
   - Add indexes matching server filters and comparison lookup patterns:
     run status, trigger, preset ID, started timestamp, scenario run ID, and
     scenario alignment key.

4. Add CLI migration surface.
   - Add `agentprobe db:migrate`.
   - Support `--db` or `AGENTPROBE_DB_URL`.
   - Print backend, current version, target version, and applied migrations.
   - Fail clearly for unsupported schemes.
   - Keep the command non-interactive for CI and Docker use.

5. Update server config for backend selection.
   - Accept `sqlite:///...`, `postgres://...`, and `postgresql://...`.
   - Continue accepting the Phase 1/2 `--db` path as SQLite-only shorthand.
   - On Postgres server boot, check schema version and fail if migrations are
     pending.
   - Redact credentials from logs and `/api/session`.

6. Add `src/runtime/server/controllers/comparison-controller.ts`.
   - Load all requested runs and their scenarios.
   - Validate run count and missing IDs.
   - Determine alignment mode:
     shared preset snapshot, shared preset ID, scenario ID, or `file::id`.
   - Produce the design payload:
     `runs`, `scenarios`, per-run status/score/reason, `delta_score`,
     `status_change`, and `summary`.
   - Include `present_in` for missing scenarios.
   - Preserve input run order unless the UI explicitly requests chronological
     order.

7. Add comparison route.
   - `GET /api/comparisons?run_ids=a,b,c`
   - Reject fewer than 2 or more than 10 run IDs.
   - Return the common error envelope for bad input and missing runs.
   - Cache nothing at the HTTP layer; comparisons reflect current history.

8. Add dashboard comparison workspace.
   - `/compare`: ad-hoc picker for 2 to 10 runs.
   - From `/presets/:presetId`, "Compare runs" pre-filters to the preset and
     defaults to the two most recent runs.
   - Render one column per run and one row per scenario.
   - Show sticky summary metrics, score deltas, status changes, missing
     scenarios, and an "only changes" toggle.
   - Deep link selected runs through `?run_ids=...&only=changes`.

9. Update Docker Compose.
   - Add an optional Postgres service example.
   - Show `AGENTPROBE_DB_URL=postgres://...`.
   - Document that `agentprobe db:migrate` runs before `start-server`.
   - Keep SQLite-on-volume as the default compose path.

10. Update operational docs.
    - Expand `docs/playbooks/agent-probe-server.md` with Postgres setup,
      migration, rollback expectations, backup guidance, and common connection
      errors.
    - Document comparison semantics and duplicate-ID behavior.

11. Add tests.
    - Shared repository contract tests that run against SQLite and Postgres
      when Postgres is available.
    - Unit tests for comparison alignment, missing scenarios, duplicate IDs,
      and status-change classification.
    - Integration tests for `/api/comparisons`.
    - Migration tests for version checks and unsupported backend errors.
    - Dashboard tests for compare picker, table rendering, only-changes mode,
      and deep links.

## Dependencies

- Depends on Phase 2 run metadata, preset snapshots, preset run history, and
  Docker packaging.
- Requires a Postgres test service in CI or a gated local integration path.
- Does not depend on Phase 4 keyboard shortcuts, soak tests, or metrics polish.

## Validation

- `bun run docs:validate`
- `bun run test tests/unit/server`
- `bun run test tests/integration/server`
- Shared persistence contract tests for SQLite.
- Shared persistence contract tests for Postgres when the test database URL is
  configured.
- `bun run dashboard:build`
- `bun run typecheck`
- `bun run fast-feedback`
- Manual smoke:
  run two dry-runs from the same preset, open `/compare?run_ids=...`, then
  verify the API and UI agree on regressions and unchanged rows.
- Postgres smoke:
  run `agentprobe db:migrate` against a local Postgres URL, boot the server with
  that URL, create a preset, launch a dry-run, restart the server, and confirm
  history remains.

## Risks And Rollout Notes

- Backend drift is the largest risk. Keep contract tests identical across
  SQLite and Postgres.
- Postgres migrations must never run implicitly on server boot; that hides
  operational failures in Docker.
- Comparison can become expensive on large histories. Keep the API bounded to
  10 run IDs and fetch only the requested runs.
- Be careful with JSON shape parity. The UI should not need backend-specific
  conditionals.
