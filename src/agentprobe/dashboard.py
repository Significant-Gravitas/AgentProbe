"""Live dashboard HTTP server for AgentProbe benchmark runs.

Serves the React dashboard app and a JSON state API.
The React app polls /api/state for live updates — no page reloads.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass, field
from functools import partial
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

from .runner import RunProgressEvent

logger = logging.getLogger(__name__)

_DASHBOARD_HTML_PATH = Path(__file__).resolve().parent.parent.parent / "dashboard" / "dist" / "index.html"


@dataclass
class _ScenarioState:
    scenario_id: str
    scenario_name: str | None = None
    status: str = "pending"
    score: float | None = None
    error: str | None = None
    started_at: float | None = None
    finished_at: float | None = None


@dataclass
class DashboardState:
    total: int = 0
    started_at: float = field(default_factory=time.monotonic)
    scenarios: dict[str, _ScenarioState] = field(default_factory=dict)
    _order: list[str] = field(default_factory=list)
    db_url: str | None = None
    run_id: str | None = None

    def update(self, event: RunProgressEvent) -> None:
        if event.kind == "suite_started":
            self.total = event.scenario_total or 0
            if event.run_id:
                self.run_id = event.run_id
            return

        sid = event.scenario_id or "unknown"
        if sid not in self.scenarios:
            self.scenarios[sid] = _ScenarioState(
                scenario_id=sid, scenario_name=event.scenario_name
            )
            self._order.append(sid)

        s = self.scenarios[sid]
        s.scenario_name = event.scenario_name or s.scenario_name

        if event.kind == "scenario_started":
            s.status = "running"
            s.started_at = time.time()
        elif event.kind == "scenario_finished":
            s.status = "pass" if event.passed else "fail"
            s.score = event.overall_score
            s.finished_at = time.time()
        elif event.kind == "scenario_error":
            s.status = "error"
            s.error = str(event.error) if event.error else None
            s.finished_at = time.time()

    @property
    def ordered_scenarios(self) -> list[_ScenarioState]:
        return [self.scenarios[sid] for sid in self._order if sid in self.scenarios]

    @property
    def passed(self) -> int:
        return sum(1 for s in self.scenarios.values() if s.status == "pass")

    @property
    def failed(self) -> int:
        return sum(1 for s in self.scenarios.values() if s.status == "fail")

    @property
    def errored(self) -> int:
        return sum(1 for s in self.scenarios.values() if s.status == "error")

    @property
    def running(self) -> int:
        return sum(1 for s in self.scenarios.values() if s.status == "running")

    @property
    def done(self) -> int:
        return self.passed + self.failed + self.errored

    @property
    def elapsed_seconds(self) -> float:
        return time.monotonic() - self.started_at


def _load_db_scenarios(state: DashboardState) -> dict[int, dict[str, Any]]:
    if not state.db_url or not state.run_id:
        return {}
    try:
        from .db import get_run
        run = get_run(state.run_id, include_trace=True, db_url=state.db_url)
        if run is None:
            return {}
        result: dict[int, dict[str, Any]] = {}
        for scenario in run.get("scenarios", []):
            ordinal = scenario.get("ordinal")
            if ordinal is not None and scenario.get("status") not in (None, "pending"):
                result[ordinal] = scenario
        return result
    except Exception:
        logger.debug("Dashboard DB query failed", exc_info=True)
        return {}


def _serialize_state(state: DashboardState) -> dict[str, Any]:
    total = state.total or len(state.scenarios)
    done = state.done

    db_scenarios = _load_db_scenarios(state)

    scenarios_list = []
    for s in state.ordered_scenarios:
        scenarios_list.append({
            "scenario_id": s.scenario_id,
            "scenario_name": s.scenario_name,
            "status": s.status,
            "score": s.score,
            "error": s.error,
            "started_at": s.started_at,
            "finished_at": s.finished_at,
        })

    # Group scenarios by base_id for averages + detail aggregation
    base_groups: dict[str, list[tuple[int, _ScenarioState]]] = {}
    for ordinal, s in enumerate(state.ordered_scenarios):
        base_id = s.scenario_id.split("#")[0]
        base_groups.setdefault(base_id, []).append((ordinal, s))

    averages = []
    for base_id, group in sorted(base_groups.items()):
        scores = [s.score for _, s in group if s.score is not None]
        if not scores:
            continue

        pass_count = sum(1 for _, s in group if s.status == "pass")
        fail_count = sum(1 for _, s in group if s.status == "fail")

        # Aggregate per-dimension scores and failure modes from DB
        dim_scores: dict[str, list[float]] = {}
        dim_names: dict[str, str] = {}
        failure_modes: dict[str, int] = {}
        judge_notes: list[str] = []
        ordinals: list[int] = []

        for ordinal, s in group:
            ordinals.append(ordinal)
            detail = db_scenarios.get(ordinal)
            if detail is None:
                continue

            for dim in detail.get("judge_dimension_scores", []):
                did = dim.get("dimension_id", "")
                ns = dim.get("normalized_score")
                if did and ns is not None:
                    dim_scores.setdefault(did, []).append(ns)
                    dim_names[did] = dim.get("dimension_name", did)

            judge = detail.get("judge") or {}
            output = judge.get("output")
            if isinstance(output, dict):
                fm = output.get("failure_mode_detected")
                if fm and isinstance(fm, str) and fm != "none":
                    failure_modes[fm] = failure_modes.get(fm, 0) + 1

            notes = (judge.get("overall_notes") or "").strip()
            if notes:
                judge_notes.append(notes)

        dim_averages = []
        for did, vals in sorted(dim_scores.items()):
            dim_averages.append({
                "dimension_id": did,
                "dimension_name": dim_names.get(did, did),
                "avg": sum(vals) / len(vals),
                "min": min(vals),
                "max": max(vals),
                "n": len(vals),
            })

        averages.append({
            "base_id": base_id,
            "scenario_name": group[0][1].scenario_name,
            "avg": sum(scores) / len(scores),
            "min": min(scores),
            "max": max(scores),
            "spread": max(scores) - min(scores) if len(scores) > 1 else 0,
            "n": len(scores),
            "pass_count": pass_count,
            "fail_count": fail_count,
            "dimensions": dim_averages,
            "failure_modes": failure_modes,
            "judge_notes": judge_notes,
            "ordinals": ordinals,
        })

    return {
        "total": total,
        "elapsed": state.elapsed_seconds,
        "passed": state.passed,
        "failed": state.failed,
        "errored": state.errored,
        "running": state.running,
        "done": done,
        "all_done": done >= total and total > 0,
        "scenarios": scenarios_list,
        "details": {str(k): v for k, v in db_scenarios.items()},
        "averages": averages,
    }


class _DashboardHandler(BaseHTTPRequestHandler):
    dashboard_state: DashboardState
    html_content: bytes

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def do_GET(self) -> None:
        if self.path == "/api/state":
            payload = json.dumps(
                _serialize_state(self.dashboard_state),
                default=str,
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(self.html_content)))
        self.end_headers()
        self.wfile.write(self.html_content)


class DashboardServer:
    def __init__(self, state: DashboardState, port: int = 0) -> None:
        self.state = state
        html_path = _DASHBOARD_HTML_PATH
        if not html_path.exists():
            raise FileNotFoundError(
                f"Dashboard build not found at {html_path}. "
                "Run `bun run build` in the dashboard/ directory first."
            )
        html_content = html_path.read_bytes()

        handler_class = type(
            "_BoundHandler",
            (_DashboardHandler,),
            {"dashboard_state": state, "html_content": html_content},
        )
        self._server = HTTPServer(("127.0.0.1", port), handler_class)
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        host, port = self._server.server_address
        return f"http://{host}:{port}"

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            daemon=True,
            name="agentprobe-dashboard",
        )
        self._thread.start()
        logger.info("Dashboard server started at %s", self.url)

    def shutdown(self) -> None:
        self._server.shutdown()
        if self._thread is not None:
            self._thread.join(timeout=5)
