"""Tests for the live dashboard state + HTTP server in dashboard.py."""
from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path
from typing import Any

import pytest

from agentprobe import dashboard as dashboard_module
from agentprobe.dashboard import (
    DashboardServer,
    DashboardState,
    _DashboardHandler,
    _load_db_scenarios,
    _serialize_state,
)
from agentprobe.runner import RunProgressEvent


def _make_event(kind: str, **kwargs: Any) -> RunProgressEvent:
    return RunProgressEvent(kind=kind, **kwargs)  # type: ignore[arg-type]


def test_dashboard_state_suite_started_sets_total_and_run_id() -> None:
    state = DashboardState()
    state.update(
        _make_event("suite_started", scenario_total=5, run_id="run-abc")
    )
    assert state.total == 5
    assert state.run_id == "run-abc"


def test_dashboard_state_suite_started_without_run_id_leaves_run_id_none() -> None:
    state = DashboardState()
    state.update(_make_event("suite_started", scenario_total=2))
    assert state.total == 2
    assert state.run_id is None


def test_dashboard_state_scenario_started_sets_running_and_timestamps() -> None:
    state = DashboardState()
    state.update(
        _make_event(
            "scenario_started",
            scenario_id="s1",
            scenario_name="Scenario 1",
        )
    )
    s = state.scenarios["s1"]
    assert s.status == "running"
    assert s.started_at is not None
    assert s.scenario_name == "Scenario 1"
    assert state.running == 1


def test_dashboard_state_scenario_finished_pass_and_fail() -> None:
    state = DashboardState()
    state.update(_make_event("scenario_started", scenario_id="s1"))
    state.update(
        _make_event(
            "scenario_finished",
            scenario_id="s1",
            passed=True,
            overall_score=0.9,
        )
    )
    assert state.scenarios["s1"].status == "pass"
    assert state.scenarios["s1"].score == 0.9
    assert state.scenarios["s1"].finished_at is not None
    assert state.passed == 1

    state.update(_make_event("scenario_started", scenario_id="s2"))
    state.update(
        _make_event(
            "scenario_finished",
            scenario_id="s2",
            passed=False,
            overall_score=0.3,
        )
    )
    assert state.scenarios["s2"].status == "fail"
    assert state.failed == 1


def test_dashboard_state_scenario_error_records_error_string() -> None:
    state = DashboardState()
    state.update(
        _make_event(
            "scenario_error",
            scenario_id="s1",
            error=RuntimeError("boom"),
        )
    )
    s = state.scenarios["s1"]
    assert s.status == "error"
    assert s.error == "boom"
    assert s.finished_at is not None
    assert state.errored == 1


def test_dashboard_state_scenario_error_without_error_leaves_none() -> None:
    state = DashboardState()
    state.update(
        _make_event("scenario_error", scenario_id="s1", error=None)
    )
    assert state.scenarios["s1"].error is None


def test_dashboard_state_unknown_scenario_id_falls_back_to_unknown() -> None:
    state = DashboardState()
    state.update(_make_event("scenario_started"))
    assert "unknown" in state.scenarios


def test_dashboard_state_ordered_scenarios_preserves_insertion_order() -> None:
    state = DashboardState()
    for sid in ("b", "a", "c"):
        state.update(_make_event("scenario_started", scenario_id=sid))
    assert [s.scenario_id for s in state.ordered_scenarios] == ["b", "a", "c"]


def test_dashboard_state_done_and_elapsed() -> None:
    state = DashboardState()
    state.update(_make_event("suite_started", scenario_total=3))
    state.update(_make_event("scenario_started", scenario_id="s1"))
    state.update(
        _make_event(
            "scenario_finished", scenario_id="s1", passed=True, overall_score=1.0
        )
    )
    state.update(_make_event("scenario_started", scenario_id="s2"))
    state.update(
        _make_event(
            "scenario_finished", scenario_id="s2", passed=False, overall_score=0.2
        )
    )
    state.update(
        _make_event("scenario_error", scenario_id="s3", error=ValueError("x"))
    )
    assert state.done == 3
    assert state.elapsed_seconds >= 0.0


def test_load_db_scenarios_noop_when_no_db_or_run(monkeypatch: pytest.MonkeyPatch) -> None:
    state = DashboardState()
    assert _load_db_scenarios(state) == {}
    state.db_url = "sqlite:///:memory:"
    assert _load_db_scenarios(state) == {}
    state.run_id = "run-x"

    def fake_get_run(run_id: str, **kwargs: object) -> None:
        return None

    monkeypatch.setattr("agentprobe.db.get_run", fake_get_run)
    assert _load_db_scenarios(state) == {}


