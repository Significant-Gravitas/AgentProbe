# Observability Reference

## Required primitives

- Structured logs
- Metrics with stable names and labels
- Traces/spans around critical workflows
- Correlation identifiers for runs and scenarios

## Critical paths to instrument

- CLI startup
- Config and YAML parsing
- Endpoint/session lifecycle calls
- Judge/model calls
- Persistence writes and reads
- Report rendering

## Why this matters

Observability is not just for production incidents. It is part of the local
agent feedback loop that makes latency requirements and debugging enforceable.
