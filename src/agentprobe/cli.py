from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

import click
import openai

from .data import process_yaml_files
from .db import DEFAULT_DB_DIRNAME, DEFAULT_DB_FILENAME, SqliteRunRecorder
from .endpoints.openclaw import (
    OpenClawGatewayClient,
    load_configured_endpoint,
    openclaw_chat,
    openclaw_history,
)
from .errors import AgentProbeConfigError, AgentProbeRuntimeError
from .report import write_run_report
from .runner import (
    RunResult,
    RunProgressEvent,
    run_suite,
)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def test_data_processing(data_path: str | Path = "data") -> list[str]:
    processed = process_yaml_files(data_path)
    lines = ["Processed YAML files:"]

    for item in processed:
        lines.append(f"- {item.path}: {item.schema} ({item.object_count} objects)")

    return lines


def _format_score(score: float) -> str:
    return f"{score:.2f}"


def _suite_db_url(*paths: Path) -> str:
    common_parent = Path(
        os.path.commonpath([str(path.expanduser().resolve().parent) for path in paths])
    )
    return f"sqlite:///{(common_parent / DEFAULT_DB_DIRNAME / DEFAULT_DB_FILENAME).resolve()}"


def _db_url_from_path(db_path: Path | None) -> str | None:
    if db_path is None:
        return None
    return f"sqlite:///{db_path.expanduser().resolve()}"


def _openai_client_kwargs() -> dict[str, str]:
    openrouter_api_key = os.getenv("OPEN_ROUTER_API_KEY", "").strip()
    if not openrouter_api_key:
        raise AgentProbeConfigError(
            "OPEN_ROUTER_API_KEY is required for `agentprobe run`."
        )

    return {
        "api_key": openrouter_api_key,
        "base_url": OPENROUTER_BASE_URL,
    }


def _print_run_summary(result: RunResult) -> None:
    for scenario_result in result.results:
        status = "PASS" if scenario_result.passed else "FAIL"
        click.echo(
            f"{status} {scenario_result.scenario_id} "
            f"score={_format_score(scenario_result.overall_score)}"
        )
    click.echo(
        f"Summary: {sum(item.passed for item in result.results)} passed, "
        f"{sum(not item.passed for item in result.results)} failed, "
        f"{len(result.results)} total"
    )


def _scenario_label(event: RunProgressEvent) -> str:
    scenario_id = event.scenario_id or "unknown-scenario"
    if event.scenario_name and event.scenario_name != scenario_id:
        return f"{scenario_id} ({event.scenario_name})"
    return scenario_id


def _progress_prefix(event: RunProgressEvent) -> str:
    if event.scenario_index is None or event.scenario_total is None:
        return ""
    return f"[{event.scenario_index}/{event.scenario_total}] "


def _emit_progress_line(message: str) -> None:
    click.echo(message, err=True)
    click.get_text_stream("stderr").flush()


def _print_run_progress(event: RunProgressEvent) -> None:
    if event.kind == "suite_started":
        total = event.scenario_total or 0
        noun = "scenario" if total == 1 else "scenarios"
        _emit_progress_line(f"Running {total} {noun}...")
        return

    prefix = _progress_prefix(event)
    label = _scenario_label(event)
    if event.kind == "scenario_started":
        _emit_progress_line(f"{prefix}RUN {label}")
        return
    if event.kind == "scenario_finished":
        status = "PASS" if event.passed else "FAIL"
        score_text = (
            f" score={_format_score(event.overall_score)}"
            if event.overall_score is not None
            else ""
        )
        _emit_progress_line(f"{prefix}{status} {label}{score_text}")
        return
    if event.kind == "scenario_error":
        error_message = str(event.error) if event.error is not None else "unknown error"
        _emit_progress_line(f"{prefix}ERROR {label}: {error_message}")


@click.group(invoke_without_command=True)
@click.option(
    "--data-path",
    type=click.Path(exists=True, file_okay=True, dir_okay=True, path_type=Path),
    default=Path("data"),
    show_default=True,
    help="Path to a YAML file or a directory of YAML files to process.",
)
@click.pass_context
def cli(ctx: click.Context, data_path: Path) -> None:
    if ctx.invoked_subcommand is not None:
        return

    for line in test_data_processing(data_path):
        click.echo(line)


