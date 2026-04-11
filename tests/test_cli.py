from __future__ import annotations

from pathlib import Path

import pytest
from click.testing import CliRunner

from agentprobe.cli import cli
from agentprobe.errors import AgentProbeConfigError, AgentProbeRuntimeError
from agentprobe.runner import RunProgressEvent, RunResult, ScenarioRunResult

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"


@pytest.fixture(autouse=True)
def _configure_openrouter_env(monkeypatch):
    monkeypatch.setenv("OPEN_ROUTER_API_KEY", "openrouter-test-key")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)


def create_dummy_paths(tmp_path: Path) -> dict[str, Path]:
    paths = {
        "endpoint": tmp_path / "endpoint.yaml",
        "scenarios": tmp_path / "scenarios.yaml",
        "personas": tmp_path / "personas.yaml",
        "rubric": tmp_path / "rubric.yaml",
    }
    for path in paths.values():
        path.write_text("{}", encoding="utf-8")
    return paths


def test_validate_command_preserves_yaml_processing_summary():
    runner = CliRunner()

    result = runner.invoke(cli, ["validate", "--data-path", str(DATA_DIR)])

    assert result.exit_code == 0
    assert "Processed YAML files:" in result.output
    assert "openclaw-endpoints.yaml" in result.output


def test_run_command_returns_pass_exit_code(monkeypatch, tmp_path: Path):
    async def fake_run_suite(**kwargs: object) -> RunResult:
        return RunResult(
            passed=True,
            exit_code=0,
            results=[
                ScenarioRunResult(
                    scenario_id="smoke-scenario",
                    scenario_name="Smoke",
                    persona_id="business-traveler",
                    rubric_id="customer-support",
                    passed=True,
                    overall_score=0.8,
                )
            ],
        )

    monkeypatch.setattr("agentprobe.cli.run_suite", fake_run_suite)
    paths = create_dummy_paths(tmp_path)
    runner = CliRunner()

    result = runner.invoke(
        cli,
        [
            "run",
            "--endpoint",
            str(paths["endpoint"]),
            "--scenarios",
            str(paths["scenarios"]),
            "--personas",
            str(paths["personas"]),
            "--rubric",
            str(paths["rubric"]),
        ],
    )

    assert result.exit_code == 0
    assert "PASS smoke-scenario score=0.80" in result.output


def test_run_command_uses_openrouter_env_fallback(monkeypatch, tmp_path: Path):
    captured: dict[str, object] = {}

    class FakeAsyncClient:
        def __init__(self, **kwargs: object) -> None:
            captured["kwargs"] = kwargs

        async def __aenter__(self) -> object:
            return object()

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

    async def fake_run_suite(**kwargs: object) -> RunResult:
        return RunResult(passed=True, exit_code=0, results=[])

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.setenv("OPEN_ROUTER_API_KEY", "openrouter-test-key")
    monkeypatch.setattr("agentprobe.cli.openai.AsyncClient", FakeAsyncClient)
    monkeypatch.setattr("agentprobe.cli.run_suite", fake_run_suite)
    paths = create_dummy_paths(tmp_path)
    runner = CliRunner()

    result = runner.invoke(
        cli,
        [
            "run",
            "--endpoint",
            str(paths["endpoint"]),
            "--scenarios",
            str(paths["scenarios"]),
            "--personas",
            str(paths["personas"]),
            "--rubric",
            str(paths["rubric"]),
        ],
    )

    assert result.exit_code == 0
    assert captured["kwargs"] == {
        "api_key": "openrouter-test-key",
        "base_url": "https://openrouter.ai/api/v1",
    }


def test_run_command_ignores_openai_env_and_uses_openrouter_only(
    monkeypatch, tmp_path: Path
):
    captured: dict[str, object] = {}

    class FakeAsyncClient:
        def __init__(self, **kwargs: object) -> None:
            captured["kwargs"] = kwargs

        async def __aenter__(self) -> object:
            return object()

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

    async def fake_run_suite(**kwargs: object) -> RunResult:
        return RunResult(passed=True, exit_code=0, results=[])

    monkeypatch.setenv("OPENAI_API_KEY", "openai-test-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.openai.example/v1")
    monkeypatch.setenv("OPEN_ROUTER_API_KEY", "openrouter-test-key")
    monkeypatch.setattr("agentprobe.cli.openai.AsyncClient", FakeAsyncClient)
    monkeypatch.setattr("agentprobe.cli.run_suite", fake_run_suite)
    paths = create_dummy_paths(tmp_path)
    runner = CliRunner()

    result = runner.invoke(
        cli,
        [
            "run",
            "--endpoint",
            str(paths["endpoint"]),
            "--scenarios",
            str(paths["scenarios"]),
            "--personas",
            str(paths["personas"]),
            "--rubric",
            str(paths["rubric"]),
        ],
    )

    assert result.exit_code == 0
    assert captured["kwargs"] == {
        "api_key": "openrouter-test-key",
        "base_url": "https://openrouter.ai/api/v1",
    }


