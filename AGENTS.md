# AgentProbe

Python CLI for running repeatable agent evaluations against HTTP, WebSocket, and local harness endpoints.

## Stack

- Frontend: N/A (CLI tool)
- Backend: Python 3.11+, Click, httpx, OpenAI SDK, Pydantic, SQLAlchemy
- Database: SQLite (via SQLAlchemy)
- Package manager: uv (Hatch build backend)

## Repo map

```text
AgentProbe/
├── src/agentprobe/   # Package source — CLI, runner, simulator, judge, adapters, endpoints
├── tests/            # pytest test suite
├── data/             # Sample endpoint, scenario, persona, and rubric YAML
├── docs/             # Deep docs — start with docs/README.md
├── scripts/          # All standard commands live here
├── dist/             # Built wheel artifacts
└── .github/          # Workflows and PR template
```

## Docs

| What                     | Where                          |
|--------------------------|--------------------------------|
| Architecture             | `docs/ARCHITECTURE.md`         |
| Agent operating contract | `docs/HARNESS.md`              |
| Repo health              | `docs/QUALITY_SCORE.md`        |
| Product behavior spec    | `docs/behaviours/platform.md`  |
| Execution plans          | `docs/exec-plans/`             |

## Standard commands

```bash
# Install dependencies
uv sync --group dev

# Run tests
uv run pytest

# Type check
uv run pyright

# Format check
uvx ruff format --check .

# Validate repo structure and docs
./scripts/validate-repo.sh

# Fast feedback loop (run before every PR)
./scripts/fast-feedback.sh
```

## Environment

- `OPEN_ROUTER_API_KEY`: required for persona simulation and rubric judging
- `AGENTPROBE_PERSONA_MODEL`: optional override, defaults to `moonshotai/kimi-k2.5`
- `OPENCLAW_GATEWAY_URL`: defaults to `ws://127.0.0.1:18789`
- `AUTOGPT_BACKEND_URL`: defaults to `http://localhost:8006`

## Rules

1. Run `./scripts/fast-feedback.sh` before opening a PR. If it fails, fix it.
2. Do not edit generated files in `docs/generated/` by hand — run the generator.
3. Keep this file under 140 lines. Put detail in `docs/`.
4. When behavior changes, update `docs/behaviours/platform.md` first.
5. Every PR must follow the PR template.
6. Use `uv run` to execute project commands — never install globally.
7. Sample YAML lives in `data/` and is not bundled into the wheel.
