# AgentProbe

AgentProbe is an agent-first repository for a Bun + TypeScript CLI that runs
repeatable evaluations against HTTP, WebSocket, and local harness endpoints.

The repo is being migrated in-place, so some baseline implementation and test
surfaces are still mixed-language. The documentation in this repository defines
the target Bun-first contract and the engineering standards every future change
should reinforce.

## Why this repo is structured this way

- Humans steer by describing intent, reviewing outcomes, and tightening rules.
- Agents execute against repository-local context, not tribal knowledge.
- `AGENTS.md` is the router, not the manual.
- `docs/` is the source of truth for architecture, plans, product specs,
  reliability rules, and quality standards.
- Mechanical checks keep the knowledge base fresh enough for future agent runs.

## Bun-first repo workflows

Use Bun entrypoints for the repository workflow:

```bash
# Validate docs, links, indexes, and generated artifacts
bun run docs:validate

# Refresh generated documentation surfaces
bun run docs:index
bun run docs:workspace
bun run docs:quality

# Run the Bun-owned tests
bun run test
bun run test:e2e

# Run the repo-wide PR loop
bun run fast-feedback
```

## Docs map

- `docs/README.md`: best starting point for the knowledge base
- `docs/ARCHITECTURE.md`: layered domain architecture and dependency rules
- `docs/DESIGN.md`: agent-first principles and repository legibility standards
- `docs/PRODUCT_SENSE.md`: product goals, CLI UX priorities, and scope
- `docs/RELIABILITY.md`: logging, metrics, traces, and latency budgets
- `docs/SECURITY.md`: boundary validation, secret handling, and SDK rules
- `docs/product-specs/platform.md`: canonical product behavior contract
- `docs/PLANS.md`: how active plans, completed plans, and debt are managed

## Engineering contract

- Bun + TypeScript is the canonical runtime contract.
- The target quality gate stack is strict `tsc --noEmit`, Biome, repo-specific
  structural checks, and deterministic test evidence.
- External systems must be accessed through typed SDK/provider interfaces.
- Boundary parsing is required for YAML, config, network payloads, and SDK
  responses. No unchecked `any`, no guessed shapes.
- UTF-8 is the default for committed text files and explicit `"utf8"` is
  required in Bun/Node text I/O.
- Structured logs, metrics, and spans are required on critical paths so agents
  can debug failures and enforce response-time budgets.

## Product priorities

- Fast validation loops for suite authors and agent developers
- Repeatable evaluation runs with inspectable artifacts
- Clear run/report output that supports automated diagnosis
- Strong separation between CLI orchestration, domain logic, persistence, and
  external endpoint integrations

## Current migration note

This docs pass intentionally leads the implementation. The repository contract
is Bun-first even where the legacy baseline has not yet been fully replaced.
When there is a mismatch, update the implementation to meet the docs rather
than relaxing the docs to match incidental legacy structure.
- `data/`: sample endpoint, scenario, persona, and rubric YAML
- `tests/`: test suite
- `agentprobe-spec-v0.2.md`: working spec/reference document
