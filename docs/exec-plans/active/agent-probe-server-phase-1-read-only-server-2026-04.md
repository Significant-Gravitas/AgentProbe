# AgentProbe Server Phase 1: Read-Only Server

## Goal

Ship `agentprobe start-server` as a long-running read-only control plane backed
by SQLite.

This phase proves the server shell, route boundaries, suite discovery, static
dashboard serving, run-history browsing, and SSE framing before write paths are
introduced. It matters because later phases should add run control and presets
to a stable, observable HTTP surface instead of mixing boot mechanics with
evaluation orchestration.

## Decisions

- New server runtime code lives under `src/runtime/server/`.
- `src/cli/main.ts` only parses dispatch and calls the server entrypoint. It
  must not contain route logic.
- Controllers are the only server layer that may import domain modules.
  Routes call controllers; controllers call validation, reporting, evaluation,
  and persistence surfaces.
- Phase 1 is SQLite-only. `AGENTPROBE_DB_URL=sqlite:///...` is accepted;
  `postgres://...` fails with a clear "Phase 3" unsupported-backend error.
- `OPEN_ROUTER_API_KEY` is not required to boot or browse history.
- Auth and binding safety are implemented from the start, even though the
  first phase is read-only.
- The dashboard may use a small local route switch based on `location.pathname`.
  Do not add a router or state-manager dependency in this phase.
- SSE infrastructure lands now, but Phase 1 has no server-owned run producer.
  The endpoint must still have stable framing, auth, replay headers, and tests
  so Phase 2 can publish run events into the same hub.

## Steps

1. Add `src/runtime/server/config.ts`.
   - Parse CLI flags: `--host`, `--port`, `--data`, `--db`,
     `--dashboard-dist`, `--token`, `--unsafe-expose`, `--open`, and
     `--log-format`.
   - Read env fallbacks: `AGENTPROBE_SERVER_HOST`,
     `AGENTPROBE_SERVER_PORT`, `AGENTPROBE_SERVER_DATA`,
     `AGENTPROBE_SERVER_DB`, `AGENTPROBE_SERVER_DASHBOARD_DIST`,
     `AGENTPROBE_SERVER_TOKEN`, and `AGENTPROBE_DB_URL`.
   - Default to `127.0.0.1`, port `7878`, `data`, `runs.sqlite`, and the
     existing dashboard dist path.
   - Reject non-loopback hosts unless `unsafeExpose` is true and a token is
     configured.
   - Normalize the DB URL to `sqlite:///...` for this phase.
   - Validate the suite root exists and is a directory.

2. Add `src/runtime/server/auth/token.ts`.
   - Implement a bearer-token check for `/api/*` and SSE routes.
   - Use constant-time comparison for configured tokens.
   - Return the common JSON error envelope on auth failure.
   - Leave `/healthz`, `/readyz`, and static dashboard assets unauthenticated.

3. Add `src/runtime/server/app-server.ts`.
   - Wrap `Bun.serve` and expose a `startAgentProbeServer(config)` function
     that returns `{ url, stop }`.
   - Install `SIGINT` and `SIGTERM` shutdown handling in the CLI entrypoint.
   - Generate or propagate `x-request-id` per request.
   - Centralize JSON responses, status codes, content type, and error
     envelopes as `{ error: { code, message, details } }`.
   - Log startup, request completion with latency, and shutdown.

4. Add route modules under `src/runtime/server/routes/`.
   - `health.ts`: `GET /healthz` returns uptime, version/build metadata when
     available, and DB-open status. `GET /readyz` returns 200 only after DB open
     and at least one successful suite-root scan.
   - `suites.ts`: `GET /api/suites`, `GET /api/suites/:id/scenarios`, and
     `GET /api/scenarios`.
   - `runs.ts`: `GET /api/runs`, `GET /api/runs/:runId`, and
     `GET /api/runs/:runId/scenarios/:ordinal`.
   - `reports.ts`: `GET /api/runs/:runId/report.html` renders from persisted
     run history using the existing report renderer.
   - `static.ts`: serve the dashboard bundle and SPA fallback.

5. Refactor safe static serving.
   - Export or move the existing `safeStaticPath` logic from
     `src/domains/reporting/dashboard.ts` into a shared reporting/server helper
     without changing the existing `--dashboard` behavior.
   - Preserve directory traversal tests.
   - Set `no-store` on `index.html` and long immutable caching on hashed assets.

