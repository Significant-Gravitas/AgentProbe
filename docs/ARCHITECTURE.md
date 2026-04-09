# Architecture

## Overview

AgentProbe is a Python CLI tool for running structured, repeatable evaluations against agent endpoints over HTTP, WebSocket, and local harnesses.

## Module boundaries

```text
┌───────────┐
│   cli.py  │  Click CLI entry point
└─────┬─────┘
      │
┌─────▼─────┐     ┌──────────────┐
│ runner.py  │────▶│ simulator.py │  Persona-driven conversation generation
└─────┬─────┘     └──────────────┘
      │
      ├──────────▶ judge.py         Rubric-based evaluation via LLM
      │
      ├──────────▶ adapters.py      Normalize endpoint responses
      │
      ├──────────▶ endpoints/       Endpoint-specific clients (AutoGPT, OpenCode, OpenClaw)
      │
      ├──────────▶ db.py            SQLite run recording via SQLAlchemy
      │
      └──────────▶ report.py        HTML report rendering via Jinja2
                   rendering.py     Template helpers

┌──────────────┐
│   data/      │  Pydantic models for YAML schemas (personas, scenarios, rubrics, endpoints)
└──────────────┘
```

## Dependency direction

- `cli.py` depends on `runner.py` and `report.py`.
- `runner.py` depends on `simulator.py`, `judge.py`, `adapters.py`, `endpoints/`, and `db.py`.
- `endpoints/` each implement a common interface from `endpoints/_common.py`.
- `data/` models are used everywhere — they are the shared contract.
- `db.py` has no upstream dependencies beyond SQLAlchemy.

## Key conventions

- All external API calls go through the OpenAI SDK pointed at OpenRouter.
- YAML files under `data/` define the evaluation suite; they are not bundled in the wheel.
- Endpoint adapters normalize diverse APIs into a uniform conversation interface.
