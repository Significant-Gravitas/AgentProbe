# AgentProbe Server Phase 0: Contract

## Goal

Define the product and test contract for `agentprobe start-server` before
implementation starts.

This phase turns the durable design in
`docs/design-docs/agent-probe-server.md` into behavior scenarios that future
server PRs must satisfy. It matters because the server crosses several
boundaries at once: CLI flags, HTTP APIs, dashboard behavior, persistence,
Docker packaging, auth defaults, and observability. The implementation should
not begin until those behaviors are visible in the repo's product specs and
coverage checklist.

## Decisions

- No runtime code changes ship in this phase.
- `docs/product-specs/platform.md` remains the canonical behavior surface.
  The design doc explains why; the product spec states what users can rely on.
- New scenarios must be precise enough to map onto tests in later phases, but
  they should not prescribe internal class names beyond stable repository
  boundaries.
- Every new scenario added to `platform.md` must also appear in
  `docs/product-specs/current-state.md` and
  `docs/product-specs/e2e-checklist.md`, because
  `scripts/check-behaviour-docs.ts` enforces that consistency.
- Mark the new server scenarios as planned until the implementing phase lands.
  Do not mark them covered in Phase 0.

## Steps

1. Add a "Server control plane" scenario group to
   `docs/product-specs/platform.md`.

2. Add a scenario for the default command boot path:
   `agentprobe start-server` binds `127.0.0.1:7878`, scans `./data`, opens
   `./runs.sqlite`, serves the dashboard bundle, and blocks until shutdown.
   The scenario should also state that `OPEN_ROUTER_API_KEY` is not required
   for read-only history browsing.

3. Add a scenario for exposure safety:
   non-loopback `--host` values require both `--unsafe-expose` and a non-empty
   token from `--token` or `AGENTPROBE_SERVER_TOKEN`. Missing or mismatched
   flags fail before the server starts and must explain the unsafe setting.

4. Add a scenario for read-only HTTP and UI history browsing:
   the server exposes health, readiness, suite discovery, scenario discovery,
   run list, run detail, scenario detail, rendered report HTML, and dashboard
   read-only views from the persisted SQLite history without starting a new
   evaluation.

5. Add a scenario for live events:
   `GET /api/runs/:runId/events` returns SSE envelopes that follow run
   progress, include replay support through `Last-Event-ID`, and fall back to
   persisted run detail for older history.

6. Add a scenario for run control:
   `POST /api/runs` starts an ad-hoc run or a preset-backed run, validates the
   request before entering the evaluation domain, rejects missing
   `OPEN_ROUTER_API_KEY` with `400`, persists server-trigger metadata, and
   redirects the UI to live run detail.

7. Add a scenario for cancellation:
   `POST /api/runs/:runId/cancel` cooperatively stops after the current
   scenario, persists `cancelled` state, and emits a terminal SSE event.

8. Add a scenario for presets:
   operators can save a named cross-file scenario selection plus endpoint,
   personas, rubric, parallel factor, repeat count, and dry-run preference;
   later runs freeze the preset snapshot that existed at launch time.

9. Add a scenario for comparisons:
   operators can compare 2 to 10 historical runs, preferably from the same
   preset, with scenario-aligned pass/fail, score delta, status-change, and
   missing-scenario output.

10. Add a scenario for Docker persistence:
    the Docker image starts the server with safe non-loopback rules, supports
    SQLite on a mounted volume by default, and later supports Postgres through
    `AGENTPROBE_DB_URL` for ephemeral container deployments.

11. Update `docs/product-specs/current-state.md` with every new scenario,
    marked unchecked. Set the "Last validated against" date to the date of the
    Phase 0 PR.

12. Update `docs/product-specs/e2e-checklist.md` with every new scenario and
    the future owner:
    - `tests/e2e/server-e2e.test.ts` for CLI/server smoke coverage.
    - `tests/integration/server/` for real HTTP, SSE, and persistence coverage.
    - `tests/unit/server/` for config, auth, route, and controller behavior.
    - Dashboard component tests for read-only, start, presets, and comparison
      views.

13. Run `bun run docs:index` if any docs index changes are needed.

## Dependencies

- Depends on the approved server design in
  `docs/design-docs/agent-probe-server.md`.
- Must preserve the planning rule in `docs/PLANS.md`: durable behavior changes
  live in docs before implementation.
- No dependency on Bun server code, dashboard route code, Docker assets, or
  persistence migrations.

## Validation

- `bun run docs:validate` passes, or any failure is explained as unrelated
  pre-existing workspace drift.
- `scripts/check-behaviour-docs.ts` finds every new `platform.md` scenario in
  both `current-state.md` and `e2e-checklist.md`.
- A reviewer can map each design phase to at least one product scenario and
  at least one planned test owner.

## Risks And Rollout Notes

- Keep the scenarios high-signal. If the product spec copies the whole design
  doc, later agents will have two sources of truth.
- Do not describe Postgres as shipped in the current state. Phase 3 owns that.
- The Docker scenario should mention the later Postgres path, but Phase 0 must
  not require Postgres tests until Phase 3.