@cli.command()
@click.option(
    "--data-path",
    type=click.Path(exists=True, file_okay=True, dir_okay=True, path_type=Path),
    default=Path("data"),
    show_default=True,
    help="Path to a YAML file or a directory of YAML files to process.",
)
def validate(data_path: Path) -> None:
    for line in test_data_processing(data_path):
        click.echo(line)


@cli.command()
@click.option(
    "--endpoint",
    "endpoint_path",
    type=click.Path(exists=True, file_okay=True, dir_okay=False, path_type=Path),
    required=True,
    help="Path to the endpoint YAML.",
)
@click.option(
    "--scenarios",
    "scenarios_path",
    type=click.Path(exists=True, file_okay=True, dir_okay=True, path_type=Path),
    required=True,
    help="Path to a scenarios YAML file or a directory of scenario YAML files.",
)
@click.option(
    "--personas",
    "personas_path",
    type=click.Path(exists=True, file_okay=True, dir_okay=False, path_type=Path),
    required=True,
    help="Path to the personas YAML.",
)
@click.option(
    "--rubric",
    "rubric_path",
    type=click.Path(exists=True, file_okay=True, dir_okay=False, path_type=Path),
    required=True,
    help="Path to the rubric YAML.",
)
@click.option(
    "--scenario-id", type=str, default=None, help="Run a single scenario by id."
)
@click.option("--tags", type=str, default=None, help="Comma-separated scenario tags.")
@click.option(
    "--parallel",
    "--parrallel",
    "parallel",
    is_flag=True,
    help="Run matching scenarios concurrently.",
)
@click.option(
    "--dry-run",
    "dry_run",
    is_flag=True,
    help="Validate configuration and resolve scenarios without opening sessions or sending messages.",
)
@click.option(
    "-v", "--verbose",
    count=True,
    help="Increase log verbosity. -v for INFO, -vv for DEBUG.",
)
def run(
    endpoint_path: Path,
    scenarios_path: Path,
    personas_path: Path,
    rubric_path: Path,
    scenario_id: str | None,
    tags: str | None,
    parallel: bool,
    dry_run: bool,
    verbose: int,
) -> None:
    if verbose >= 2:
        log_level = logging.DEBUG
    elif verbose >= 1:
        log_level = logging.INFO
    else:
        log_level = logging.WARNING
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    db_url = _suite_db_url(
        endpoint_path,
        scenarios_path,
        personas_path,
        rubric_path,
    )

    async def execute(recorder: SqliteRunRecorder) -> RunResult:
        async with openai.AsyncClient(**_openai_client_kwargs()) as oai_client:
            return await run_suite(
                endpoint=endpoint_path,
                scenarios=scenarios_path,
                personas=personas_path,
                rubric=rubric_path,
                scenario_id=scenario_id,
                tags=tags,
                oai_client=oai_client,
                recorder=recorder,
                progress_callback=_print_run_progress,
                parallel=parallel,
                dry_run=dry_run,
            )

    try:
        recorder = SqliteRunRecorder(db_url)
        result = asyncio.run(execute(recorder))
    except AgentProbeConfigError as exc:
        click.echo(f"Configuration error: {exc}", err=True)
        raise SystemExit(2) from exc
    except AgentProbeRuntimeError as exc:
        click.echo(f"Runtime error: {exc}", err=True)
        raise SystemExit(3) from exc

    _print_run_summary(result)
    raise SystemExit(result.exit_code)


@cli.command()
@click.option(
    "--run-id",
    type=str,
    default=None,
    help="Run id to render. Defaults to the latest run in the database.",
)
@click.option(
    "--db-path",
    type=click.Path(exists=True, file_okay=True, dir_okay=False, path_type=Path),
    default=None,
    help="Path to the SQLite run-history database.",
)
@click.option(
    "--output",
    "output_path",
    type=click.Path(file_okay=True, dir_okay=False, path_type=Path),
    default=None,
    help="Where to write the HTML report. Defaults to ./agentprobe-report-<run-id>.html.",
)
def report(
    run_id: str | None,
    db_path: Path | None,
    output_path: Path | None,
) -> None:
    try:
        written = write_run_report(
            run_id,
            output_path=output_path,
            db_url=_db_url_from_path(db_path),
        )
    except AgentProbeRuntimeError as exc:
        click.echo(f"Runtime error: {exc}", err=True)
        raise SystemExit(3) from exc

    click.echo(str(written))


