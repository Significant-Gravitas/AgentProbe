# AgentProbe Platform Spec

## Overview

AgentProbe is a CLI for validating suites, running repeatable agent evaluations,
recording run artifacts, and rendering reports from local run history.

## Scenarios

### YAML validation succeeds for well-formed data

**Given** a suite directory containing valid endpoint, scenario, persona, and
rubric YAML files
**When** the user runs the validation command against that suite
**Then** the CLI validates the YAML structure, reports which suite files were
processed, and fails fast if the suite contract is invalid

### Evaluation run records ordered results and artifacts

**Given** valid endpoint, scenario, persona, and rubric YAML files
**When** the user runs an evaluation suite
**Then** the CLI executes the selected scenarios, records structured run history
to SQLite, preserves scenario ordering, and emits a summary that agents and
humans can use to inspect pass/fail outcomes

### HTML report renders from recorded run history

**Given** at least one completed run in the local run-history database
**When** the user renders a report for the latest run or an explicit run ID
**Then** the CLI writes an HTML report that includes transcript, score, and run
metadata for debugging and auditability

### Reliability signals exist for critical command paths

**Given** the validation, run, and report commands
**When** the CLI starts, validates a suite, performs endpoint work, persists
artifacts, or renders a report
**Then** structured logs, metrics, and spans exist so agents can diagnose
failures and verify response-time budgets on critical paths
