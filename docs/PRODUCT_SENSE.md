# Product Sense

## What AgentProbe is for

AgentProbe helps engineers and QA teams run repeatable agent evaluations with
enough structure that failures are diagnosable and improvements are measurable.

## User-facing priorities

- Fast, predictable validation loops
- Clear feedback when a suite is invalid or under-specified
- Inspectable run artifacts, transcripts, scores, and reports
- Deterministic local storage of run history
- Endpoint integrations that feel uniform even when transports differ

## UX rules for the CLI

- Prefer explicit errors over silent fallback behavior.
- Emit concise human-readable summaries and machine-legible artifacts.
- Keep the command surface small and composable.
- Make progress, failures, and latency visible without requiring log spelunking.
- Treat run IDs, scenario IDs, and report paths as durable handles that help
  humans and agents coordinate.

## Product guardrails

- Do not hide behavior changes inside implementation-only docs.
- Update the product spec first when user-visible behavior changes.
- Preserve debuggability as a feature, not a maintenance afterthought.