def test_load_db_scenarios_filters_pending_and_null_status(monkeypatch: pytest.MonkeyPatch) -> None:
    state = DashboardState(db_url="sqlite:///:memory:", run_id="run-y")

    def fake_get_run(run_id: str, **kwargs: object) -> dict[str, Any]:
        return {
            "scenarios": [
                {"ordinal": 0, "status": "passed"},
                {"ordinal": 1, "status": "running"},
                {"ordinal": 2, "status": "pending"},
                {"ordinal": 3, "status": None},
                {"ordinal": None, "status": "passed"},
                {"ordinal": 4, "status": "failed"},
            ]
        }

    monkeypatch.setattr("agentprobe.db.get_run", fake_get_run)
    out = _load_db_scenarios(state)
    # pending / None-status rows are filtered; running is kept because it has
    # a real ordinal and a non-pending status.
    assert set(out.keys()) == {0, 1, 4}
    assert out[0]["status"] == "passed"


def test_load_db_scenarios_swallows_exceptions(monkeypatch: pytest.MonkeyPatch) -> None:
    state = DashboardState(db_url="sqlite:///:memory:", run_id="run-z")

    def fake_get_run(run_id: str, **kwargs: object) -> dict[str, Any]:
        raise RuntimeError("db exploded")

    monkeypatch.setattr("agentprobe.db.get_run", fake_get_run)
    assert _load_db_scenarios(state) == {}


def test_serialize_state_averages_group_by_iteration_base_id() -> None:
    state = DashboardState()
    state.update(_make_event("suite_started", scenario_total=4))
    for sid, score in (("sc-a", 0.8), ("sc-a#2", 0.6), ("sc-a#3", 0.4), ("sc-b", 0.9)):
        state.update(_make_event("scenario_started", scenario_id=sid))
        state.update(
            _make_event(
                "scenario_finished",
                scenario_id=sid,
                passed=score >= 0.5,
                overall_score=score,
            )
        )
    payload = _serialize_state(state)
    averages = {row["base_id"]: row for row in payload["averages"]}
    assert averages["sc-a"]["n"] == 3
    assert averages["sc-a"]["min"] == 0.4
    assert averages["sc-a"]["max"] == 0.8
    assert averages["sc-a"]["spread"] == pytest.approx(0.4)
    assert averages["sc-a"]["avg"] == pytest.approx(0.6, rel=1e-3)
    assert averages["sc-b"]["spread"] == 0
    assert payload["total"] == 4
    assert payload["done"] == 4
    assert payload["all_done"] is True
    assert payload["passed"] == 3
    assert payload["failed"] == 1
    assert payload["errored"] == 0


def test_serialize_state_all_done_false_when_no_total() -> None:
    state = DashboardState()
    payload = _serialize_state(state)
    assert payload["total"] == 0
    assert payload["all_done"] is False


def test_serialize_state_pulls_db_details(monkeypatch: pytest.MonkeyPatch) -> None:
    state = DashboardState(db_url="sqlite:///:memory:", run_id="run-q")
    state.update(_make_event("suite_started", scenario_total=1))
    state.update(_make_event("scenario_started", scenario_id="s1"))

    def fake_get_run(run_id: str, **kwargs: object) -> dict[str, Any]:
        return {"scenarios": [{"ordinal": 0, "status": "passed", "extra": "info"}]}

    monkeypatch.setattr("agentprobe.db.get_run", fake_get_run)
    payload = _serialize_state(state)
    assert payload["details"] == {"0": {"ordinal": 0, "status": "passed", "extra": "info"}}


def test_serialize_state_aggregates_db_dimension_scores_and_failure_modes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = DashboardState(db_url="sqlite:///:memory:", run_id="run-agg")
    state.update(_make_event("suite_started", scenario_total=3))
    for sid, score in (("sc", 0.9), ("sc#2", 0.5), ("sc#3", 0.3)):
        state.update(_make_event("scenario_started", scenario_id=sid, scenario_name="Sc"))
        state.update(
            _make_event(
                "scenario_finished",
                scenario_id=sid,
                passed=score >= 0.5,
                overall_score=score,
            )
        )

    def fake_get_run(run_id: str, **kwargs: object) -> dict[str, Any]:
        return {
            "scenarios": [
                {
                    "ordinal": 0,
                    "status": "passed",
                    "judge_dimension_scores": [
                        {
                            "dimension_id": "accuracy",
                            "dimension_name": "Accuracy",
                            "normalized_score": 0.9,
                        },
                        {
                            "dimension_id": "tone",
                            "dimension_name": "Tone",
                            "normalized_score": 0.8,
                        },
                        # No dimension_id: skipped
                        {"dimension_name": "Ignored", "normalized_score": 0.1},
                        # No normalized_score: skipped
                        {"dimension_id": "missing", "dimension_name": "Missing"},
                    ],
                    "judge": {
                        "output": {"failure_mode_detected": "hallucination"},
                        "overall_notes": "Strong recovery.",
                    },
                },
                {
                    "ordinal": 1,
                    "status": "failed",
                    "judge_dimension_scores": [
                        {
                            "dimension_id": "accuracy",
                            "dimension_name": "Accuracy",
                            "normalized_score": 0.5,
                        }
                    ],
                    "judge": {
                        "output": {"failure_mode_detected": "none"},
                        "overall_notes": "",
                    },
                },
                {
                    "ordinal": 2,
                    "status": "failed",
                    "judge_dimension_scores": [],
                    # No judge key at all — should not error.
                },
            ]
        }

    monkeypatch.setattr("agentprobe.db.get_run", fake_get_run)
    payload = _serialize_state(state)
    averages = {row["base_id"]: row for row in payload["averages"]}
    sc = averages["sc"]
    assert sc["pass_count"] == 2
    assert sc["fail_count"] == 1
    assert sc["scenario_name"] == "Sc"
    dims = {row["dimension_id"]: row for row in sc["dimensions"]}
    assert dims["accuracy"]["avg"] == pytest.approx(0.7)
    assert dims["accuracy"]["n"] == 2
    assert dims["tone"]["dimension_name"] == "Tone"
    assert sc["failure_modes"] == {"hallucination": 1}
    assert sc["judge_notes"] == ["Strong recovery."]
    assert sc["ordinals"] == [0, 1, 2]


