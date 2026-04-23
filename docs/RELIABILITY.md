# Reliability

## Observability is mandatory

AgentProbe must be debuggable by agents without relying on human intuition.
Critical paths therefore require structured logs, metrics, and spans.

## Required signals

- Structured logs for startup, config loading, validation, run orchestration,
  endpoint traffic, judge traffic, persistence, and report rendering
- Metrics for success/failure counts, latency distributions, retry counts, and
  queue or concurrency pressure where relevant
- Spans around startup, parsing, adapter calls, judge calls, database writes,
  and report generation
- Correlation identifiers that carry run IDs and scenario IDs through logs,
  metrics, and spans

## Performance budgets

The initial repository-level budgets are:

- Cold CLI startup under 500ms
- `validate` under 2s on the fixture suite
- `report` under 2s for the latest local run
- External adapter and judge operations must emit latency metrics and spans so
  slower budgets can be measured and enforced per integration

## Enforcement

- Budgets must be backed by instrumentation, not anecdotes.
- Performance-sensitive paths need tests, benchmarks, or CI-visible checks.
- When a budget changes, update this doc and the validation evidence together.
- Debuggability regressions count as reliability regressions.

## Logging rules

- Prefer structured events over free-form log paragraphs.
- Redact secrets and tokens at the boundary before logging.
- Include the smallest stable identifiers needed for tracing a failure.
- Log enough context to reproduce the path, but not guessed or unvalidated
  payloads.

## Server metrics, spans, and budgets (Phase 4)

The AgentProbe server ships a narrow in-process metrics registry and span
recorder so operators can introspect a running server without depending on an
external collector. All adapters live under
`src/runtime/server/observability/`.

### Shipped counters

| Name | Labels | Purpose |
| --- | --- | --- |
| `server.http.requests` | `method`, `route`, `status` | Per-request volume by outcome. |
| `server.runs.started_total` | `preset` | Runs accepted by the run controller. |
| `server.runs.finished_total` | `preset` | Runs that reached a terminal state. |

### Shipped gauges

| Name | Purpose |
| --- | --- |
| `server.runs.active` | Active runs tracked by the controller. |
| `server.sse.connections` | Open SSE subscribers across all runs. |

### Shipped spans

| Name | Where | Purpose |
| --- | --- | --- |
| `server.run.start.validation` | `RunController.start` | Validates OpenRouter configuration and suite conflicts. |
| `server.run.controller.execute` | `RunController.execute` | End-to-end run execution wrapper. |
| `server.run.suite.boot` | `RunController.execute` | Time from controller accept to first suite/scenario event. |

### Latency budgets

Run `bun run latency-budget --samples 25` to populate these numbers against
seeded local data. Budgets are `p95` unless noted. CI is expected to stay
well below the budget on loopback; degraded values should be investigated
before shipping.

| Surface | Budget (p95) |
| --- | --- |
| `GET /` (dashboard index) | 150 ms |
| `GET /api/runs` | 150 ms |
| `POST /api/runs` (validation rejection) | 200 ms |
| SSE first-event latency | 200 ms |

### SSE hardening contract

- Every SSE response emits `retry: 2000` on connect and periodic heartbeat
  comments every 15 seconds.
- Terminal events (`run_finished`, `run_cancelled`, `run_failed`) are emitted
  exactly once per run and close the stream after dispatch.
- `Last-Event-ID` is honored from both the standard `Last-Event-ID` header and
  the `last_event_id` query parameter.
- Historical runs resolve terminal state on replay even when the ring buffer
  has been dropped.
- Proxy-safe headers (`cache-control: no-store, no-transform`,
  `x-accel-buffering: no`, `connection: keep-alive`) are set on every stream
  response.

### Soak harness

`bun run soak --duration-ms 10000 --runs 50 --sse-connections 3` is the fast
CI mode: it verifies that no active runs, no stuck streams, and no request
failures remain at shutdown. The `--manual` flag extends the defaults to a
~1h soak and emits the run/failure/RSS/event-lag/latency/connection summary
line for PR evidence.
