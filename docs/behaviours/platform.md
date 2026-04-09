# AgentProbe — Platform Behavior Spec

## Overview

AgentProbe is a CLI tool that evaluates AI agent endpoints by simulating multi-turn conversations driven by personas, then scoring the agent's responses against rubrics. Used by developers and QA teams to benchmark agent quality.

## Scenarios

### YAML validation succeeds for well-formed data

**Given** a data directory containing valid persona, scenario, rubric, and endpoint YAML files
**When** the user runs `agentprobe validate --data-path <dir>`
**Then** validation passes with no errors and all files are parsed into Pydantic models

### Single-scenario evaluation run completes

**Given** valid endpoint, scenario, persona, and rubric YAML files
**When** the user runs `agentprobe run` with `--scenario-id` targeting one scenario
**Then** a multi-turn conversation is generated via the persona simulator, the agent endpoint is called for each turn, the judge scores the conversation against the rubric, and results are recorded to SQLite

### HTML report renders from recorded run

**Given** at least one completed evaluation run in the SQLite database
**When** the user runs `agentprobe report`
**Then** an HTML report is generated showing conversation turns, scores, and metadata

---

_Add new scenarios here as the product grows. Each scenario should be concrete and testable._
