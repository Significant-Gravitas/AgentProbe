from __future__ import annotations

from pathlib import Path

from click.testing import CliRunner

from agentprobe.cli import cli
from agentprobe.errors import AgentProbeConfigError, AgentProbeRuntimeError
from agentprobe.runner import RunProgressEvent, RunResult, ScenarioRunResult

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"


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
