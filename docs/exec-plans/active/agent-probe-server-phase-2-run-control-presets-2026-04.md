# AgentProbe Server Phase 2: Run Control And Presets

## Goal

Add write behavior to the server: start runs, cancel active runs, save presets,
run from presets, and package the SQLite-backed server for Docker.

This phase is the first end-to-end operator workflow: open the server UI, build
a cross-file scenario selection, start an evaluation, watch live progress,
cancel when needed, save the configuration as a preset, and rerun it by name.

## Decisions

- `POST /api/runs` starts work asynchronously and returns `202` with the run
  ID once the run record exists.
- Missing `OPEN_ROUTER_API_KEY` rejects run-start requests with `400`, but does
  not block server boot or read-only browsing.
- Cancellation is cooperative. It is checked before each scenario dispatch and
  between scenarios. In-flight endpoint traffic is not aborted mid-scenario.
- Preset deletion is soft. Historical runs remain browseable and comparable.
- Each run launched from a preset stores a frozen `preset_snapshot_json` on the
  run row. Later preset edits do not rewrite history.
- Cross-file scenario selection resolves by `{ file, id }`, not by ID alone.
  This avoids ambiguity when different files reuse scenario IDs.
- Phase 2 stays SQLite-only. The Docker image documents the later Postgres
  path but does not ship it.
- For v1, the controller rejects a new run with `409` when another active run
  is using the same resolved suite key. The per-run `parallel` knob still
  controls scenario-level concurrency inside `runSuite`.

## Steps

1. Add request and response schemas.
   - Create local validation helpers under `src/runtime/server/routes/` or
     `src/runtime/server/validation.ts`; do not add a schema dependency unless
     there is a clear repeated need.
   - Validate path params, query strings, and JSON bodies before controllers
     receive them.
   - Implement the common error codes:
     `bad_request`, `unauthorized`, `not_found`, `conflict`,
     `open_router_not_configured`, `run_start_failed`, and `cancel_failed`.

2. Extend SQLite schema and persistence helpers.
   - Increment `SCHEMA_VERSION`.
   - Add nullable run columns:
     `label`, `trigger`, `cancelled_at`, `preset_id`,
     `preset_snapshot_json`.
   - Add `presets` and `preset_scenarios` tables as described in the server
     design.
   - Add indexes for run list filters: status, trigger, preset ID, and started
     timestamp.
   - Add persistence functions for preset CRUD, soft delete, preset run
     history, run metadata updates, and cancellation status.
   - Keep existing `SqliteRunRecorder`, `listRuns`, `getRun`, and report
     rendering behavior backward compatible.

3. Add scenario selection resolution.
   - Add a suite-controller helper that resolves an array of
     `{ file, id }` against the configured data root.
   - Reject files outside the data root.
   - Parse selected scenario files with `parseScenarioYaml`.
   - Return warnings for missing references on preset fetch.
   - At run time, skipped missing preset scenarios should produce persisted
     skipped outcome records if the recorder supports them in this phase;
     otherwise reject the run with an actionable validation error and record
     the skipped-outcome work in the tech debt tracker.
   - Extend `runSuite` with a structured selection option or a prepared
     scenario collection so exact `{ file, id }` references do not collapse
     into comma-separated IDs.

4. Extend `runSuite` for server execution.
   - Add an optional cancellation callback or `AbortSignal`.
   - Check cancellation before preparing a scenario and before dispatching it.
   - Emit a terminal cancellation result that the recorder can persist as
     `cancelled`.
   - Preserve CLI behavior when no cancellation signal or structured selection
     is supplied.
   - Keep existing progress events stable and add any new event kinds through
     `src/shared/types/contracts.ts` only when tests require them.

5. Add `src/runtime/server/controllers/run-controller.ts`.
   - Own an in-memory map of active runs.
   - Enforce one active run per resolved suite key for v1.
   - Create a `SqliteRunRecorder`, call `runSuite`, read the run ID
     immediately after start, and return it to the route.
   - Publish progress events into the SSE hub.
   - Mark completion, failure, and cancellation consistently in SQLite.
   - Release active-run locks in `finally`.
   - On server shutdown, request cancellation for all active runs, emit
     terminal SSE events, and wait for graceful completion up to a bounded
     timeout before closing the listener.

6. Add write run routes.
   - `POST /api/runs` accepts either `preset_id` plus optional overrides, or
     explicit ad-hoc fields:
     `endpoint`, `selection`, `personas`, `rubric`, `parallel`, `repeat`,
     `dry_run`, `label`, and optional `save_as_preset`.
   - `POST /api/runs/:runId/cancel` requests cooperative cancellation and
     returns the updated run status.
   - Reject write routes without bearer auth when a token is configured.
   - Ensure all paths in request bodies resolve under the configured data root.

