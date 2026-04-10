# AgentProbe

Agent-first repository for a Bun + TypeScript CLI that runs repeatable agent
evaluations against HTTP, WebSocket, and local harness endpoints.

## Stack

- Runtime contract: Bun + TypeScript
- Current baseline: mixed-language during migration; repo workflows stay Bun-first
- Database contract: SQLite for local run history
- Primary quality gates: docs validation, Bun tests, generated-doc freshness

## Repo map

```text
AgentProbe/
├── src/               # Runtime code and future TypeScript migration target
├── tests/             # Bun e2e harness and legacy baseline tests
├── data/              # Sample endpoints, scenarios, personas, and rubrics
├── docs/              # Source-of-truth knowledge base — start with docs/README.md
├── scripts/           # Validation, doc generation, and repo automation
├── .github/           # CI, PR template, and automation workflows
└── package.json       # Bun entrypoints for repo workflows
```

## Start here

| Need | Source of truth |
| --- | --- |
| Overall docs map | `docs/README.md` |
| Architecture and layers | `docs/ARCHITECTURE.md` |
| Agent-first operating principles | `docs/DESIGN.md` |
| Product behavior contract | `docs/product-specs/platform.md` |
| Planning workflow and debt tracking | `docs/PLANS.md`, `docs/exec-plans/` |
| Reliability, metrics, and latency budgets | `docs/RELIABILITY.md` |
| Security and boundary rules | `docs/SECURITY.md` |
| PR/validation contract | `docs/HARNESS.md` |

## Standard commands

```bash
# Validate docs, indexes, and generated artifacts
bun run docs:validate

# Refresh docs indexes and generated inventories
bun run docs:index
bun run docs:workspace
bun run docs:quality

# Run the Bun-owned test surfaces
bun run test
bun run test:e2e

# Run the repo-wide fast feedback loop before a PR
bun run fast-feedback
```

## Environment

- `OPEN_ROUTER_API_KEY`: required for evaluation-time persona/judge traffic
- `AGENTPROBE_PERSONA_MODEL`: optional persona model override
- `OPENCLAW_GATEWAY_URL`: default OpenClaw gateway URL
- `AUTOGPT_BACKEND_URL`: default local AutoGPT backend URL

## Hard rules

1. Keep this file short. Put durable detail in `docs/`, not here.
2. Treat `docs/` as the system of record. If context only exists in chat, it does not exist.
3. Update `docs/product-specs/platform.md` before implementation when behavior changes.
4. Do not edit generated files in `docs/generated/` by hand; run the generator instead.
5. Prefer Bun entrypoints (`bun run ...`) for repo workflows, even while the migration is mixed.
6. Enforce boundary validation at config, YAML, SDK, and network edges; do not rely on guessed shapes.
7. Preserve layered boundaries and typed SDK/provider interfaces. No transport logic in higher-level business logic.
8. Structured logs, metrics, and spans are required for debugging and latency enforcement on critical paths.
9. Every PR must follow the template and leave enough evidence for the next agent to continue cleanly.