class _FakeWFile:
    def __init__(self) -> None:
        self.buf = bytearray()

    def write(self, data: bytes) -> None:
        self.buf.extend(data)


class _FakeHandler(_DashboardHandler):
    def __init__(self, path: str, state: DashboardState, html: bytes) -> None:
        self.path = path
        self.dashboard_state = state
        self.html_content = html
        self.wfile = _FakeWFile()
        self._status: int | None = None
        self._headers: list[tuple[str, str]] = []

    def send_response(self, code: int, message: str | None = None) -> None:  # type: ignore[override]
        self._status = code

    def send_header(self, key: str, value: str) -> None:  # type: ignore[override]
        self._headers.append((key, value))

    def end_headers(self) -> None:  # type: ignore[override]
        return None

    def log_message(self, format: str, *args: Any) -> None:  # type: ignore[override]
        return None


def test_dashboard_handler_api_state_returns_json() -> None:
    state = DashboardState()
    state.update(_make_event("suite_started", scenario_total=1))
    h = _FakeHandler("/api/state", state, b"<html></html>")
    h.do_GET()
    assert h._status == 200
    assert ("Content-Type", "application/json") in h._headers
    assert ("Cache-Control", "no-store") in h._headers
    payload = json.loads(h.wfile.buf.decode("utf-8"))
    assert payload["total"] == 1


def test_dashboard_handler_root_returns_html() -> None:
    state = DashboardState()
    html = b"<html>dashboard</html>"
    h = _FakeHandler("/", state, html)
    h.do_GET()
    assert h._status == 200
    assert ("Content-Type", "text/html; charset=utf-8") in h._headers
    assert bytes(h.wfile.buf) == html


def test_dashboard_handler_unknown_path_returns_html_fallback() -> None:
    state = DashboardState()
    html = b"<html>fallback</html>"
    h = _FakeHandler("/static/app.js", state, html)
    h.do_GET()
    assert h._status == 200
    assert bytes(h.wfile.buf) == html


def test_dashboard_handler_log_message_is_silenced() -> None:
    # Covers _DashboardHandler.log_message suppression.
    state = DashboardState()
    h = _FakeHandler("/", state, b"")
    assert h.log_message("%s", "ignored") is None


def test_dashboard_server_raises_when_build_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(dashboard_module, "_DASHBOARD_HTML_PATH", tmp_path / "missing.html")
    with pytest.raises(FileNotFoundError, match="Dashboard build not found"):
        DashboardServer(DashboardState())


def test_dashboard_server_serves_state_end_to_end(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    html_path = tmp_path / "index.html"
    html_path.write_bytes(b"<html>live</html>")
    monkeypatch.setattr(dashboard_module, "_DASHBOARD_HTML_PATH", html_path)

    state = DashboardState()
    state.update(_make_event("suite_started", scenario_total=1, run_id="run-live"))
    state.update(_make_event("scenario_started", scenario_id="s1"))
    state.update(
        _make_event(
            "scenario_finished",
            scenario_id="s1",
            passed=True,
            overall_score=0.75,
        )
    )

    server = DashboardServer(state)
    assert server.url.startswith("http://127.0.0.1:")
    server.start()
    try:
        # Give the thread a moment to bind (serve_forever is synchronous on entry).
        for _ in range(20):
            try:
                with urllib.request.urlopen(f"{server.url}/api/state", timeout=1) as r:
                    payload = json.loads(r.read().decode("utf-8"))
                break
            except Exception:
                time.sleep(0.05)
        else:
            pytest.fail("dashboard server did not come up")

        assert payload["total"] == 1
        assert payload["passed"] == 1
        assert payload["all_done"] is True

        with urllib.request.urlopen(server.url + "/", timeout=1) as r:
            assert r.read() == b"<html>live</html>"
    finally:
        server.shutdown()