7. Add `src/runtime/server/controllers/preset-controller.ts`.
   - Create, update, soft-delete, list, and fetch presets.
   - Persist scenario order in `preset_scenarios.position`.
   - Resolve presets into concrete scenario refs on fetch.
   - Return last-run summary for list views.
   - Freeze preset snapshots when launching runs.
   - Support `POST /api/presets/:presetId/runs` with optional `label` and
     safe overrides for parallel, repeat, and dry-run.

8. Add preset routes.
   - `GET /api/presets`
   - `GET /api/presets/:presetId`
   - `GET /api/presets/:presetId/runs`
   - `POST /api/presets`
   - `PUT /api/presets/:presetId`
   - `DELETE /api/presets/:presetId`
   - `POST /api/presets/:presetId/runs`

9. Add dashboard write views.
   - `/start`: preset slot, scenario selector, endpoint/personas/rubric
     selects, parallel factor stepper, repeat stepper, dry-run toggle, label,
     and save-as-preset controls.
   - `/presets`: saved presets list with last-run summary.
   - `/presets/:presetId`: preset detail, resolved scenarios, edit affordance,
     and run-again action.
   - `/runs/:runId`: cancel button appears only for active runs and updates
     through SSE.
   - Use native controls and compact dark styling consistent with the existing
     dashboard. Avoid new state-manager dependencies unless profiling shows
     the run builder state is too tangled.

10. Add Docker packaging.
    - Add a root `Dockerfile` with a build stage that runs
      `bun install --frozen-lockfile` and `bun run dashboard:build`.
    - The runtime stage starts
      `bun run ./src/cli/main.ts start-server --host 0.0.0.0 --port 7878 --unsafe-expose`.
    - Config must refuse to boot in that mode unless
      `AGENTPROBE_SERVER_TOKEN` is set.
    - Add `docker-compose.yml` with `127.0.0.1:7878:7878`, `./data:/app/data:ro`,
      `./runs.sqlite:/app/runs.sqlite`, `OPEN_ROUTER_API_KEY`, and required
      `AGENTPROBE_SERVER_TOKEN`.

11. Add `docs/playbooks/agent-probe-server.md`.
    - Local server bring-up.
    - Token-protected external bind.
    - Docker with SQLite-on-volume.
    - Troubleshooting missing dashboard bundle, missing token, missing
      `OPEN_ROUTER_API_KEY`, and SQLite lock errors.
    - Note that Postgres arrives in Phase 3.

12. Add tests.
    - Unit: body validation, selection resolver, run-controller active-run
      conflict, cancellation token checks, preset persistence, and route
      authorization.
    - Integration: start server against temp SQLite and fixture data, post a
      dry-run, subscribe to SSE, poll run detail, cancel a controlled slow run,
      create/edit/delete presets, and run from a preset.
    - E2E: CLI `start-server`, `POST /api/runs` dry-run, wait for completion,
      open report HTML, and verify shutdown.
    - Dashboard: run builder, preset hydration, save-as-preset, cancel button,
      and auth token state.

13. Update product docs and indexes.
    - Mark shipped Phase 2 scenarios in `current-state.md`.
    - Update `e2e-checklist.md` with actual test owners.
    - Run docs index generation for the new playbook.

## Dependencies

- Depends on Phase 1 server boot, auth, read routes, dashboard read views, and
  SSE hub.
- Uses `runSuite` and `SqliteRunRecorder`; both may need carefully scoped
  extension points.
- Docker packaging depends on a working dashboard build.
- Does not depend on Postgres or comparison views.

## Validation

- `bun run docs:validate`
- `bun run test tests/unit/server`
- `bun run test tests/integration/server`
- `bun run test:e2e`
- `bun run dashboard:build`
- `bun run typecheck`
- `bun run fast-feedback`
- Manual smoke:
  start the server with a token, create a preset in the UI, launch a dry-run
  from it, cancel a second controlled run, and verify both records remain in
  `/api/runs`.
- Docker smoke:
  `docker compose up --build` with `AGENTPROBE_SERVER_TOKEN` and
  `OPEN_ROUTER_API_KEY` set, then open `/healthz` and run a dry-run through
  the API.

## Risks And Rollout Notes

- SQLite lock behavior is the main risk once write paths exist. Enable WAL mode
  for server-opened SQLite connections and keep active-run locking conservative.
- Cross-file scenario selection is easy to accidentally degrade into ID-only
  filtering. Tests must include duplicate scenario IDs in different files.
- Do not leak bearer tokens, endpoint auth, or API keys into logs, SSE payloads,
  run snapshots, or dashboard state.
- Keep `agentprobe run --dashboard` unchanged. Its lifecycle remains
  single-run and self-contained.
