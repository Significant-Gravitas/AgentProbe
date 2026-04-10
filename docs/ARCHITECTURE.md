# Architecture

## Overview

AgentProbe is documented as a Bun + TypeScript CLI for repeatable agent
evaluations against HTTP, WebSocket, and local harness endpoints. The design
goal is not just clean runtime code, but code that is legible enough for future
agents to extend without re-learning the system from scratch.

## Layered domain model

Each domain should obey a fixed dependency direction:

```text
types -> config -> sdk/providers -> repositories -> services -> runtime -> cli
```

- `types`: shared schemas, branded IDs, and validated data contracts
- `config`: parsed environment, YAML, and repo configuration
- `sdk/providers`: typed interfaces for OpenAI/OpenRouter, endpoint transports,
  persistence engines, metrics emitters, and log sinks
- `repositories`: local persistence and artifact storage adapters
- `services`: orchestration for validate, run, report, and support workflows
- `runtime`: command handlers, workflows, concurrency helpers, and boot logic
- `cli`: argument parsing, output formatting, and command dispatch only

## Boundary rules

- Dependencies move in one direction only. Lower layers never import higher
  layers.
- External systems are accessed through typed SDK/provider interfaces, not
  ad-hoc `fetch` or WebSocket calls sprinkled through services.
- Transport payloads, YAML, and environment inputs must be parsed at the
  boundary before they enter the domain model.
- CLI output is a presentation concern. Domain services return typed results,
  not preformatted strings.
- Observability is cross-cutting but explicit: logs, metrics, and spans enter
  through provider interfaces so they stay testable and replaceable.

## Target subsystem map

```text
src/
├── cli/              # Top-level commands and output rendering
├── domains/
│   ├── validation/   # Suite/YAML loading and validation
│   ├── evaluation/   # Scenario execution, judging, and scoring
│   ├── reporting/    # Run history querying and report generation
│   └── endpoints/    # Endpoint abstractions and domain-facing contracts
├── providers/
│   ├── sdk/          # OpenAI/OpenRouter and endpoint SDK implementations
│   ├── persistence/  # SQLite and artifact storage implementations
│   └── observability/# Logging, metrics, and span emitters
└── shared/
    ├── types/        # Shared schemas and identifiers
    └── utils/        # Small deterministic helpers only
```

The exact directory layout can evolve during migration, but the dependency
direction and boundary rules are mandatory regardless of file names.

## TypeScript engineering standards

- `tsconfig` must run in strict mode and be clean under `tsc --noEmit`.
- Biome is the baseline formatter/linter for TypeScript surfaces.
- `any` is treated as a temporary escape hatch that must be eliminated quickly.
- Schema validation is required at boundaries; inferred or guessed shapes do not
  count as contracts.
- Prefer small local helpers over opaque third-party wrappers when direct,
  typed code is easier for agents to inspect and maintain.