def test_run_command_requires_openrouter_key_even_if_openai_env_exists(
    monkeypatch, tmp_path: Path
):
    monkeypatch.delenv("OPEN_ROUTER_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "openai-test-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.openai.example/v1")
    paths = create_dummy_paths(tmp_path)
    runner = CliRunner()

    result = runner.invoke(
        cli,
        [
            "run",
            "--endpoint",
            str(paths["endpoint"]),
            "--scenarios",
            str(paths["scenarios"]),
            "--personas",
            str(paths["personas"]),
            "--rubric",
            str(paths["rubric"]),
        ],
    )

    assert result.exit_code == 2
    assert "Configuration error: OPEN_ROUTER_API_KEY is required" in result.output


def test_run_command_returns_fail_exit_code(monkeypatch, tmp_path: Path):
    async def fake_run_suite(**kwargs: object) -> RunResult:
        return RunResult(
            passed=False,
            exit_code=1,
            results=[
                ScenarioRunResult(
                    scenario_id="regression-scenario",
                    scenario_name="Regression",
                    persona_id="business-traveler",
                    rubric_id="customer-support",
                    passed=False,
                    overall_score=0.4,
                )
            ],
        )

    monkeypatch.setattr("agentprobe.cli.run_suite", fake_run_suite)
    paths = create_dummy_paths(tmp_path)
    runner = CliRunner()

    result = runner.invoke(
        cli,
        [
            "run",
            "--endpoint",
            str(paths["endpoint"]),
            "--scenarios",
            str(paths["scenarios"]),
            "--personas",
            str(paths["personas"]),
            "--rubric",
            str(paths["rubric"]),
        ],
    )

    assert result.exit_code == 1
    assert "FAIL regression-scenario score=0.40" in result.output


def test_run_command_emits_live_progress_to_stderr(monkeypatch, tmp_path: Path):
    async def fake_run_suite(**kwargs: object) -> RunResult:
        progress_callback = kwargs["progress_callback"]
        assert callable(progress_callback)
        progress_callback(RunProgressEvent(kind="suite_started", scenario_total=1))
        progress_callback(
            RunProgressEvent(
                kind="scenario_started",
                scenario_id="smoke-scenario",
                scenario_name="Smoke",
                scenario_index=1,
                scenario_total=1,
            )
        )
        progress_callback(
            RunProgressEvent(
                kind="scenario_finished",
                scenario_id="smoke-scenario",
                scenario_name="Smoke",
                scenario_index=1,
                scenario_total=1,
                passed=True,
                overall_score=0.8,
            )
        )
        return RunResult(
            passed=True,
            exit_code=0,
            results=[
                ScenarioRunResult(
                    scenario_id="smoke-scenario",
                    scenario_name="Smoke",
                    persona_id="business-traveler",
                    rubric_id="customer-support",
                    passed=True,
                    overall_score=0.8,
                )
            ],
        )

    monkeypatch.setattr("agentprobe.cli.run_suite", fake_run_suite)
    paths = create_dummy_paths(tmp_path)
    runner = CliRunner()

    result = runner.invoke(
        cli,
        [
            "run",
            "--endpoint",
            str(paths["endpoint"]),
            "--scenarios",
            str(paths["scenarios"]),
            "--personas",
            str(paths["personas"]),
            "--rubric",
            str(paths["rubric"]),
        ],
    )

    assert result.exit_code == 0
    assert "Running 1 scenario..." in result.output
    assert "[1/1] RUN smoke-scenario (Smoke)" in result.output
    assert "[1/1] PASS smoke-scenario (Smoke) score=0.80" in result.output


def test_run_command_forwards_parallel_flag(monkeypatch, tmp_path: Path):
    async def fake_run_suite(**kwargs: object) -> RunResult:
        assert kwargs["parallel"] is True
        return RunResult(
            passed=True,
            exit_code=0,
            results=[
                ScenarioRunResult(
                    scenario_id="smoke-scenario",
                    scenario_name="Smoke",
                    persona_id="business-traveler",
                    rubric_id="customer-support",
                    passed=True,
                    overall_score=0.8,
                )
            ],
        )

    monkeypatch.setattr("agentprobe.cli.run_suite", fake_run_suite)
    paths = create_dummy_paths(tmp_path)
    runner = CliRunner()

    result = runner.invoke(
        cli,
        [
            "run",
            "--endpoint",
            str(paths["endpoint"]),
            "--scenarios",
            str(paths["scenarios"]),
            "--personas",
            str(paths["personas"]),
            "--rubric",
            str(paths["rubric"]),
            "--parrallel",
        ],
    )

    assert result.exit_code == 0
    assert "PASS smoke-scenario score=0.80" in result.output


def test_run_command_accepts_scenarios_directory(monkeypatch, tmp_path: Path):
    async def fake_run_suite(**kwargs: object) -> RunResult:
        assert kwargs["scenarios"] == scenarios_dir
        return RunResult(
            passed=True,
            exit_code=0,
            results=[
                ScenarioRunResult(
                    scenario_id="smoke-scenario",
                    scenario_name="Smoke",
                    persona_id="business-traveler",
                    rubric_id="customer-support",
                    passed=True,
                    overall_score=0.8,
                )
            ],
        )

    monkeypatch.setattr("agentprobe.cli.run_suite", fake_run_suite)
    paths = create_dummy_paths(tmp_path)
    scenarios_dir = tmp_path / "scenarios"
    scenarios_dir.mkdir()
    (scenarios_dir / "smoke.yaml").write_text("scenarios: []", encoding="utf-8")
    runner = CliRunner()

    result = runner.invoke(
        cli,
        [
            "run",
            "--endpoint",
            str(paths["endpoint"]),
            "--scenarios",
            str(scenarios_dir),
            "--personas",
            str(paths["personas"]),
            "--rubric",
            str(paths["rubric"]),
        ],
    )

    assert result.exit_code == 0
    assert "PASS smoke-scenario score=0.80" in result.output


def test_run_command_returns_config_error_exit_code(monkeypatch, tmp_path: Path):
    async def fake_run_suite(**kwargs: object) -> RunResult:
        raise AgentProbeConfigError("bad config")

    monkeypatch.setattr("agentprobe.cli.run_suite", fake_run_suite)
    paths = create_dummy_paths(tmp_path)
    runner = CliRunner()

    result = runner.invoke(
        cli,
        [
            "run",
            "--endpoint",
            str(paths["endpoint"]),
            "--scenarios",
            str(paths["scenarios"]),
            "--personas",
            str(paths["personas"]),
            "--rubric",
            str(paths["rubric"]),
        ],
    )

    assert result.exit_code == 2
    assert "Configuration error: bad config" in result.output


def test_run_command_returns_runtime_error_exit_code(monkeypatch, tmp_path: Path):
    async def fake_run_suite(**kwargs: object) -> RunResult:
        raise AgentProbeRuntimeError("endpoint down")

    monkeypatch.setattr("agentprobe.cli.run_suite", fake_run_suite)
    paths = create_dummy_paths(tmp_path)
    runner = CliRunner()

    result = runner.invoke(
        cli,
        [
            "run",
            "--endpoint",
            str(paths["endpoint"]),
            "--scenarios",
            str(paths["scenarios"]),
            "--personas",
            str(paths["personas"]),
            "--rubric",
            str(paths["rubric"]),
        ],
    )

    assert result.exit_code == 3
    assert "Runtime error: endpoint down" in result.output


def test_report_command_writes_html(monkeypatch, tmp_path: Path):
    output_path = tmp_path / "report.html"
    db_path = tmp_path / "runs.sqlite3"
    db_path.write_text("", encoding="utf-8")
    calls: dict[str, object] = {}

    def fake_write_run_report(
        run_id: str | None = None,
        *,
        output_path: Path | None = None,
        db_url: str | None = None,
    ) -> Path:
        calls["run_id"] = run_id
        calls["output_path"] = output_path
        calls["db_url"] = db_url
        assert output_path is not None
        output_path.write_text("<!DOCTYPE html><title>Report</title>", encoding="utf-8")
        return output_path

    monkeypatch.setattr("agentprobe.cli.write_run_report", fake_write_run_report)
    runner = CliRunner()

    result = runner.invoke(
        cli,
        [
            "report",
            "--run-id",
            "run-123",
            "--db-path",
            str(db_path),
            "--output",
            str(output_path),
        ],
    )

    assert result.exit_code == 0
    assert str(output_path) in result.output
    assert calls == {
        "run_id": "run-123",
        "output_path": output_path,
        "db_url": f"sqlite:///{db_path.resolve()}",
    }


# ---------------------------------------------------------------------------
# Gap-coverage tests for the --dashboard flag, verbose flag, and --repeat.
# ---------------------------------------------------------------------------


def _invoke_run_with_args(
    monkeypatch,
    tmp_path: Path,
    *,
    extra_args: list[str],
    captured_kwargs: dict[str, object] | None = None,
):
    async def fake_run_suite(**kwargs: object) -> RunResult:
        if captured_kwargs is not None:
            captured_kwargs.update(kwargs)
        # Exercise the progress callback so dashboard state updates run.
        cb = kwargs.get("progress_callback")
        if callable(cb):
            cb(RunProgressEvent(kind="suite_started", scenario_total=1))
            cb(
                RunProgressEvent(
                    kind="scenario_finished",
                    scenario_id="s1",
                    scenario_name="S1",
                    passed=True,
                    overall_score=0.9,
                )
            )
        return RunResult(
            passed=True,
            exit_code=0,
            results=[
                ScenarioRunResult(
                    scenario_id="s1",
                    scenario_name="S1",
                    persona_id="p",
                    rubric_id="r",
                    passed=True,
                    overall_score=0.9,
                )
            ],
        )

    monkeypatch.setattr("agentprobe.cli.run_suite", fake_run_suite)
    paths = create_dummy_paths(tmp_path)
    runner = CliRunner()
    return runner.invoke(
        cli,
        [
            "run",
            "--endpoint", str(paths["endpoint"]),
            "--scenarios", str(paths["scenarios"]),
            "--personas", str(paths["personas"]),
            "--rubric", str(paths["rubric"]),
            *extra_args,
        ],
    )


def test_run_command_dashboard_flag_starts_server_and_opens_browser(
    monkeypatch, tmp_path: Path
):
    from agentprobe.dashboard import DashboardState

    started: list[str] = []
    opened: list[str] = []
    update_calls: list[object] = []

    class FakeDashboardServer:
        def __init__(self, state: DashboardState) -> None:
            self.state = state
            self.url = "http://127.0.0.1:12345"
            # Patch state.update to record calls so we know _progress wired it.
            orig = state.update

            def tracked(event: RunProgressEvent) -> None:
                update_calls.append(event.kind)
                orig(event)

            state.update = tracked  # type: ignore[method-assign]

        def start(self) -> None:
            started.append(self.url)

        def shutdown(self) -> None:
            started.append("shutdown")

    monkeypatch.setattr("agentprobe.cli.DashboardServer", FakeDashboardServer)
    monkeypatch.setattr(
        "webbrowser.open", lambda url: (opened.append(url), True)[1]
    )

    result = _invoke_run_with_args(
        monkeypatch, tmp_path, extra_args=["--dashboard"]
    )
    assert result.exit_code == 0, result.output
    assert started == ["http://127.0.0.1:12345"]
    assert opened == ["http://127.0.0.1:12345"]
    assert "suite_started" in update_calls
    assert "scenario_finished" in update_calls


def test_run_command_dashboard_flag_handles_missing_build(monkeypatch, tmp_path: Path):
    class BrokenDashboardServer:
        def __init__(self, state) -> None:
            raise FileNotFoundError("no build")

    monkeypatch.setattr("agentprobe.cli.DashboardServer", BrokenDashboardServer)
    monkeypatch.setattr("webbrowser.open", lambda url: True)

    result = _invoke_run_with_args(
        monkeypatch, tmp_path, extra_args=["--dashboard"]
    )
    # Should not crash; just warns and proceeds.
    assert result.exit_code == 0, result.output
    assert "Dashboard unavailable" in result.output + (result.stderr or "")


def test_run_command_verbose_flags_select_log_level(monkeypatch, tmp_path: Path):
    import logging

    captured: dict[str, object] = {}
    orig_basic = logging.basicConfig

    def spy_basic_config(**kwargs):
        captured.setdefault("calls", []).append(kwargs.get("level"))
        orig_basic(**kwargs)

    monkeypatch.setattr("logging.basicConfig", spy_basic_config)

    _invoke_run_with_args(monkeypatch, tmp_path, extra_args=["-v"])
    _invoke_run_with_args(monkeypatch, tmp_path, extra_args=["-vv"])
    _invoke_run_with_args(monkeypatch, tmp_path, extra_args=[])

    levels = captured["calls"]
    assert logging.INFO in levels
    assert logging.DEBUG in levels
    assert logging.WARNING in levels


def test_run_command_repeat_option_forwards_to_run_suite(monkeypatch, tmp_path: Path):
    captured: dict[str, object] = {}
    result = _invoke_run_with_args(
        monkeypatch,
        tmp_path,
        extra_args=["--repeat", "4"],
        captured_kwargs=captured,
    )
    assert result.exit_code == 0, result.output
    assert captured["repeat"] == 4