6. Add `src/runtime/server/controllers/suite-controller.ts`.
   - Scan the configured `--data` root through existing YAML validation
     helpers.
   - Cache successful scans for 30 seconds.
   - Surface validation errors in the API response rather than persisting them.
   - For `GET /api/scenarios`, return stable scenario refs:
     `{ suite_id, file, id, name, tags, persona, rubric }`.
   - Use paths relative to the configured data root in API payloads.

7. Extend SQLite read helpers if needed.
   - Keep existing `listRuns` and `getRun` callers working.
   - Add optional pagination and filters for `status`, `suite`, `preset`, and
     `since` without changing the default order.
   - Add indexes only if tests or local profiling show list performance needs
     them in this phase.

8. Add `src/runtime/server/streams/hub.ts` and `streams/events.ts`.
   - Define a normalized SSE envelope:
     `{ id, run_id, kind, payload, created_at }`.
   - Keep the last 256 events per run in memory.
   - Honor `Last-Event-ID` replay for buffered events.
   - Send `text/event-stream`, `Cache-Control: no-store`, and
     `X-Accel-Buffering: no` headers.
   - For completed historical runs with no buffered events, emit a snapshot
     summary event and close cleanly.

9. Wire `start-server` into `src/cli/main.ts`.
   - Add a `handleStartServer` branch.
   - Preserve existing `validate`, `list`, `run`, `report`, and `openclaw`
     behavior.
   - Implement `--open` using the existing best-effort browser open helper.

10. Update the dashboard app for read-only server mode.
    - Preserve the existing single-run `--dashboard` route that polls
      `/api/state`.
    - Add views for `/`, `/runs`, `/runs/:runId`,
      `/runs/:runId/scenarios/:ordinal`, `/suites`, and `/settings`.
    - Reuse `StatsBar`, `ScenarioTable`, `AveragesTable`, `DetailPanel`,
      `ConversationView`, and `RubricView`.
    - Add a fetch helper that reads `/api/session`, attaches bearer auth when
      required, and shows a minimal token-entry state when protected.
    - Do not add write controls in Phase 1.

11. Add tests.
    - `tests/unit/server/`: config parsing, unsafe expose validation, auth
      middleware, error envelope, route parsing, static path safety, and SSE
      encoding/replay.
    - `tests/integration/server/`: boot against a temp SQLite DB and fixture
      data root, then hit health, readyz, suites, scenarios, runs, run detail,
      scenario detail, report HTML, and SSE.
    - `tests/e2e/server-e2e.test.ts`: start the CLI server in the background,
      assert the URL responds, then terminate gracefully.
    - Dashboard tests for read-only overview, runs list, and run detail states.

12. Update docs and indexes.
    - Mark Phase 1 scenarios covered in `docs/product-specs/current-state.md`
      only for behavior that actually shipped.
    - Update `docs/product-specs/e2e-checklist.md` with concrete test files.
    - Run docs index generation when new docs files are added or moved.

## Dependencies

- Depends on Phase 0 product scenarios.
- Reuses:
  - `src/domains/validation/load-suite.ts` for suite and scenario parsing.
  - `src/providers/persistence/sqlite-run-history.ts` for run history.
  - `src/domains/reporting/render-report.ts` for HTML reports.
  - `src/domains/reporting/dashboard.ts` components and static path behavior.
  - `dashboard/` React components for read-only UI.
- Does not depend on cancellation, presets, Docker, comparison, or Postgres.

## Validation

- `bun run docs:validate`
- `bun run test tests/unit/server`
- `bun run test tests/integration/server`
- `bun run test:e2e`
- `bun run dashboard:build`
- `bun run typecheck`
- Manual smoke:
  `bun run agentprobe start-server --port 0 --data data --db /tmp/agentprobe-readonly.sqlite`
  then fetch `/healthz`, `/readyz`, `/api/scenarios`, and `/api/runs`.

## Risks And Rollout Notes

- If dashboard routing grows too large, split views into files inside
  `dashboard/src/` before adding a router dependency.
- Keep the single-run `--dashboard` behavior intact. Its `/api/state` polling
  path is not replaced in Phase 1.
- If generated docs are stale because of unrelated workspace files, report that
  separately instead of mixing unrelated inventory changes into this PR.
- PostgreSQL remains explicitly unsupported until Phase 3.