@cli.group()
def openclaw() -> None:
    pass


@openclaw.command("create-session")
@click.option(
    "--endpoint",
    "endpoint_path",
    type=click.Path(exists=True, file_okay=True, dir_okay=False, path_type=Path),
    default=Path("data/openclaw-endpoints.yaml"),
    show_default=True,
    help="Path to the OpenClaw endpoint YAML.",
)
@click.option(
    "--session-key",
    type=str,
    default=None,
    help="Reuse or create a specific session key.",
)
@click.option("--label", type=str, default=None, help="Optional session label.")
def openclaw_create_session_command(
    endpoint_path: Path,
    session_key: str | None,
    label: str | None,
) -> None:
    endpoint = load_configured_endpoint(str(endpoint_path))

    async def run() -> dict[str, object]:
        async with OpenClawGatewayClient(endpoint) as client:
            session = await client.create_session(key=session_key, label=label)
            return session.model_dump(exclude_none=True)

    click.echo(json.dumps(asyncio.run(run()), indent=2))


@openclaw.command("chat")
@click.option(
    "--endpoint",
    "endpoint_path",
    type=click.Path(exists=True, file_okay=True, dir_okay=False, path_type=Path),
    default=Path("data/openclaw-endpoints.yaml"),
    show_default=True,
    help="Path to the OpenClaw endpoint YAML.",
)
@click.option(
    "--message", required=True, type=str, help="Message to send to the session."
)
@click.option(
    "--session-key", type=str, default=None, help="Continue an existing conversation."
)
@click.option(
    "--label",
    type=str,
    default=None,
    help="Optional label applied when creating a session.",
)
@click.option(
    "--thinking",
    type=str,
    default=None,
    help="Optional OpenClaw thinking level override.",
)
@click.option(
    "--wait/--no-wait",
    default=True,
    show_default=True,
    help="Wait for the assistant reply.",
)
@click.option(
    "--timeout-ms",
    type=click.IntRange(min=0),
    default=30_000,
    show_default=True,
    help="How long to wait client-side for the final assistant reply.",
)
def openclaw_chat_command(
    endpoint_path: Path,
    message: str,
    session_key: str | None,
    label: str | None,
    thinking: str | None,
    wait: bool,
    timeout_ms: int,
) -> None:
    endpoint = load_configured_endpoint(str(endpoint_path))
    result = asyncio.run(
        openclaw_chat(
            endpoint,
            message=message,
            session_key=session_key,
            label=label,
            thinking=thinking,
            wait_for_reply=wait,
            timeout_ms=timeout_ms,
        )
    )
    click.echo(json.dumps(result.model_dump(exclude_none=True), indent=2))


@openclaw.command("history")
@click.option(
    "--endpoint",
    "endpoint_path",
    type=click.Path(exists=True, file_okay=True, dir_okay=False, path_type=Path),
    default=Path("data/openclaw-endpoints.yaml"),
    show_default=True,
    help="Path to the OpenClaw endpoint YAML.",
)
@click.option("--session-key", required=True, type=str, help="Session key to inspect.")
@click.option(
    "--limit",
    type=click.IntRange(min=1, max=1000),
    default=200,
    show_default=True,
    help="Maximum number of messages to return.",
)
def openclaw_history_command(
    endpoint_path: Path,
    session_key: str,
    limit: int,
) -> None:
    endpoint = load_configured_endpoint(str(endpoint_path))
    history = asyncio.run(
        openclaw_history(
            endpoint,
            session_key=session_key,
            limit=limit,
        )
    )
    click.echo(json.dumps(history.model_dump(exclude_none=True), indent=2))


def main() -> None:
    cli()
