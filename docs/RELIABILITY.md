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
