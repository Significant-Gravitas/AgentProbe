# AgentProbe Server Phase 4: Polish And Observability

## Goal

Harden the server for long-running daily use: keyboard navigation, SSE
reconnect behavior, metrics and spans, latency-budget evidence, soak testing,
and operational documentation.

This phase converts the functional server into something operators and future
agents can trust over longer sessions.

## Decisions

- Phase 4 does not add major product surfaces. It hardens the surfaces shipped
  in Phases 1 through 3.
- Metrics and spans follow `docs/RELIABILITY.md` and
  `docs/references/observability.md`.
- The soak harness must have a short CI mode and a longer local/manual mode.
- Keyboard shortcuts should improve navigation without hiding required actions.
  Every shortcut-backed action still needs a visible control.
- SSE reconnect behavior stays server-driven and standards-based:
  event IDs, `Last-Event-ID`, heartbeat comments, and replay from the in-memory
  ring buffer.

## Steps

1. Harden SSE behavior.
   - Add heartbeat comments on idle streams.
   - Tune replay handling for `Last-Event-ID`.
   - Add reconnect tests where the client disconnects mid-run and receives
     missed buffered events.
   - Add explicit terminal events for finished, failed, and cancelled runs.
   - Ensure proxy-friendly headers remain on every SSE response.

2. Add request and run observability.
   - Log startup config with secrets redacted.
   - Log request receive and response with method, route, status, latency, and
     `x-request-id`.
   - Include `runId` and preset ID in run-controller logs.
   - Add counters and gauges:
     `server.http.requests`, `server.runs.active`,
     `server.runs.started_total`, `server.runs.finished_total`, and
     `server.sse.connections`.
   - Add spans around run start validation, controller work, and `runSuite`
     boot.
   - Keep metric and span adapters narrow so the repo can run without an
     external collector.

3. Promote latency budgets into checks.
   - Measure static asset serving, `/api/runs`, `POST /api/runs`, and SSE
     first-event latency.
   - Add a test or script that can run against seeded local data and print
     p95s.
   - Record the initial budgets in `docs/RELIABILITY.md` when the checks exist.
   - Fail CI only on deterministic local checks; keep long-running budget
     checks as manual evidence if they are noisy.

4. Add soak-test harness.
   - Add a synthetic endpoint or dry-run-based mode that can exercise the
     server without external model calls.
   - CI mode should run quickly and verify no obvious leaks or stuck active
     runs.
   - Manual mode should run for about one hour, repeatedly launching runs,
     reconnecting SSE clients, browsing history, and rendering reports.
   - Emit a concise summary: run count, failures, memory trend, event lag,
     request latency, and open connections at shutdown.

5. Polish dashboard navigation.
   - Add keyboard shortcuts from the design:
     `j`/`k` through lists, `/` to focus search, and `g r` to go to runs.
   - Add visible focus states and accessible labels.
   - Preserve normal typing behavior in inputs, textareas, and selects.
   - Add tests for shortcut routing and focus behavior.

6. Polish dashboard resilience.
   - Empty states for no runs, no presets, no comparison changes, and missing
     scenario references.
   - Error states for auth failure, server unavailable, invalid compare links,
     and run-start rejection.
   - Loading states that do not shift table layout.
   - Check compact desktop and narrow mobile layouts for text overflow and
     incoherent overlap.

7. Finish operational docs.
   - Update `docs/playbooks/agent-probe-server.md` with proxy SSE notes,
     nginx buffering guidance, backup and restore, migration recovery,
     dashboard cache behavior, and troubleshooting by request ID.
   - Update `docs/RELIABILITY.md` with shipped metrics, spans, and latency
     budgets.
   - Update product spec coverage docs for Phase 4 behavior.

8. Add final regression coverage.
   - Unit tests for metrics adapters, redaction, keyboard handler behavior, and
     SSE ring-buffer edge cases.
   - Integration tests for reconnect and observability payloads.
   - Dashboard component tests for empty/error states and keyboard navigation.
   - A manual verification checklist in the PR description for visual layout
     across desktop and mobile widths.

## Dependencies

- Depends on functional server read paths from Phase 1.
- Depends on run control and preset workflows from Phase 2.
- Depends on comparison and backend selection from Phase 3 for the full
  operational playbook.
- Does not block the first end-to-end server release unless a Phase 1-3 bug is
  severe enough to require immediate hardening.

## Validation

- `bun run docs:validate`
- `bun run test`
- `bun run test:e2e`
- `bun run dashboard:build`
- `bun run typecheck`
- `bun run fast-feedback`
- Short soak/observability script in CI mode.
- Manual one-hour soak in local mode, with summary attached to the PR.
- Manual dashboard pass at desktop and mobile widths for runs, start, presets,
  compare, settings, empty states, and auth state.

## Risks And Rollout Notes

- Metrics should not create a required external dependency for local users.
- Long soak tests can be flaky if they depend on external model traffic. Prefer
  synthetic or dry-run fixtures for repeatable evidence.
- Keyboard shortcuts must not conflict with form input. Tests should cover that
  explicitly.
- Avoid broad refactors in this phase. The goal is hardening and evidence, not
  a new server architecture.
