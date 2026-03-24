from __future__ import annotations

from pathlib import Path

import pytest

from agentprobe.errors import AgentProbeRuntimeError
from agentprobe.report import render_run_report, write_run_report


def build_run() -> dict[str, object]:
    return {
        "run_id": "run-12345678",
        "status": "completed",
        "passed": True,
        "exit_code": 0,
        "preset": "autogpt",
        "started_at": "2026-03-24T15:00:00+00:00",
        "completed_at": "2026-03-24T15:02:00+00:00",
        "source_paths": {
            "endpoint": "/tmp/endpoint.yaml",
            "scenarios": "/tmp/scenarios.yaml",
            "personas": "/tmp/personas.yaml",
            "rubric": "/tmp/rubric.yaml",
        },
        "endpoint_snapshot": {"transport": "http", "preset": "autogpt"},
        "aggregate_counts": {
            "scenario_total": 1,
            "scenario_passed_count": 1,
            "scenario_failed_count": 0,
            "scenario_errored_count": 0,
        },
        "scenarios": [
            {
                "scenario_run_id": 1,
                "ordinal": 0,
                "scenario_id": "refund-policy-basic",
                "scenario_name": "Basic refund policy question",
                "persona_id": "frustrated-customer",
                "rubric_id": "customer-support",
                "status": "completed",
                "passed": True,
                "overall_score": 0.8,
                "pass_threshold": 0.7,
                "judge": {
                    "provider": "openai",
                    "model": "gpt-4.1-mini",
                    "temperature": 0.0,
                    "max_tokens": 4096,
                    "overall_notes": "Clear and empathetic resolution.",
                    "output": {
                        "dimensions": {
                            "task_completion": {
                                "reasoning": "The assistant explained the refund path.",
                                "evidence": ["Mentioned the 30-day policy."],
                                "score": 4,
                            }
                        },
                        "overall_notes": "Clear and empathetic resolution.",
                        "pass": True,
                    },
                },
                "counts": {
                    "turn_count": 3,
                    "assistant_turn_count": 1,
                    "tool_call_count": 1,
                    "checkpoint_count": 1,
                },
                "expectations": {
                    "expected_behavior": "Acknowledge the issue and explain next steps."
                },
                "turns": [
                    {
                        "turn_index": 0,
                        "role": "user",
                        "source": "scenario",
                        "content": "I bought a laptop 3 weeks ago and it is already broken.",
                        "created_at": "2026-03-24T15:00:01+00:00",
                        "usage": None,
                    },
                    {
                        "turn_index": 1,
                        "role": "assistant",
                        "source": "assistant",
                        "content": "You are still within the 30-day return window, and I can help with the refund process.",
                        "created_at": "2026-03-24T15:00:05+00:00",
                        "usage": {"input_tokens": 11, "output_tokens": 22},
                    },
                ],
                "tool_calls": [
                    {
                        "turn_index": 1,
                        "call_order": 1,
                        "name": "lookup_order",
                        "args": {"order_id": "123"},
                        "raw": {"name": "lookup_order"},
                    }
                ],
                "checkpoints": [
                    {
                        "checkpoint_index": 0,
                        "preceding_turn_index": 1,
                        "passed": True,
                        "failures": [],
                        "assertions": [{"response_mentions": "30-day return policy"}],
                    }
                ],
                "target_events": [
                    {
                        "turn_index": 1,
                        "exchange_index": 0,
                        "raw_exchange": {
                            "request": {
                                "url": "http://localhost:8006/api/chat/sessions"
                            },
                            "response": {"status_code": 200},
                        },
                        "latency_ms": 12.4,
                        "usage": {"output_tokens": 22},
                    }
                ],
                "judge_dimension_scores": [
                    {
                        "dimension_id": "task_completion",
                        "dimension_name": "Task Completion",
                        "weight": 0.3,
                        "scale_type": "likert",
                        "scale_points": 5,
                        "raw_score": 4.0,
                        "normalized_score": 0.8,
                        "reasoning": "The assistant addressed the refund request directly.",
                        "evidence": ["Explained the 30-day refund window."],
                    }
                ],
                "error": None,
                "scenario_snapshot": None,
                "started_at": "2026-03-24T15:00:00+00:00",
                "completed_at": "2026-03-24T15:01:00+00:00",
            }
        ],
    }


def test_render_run_report_contains_conversation_and_rubric_breakdown():
    html = render_run_report(build_run())

    assert "tailwindcss.com" in html
    assert "Basic refund policy question" in html
    assert "30-day return window" in html
    assert 'data-open-tab="rubric"' in html
    assert "Task Completion" in html
    assert "The assistant addressed the refund request directly." in html


def test_write_run_report_defaults_to_latest_run(monkeypatch, tmp_path: Path):
    run = build_run()

    monkeypatch.setattr(
        "agentprobe.report.list_runs", lambda **kwargs: [{"run_id": "run-12345678"}]
    )
    monkeypatch.setattr("agentprobe.report.get_run", lambda *args, **kwargs: run)

    output_path = tmp_path / "report.html"
    written = write_run_report(
        output_path=output_path, db_url="sqlite:////tmp/report.sqlite3"
    )

    assert written == output_path.resolve()
    assert output_path.read_text(encoding="utf-8").startswith("<!DOCTYPE html>")


def test_write_run_report_raises_when_no_runs_exist(monkeypatch):
    monkeypatch.setattr("agentprobe.report.list_runs", lambda **kwargs: [])

    with pytest.raises(AgentProbeRuntimeError, match="No recorded runs were found"):
        write_run_report()


def test_write_run_report_uses_latest_discovered_database(monkeypatch, tmp_path: Path):
    run = build_run()
    root_db = "sqlite:////tmp/root/.agentprobe/runs.sqlite3"
    nested_db = "sqlite:////tmp/project/data/.agentprobe/runs.sqlite3"

    monkeypatch.setattr(
        "agentprobe.report._discover_db_urls",
        lambda search_root=None: [root_db, nested_db],
    )

    def fake_list_runs(
        *, db_url: str | None = None, **kwargs: object
    ) -> list[dict[str, object]]:
        if db_url == root_db:
            return []
        if db_url == nested_db:
            return [
                {"run_id": "run-12345678", "started_at": "2026-03-24T15:00:00+00:00"}
            ]
        raise AssertionError(f"Unexpected db_url: {db_url}")

    def fake_get_run(
        run_id: str, *, db_url: str | None = None, **kwargs: object
    ) -> dict[str, object] | None:
        if run_id == "run-12345678" and db_url == nested_db:
            return run
        return None

    monkeypatch.setattr("agentprobe.report.list_runs", fake_list_runs)
    monkeypatch.setattr("agentprobe.report.get_run", fake_get_run)

    output_path = tmp_path / "report.html"
    written = write_run_report(output_path=output_path)

    assert written == output_path.resolve()
    assert "Basic refund policy question" in output_path.read_text(encoding="utf-8")
