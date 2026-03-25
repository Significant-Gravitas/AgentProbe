# AgentProbe

AgentProbe is a Python CLI for running repeatable agent evaluations against HTTP, WebSocket, and local harness endpoints.

Current capabilities in this workspace include:

- YAML parsing for personas, scenarios, rubrics, and endpoint configs
- OpenAI-compatible persona simulation and rubric judging
- Built-in endpoint normalization for AutoGPT, OpenCode, and OpenClaw
- An OpenClaw WebSocket client for session creation, chat, and history
- SQLite run recording for evaluation runs

## Requirements

- Python 3.11+
- [`uv`](https://docs.astral.sh/uv/) for the simplest install and tool workflow
- `OPENAI_API_KEY` for `agentprobe run`

You can use `agentprobe validate` without an OpenAI key. The `openclaw` helper commands also do not require OpenAI.

## Run From The Checkout

Install the project dependencies:

```bash
uv sync
```

Validate the sample YAML in this repo:

```bash
uv run agentprobe validate --data-path data
```

Run the bundled sample suite:

```bash
uv run agentprobe run \
  --endpoint data/openclaw-endpoints.yaml \
  --scenarios data/scenarios.yaml \
  --personas data/personas.yaml \
  --rubric data/rubric.yaml
```

The bundled persona and rubric defaults use OpenRouter-style model IDs. Point the OpenAI-compatible client at OpenRouter before running the sample suite:

```bash
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
export OPENAI_API_KEY="<your-openrouter-api-key>"
```

The sample endpoint above targets an OpenClaw gateway. If you are not running OpenClaw, swap in your own endpoint YAML or one of the other templates under `data/`.

`agentprobe run` writes results to `.agentprobe/runs.sqlite3` under the common parent of the YAML files you pass in.

## Install As A Tool

This project already exposes a console script named `agentprobe`, so it can be installed as a standalone CLI tool.

For local development from this checkout, use an editable tool install:

```bash
cd /path/to/AgentProbe
uv tool install --editable .
```

That gives you a global `agentprobe` command while keeping it linked to your working tree.

For a non-editable install from a built artifact:

```bash
cd /path/to/AgentProbe
uv build
uv tool install dist/agentprobe-*.whl
```

If `agentprobe` is not on your `PATH`, run:

```bash
uv tool update-shell
```

Then restart your shell. On this machine, `uv` reports the tool bin directory as:

```bash
uv tool dir --bin
```

One-off execution without installing also works:

```bash
cd /path/to/AgentProbe
uvx --from . agentprobe --help
```

## Important Packaging Note

The installed CLI is packaged correctly, but the sample YAML files in this repository live in the top-level `data/` directory and are not bundled into the wheel.

That means:

- `agentprobe` installs as a tool
- the sample configs still need to come from this repo checkout, or from your own YAML suite
- if you run the installed tool outside the repo, pass explicit paths such as `--data-path /path/to/AgentProbe/data` or point the CLI at your own files

Example:

```bash
agentprobe validate --data-path /path/to/AgentProbe/data
```

## Commands

Show top-level help:

```bash
agentprobe --help
```

Validate YAML:

```bash
agentprobe validate --data-path /path/to/suite
```

Run a suite:

```bash
agentprobe run \
  --endpoint /path/to/endpoints.yaml \
  --scenarios /path/to/scenarios.yaml \
  --personas /path/to/personas.yaml \
  --rubric /path/to/rubric.yaml
```

Run a single scenario or tag subset:

```bash
agentprobe run \
  --endpoint /path/to/endpoints.yaml \
  --scenarios /path/to/scenarios.yaml \
  --personas /path/to/personas.yaml \
  --rubric /path/to/rubric.yaml \
  --scenario-id refund-policy-basic
```

```bash
agentprobe run \
  --endpoint /path/to/endpoints.yaml \
  --scenarios /path/to/scenarios.yaml \
  --personas /path/to/personas.yaml \
  --rubric /path/to/rubric.yaml \
  --tags smoke,rag
```

Run all matching scenarios concurrently:

```bash
agentprobe run \
  --endpoint /path/to/endpoints.yaml \
  --scenarios /path/to/scenarios.yaml \
  --personas /path/to/personas.yaml \
  --rubric /path/to/rubric.yaml \
  --parallel
```

OpenClaw helpers:

```bash
agentprobe openclaw create-session --endpoint data/openclaw-endpoints.yaml
agentprobe openclaw chat --endpoint data/openclaw-endpoints.yaml --message "hello"
agentprobe openclaw history --endpoint data/openclaw-endpoints.yaml --session-key <key>
```

Render an HTML report for the latest recorded run:

```bash
agentprobe report
```

Render a specific run into a chosen file:

```bash
agentprobe report --run-id <run-id> --output ./agentprobe-report.html
```

## Scenario Authoring

- `role: user` turns are persona-driven by default. The `content` field is rendered and treated as guidance for the persona simulator, not a literal message.
- Set `use_exact_message: true` on a `role: user` turn when the rendered `content` must be sent verbatim.
- After scripted user turns are exhausted, the runner can keep generating follow-up user turns until the persona decides the task is complete or the conversation has stalled, still bounded by `max_turns`.

## Environment

Common environment variables used by the sample configs:

- `OPENAI_API_KEY`: required for persona simulation and rubric judging during `agentprobe run`; use your OpenRouter key when `OPENAI_BASE_URL` points at OpenRouter
- `OPENAI_BASE_URL`: optional OpenAI-compatible base URL override; set to `https://openrouter.ai/api/v1` for the bundled defaults
- `AGENTPROBE_PERSONA_MODEL`: optional override for persona generation, defaults to `moonshotai/kimi-k2.5`
- `OPENCLAW_GATEWAY_URL`: defaults to `ws://127.0.0.1:18789`
- `OPENCLAW_GATEWAY_TOKEN`: optional gateway auth token
- `OPENCODE_BASE_URL`: defaults to `http://127.0.0.1:4096`
- `OPENCODE_SERVER_PASSWORD`: enables synthesized HTTP basic auth for the OpenCode preset
- `OPENCODE_SERVER_USERNAME`: optional OpenCode basic-auth username, defaults to `opencode`
- `AUTOGPT_BACKEND_URL`: defaults to `http://localhost:8006`
- `AUTOGPT_AUTH_MODE`: defaults to `forged`

## Project Layout

- `src/agentprobe/`: package source
- `data/`: sample endpoint, scenario, persona, and rubric YAML
- `tests/`: test suite
- `agentprobe-spec-v0.2.md`: working spec/reference document
