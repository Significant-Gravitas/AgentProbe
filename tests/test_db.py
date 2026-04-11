from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import openai
import pytest

from agentprobe.adapters import AdapterReply, ToolCallRecord
from agentprobe.data import Endpoints
from agentprobe.db import (
    SqliteRunRecorder,
    get_run,
    init_db,
    latest_run_for_suite,
    list_runs,
)
from agentprobe.errors import AgentProbeConfigError, AgentProbeRuntimeError
from agentprobe.judge import RubricScore
from agentprobe.runner import RunResult, run_suite


class FakeAdapter:
    def __init__(self, replies: list[AdapterReply]) -> None:
        self.replies = list(replies)

    async def health_check(self, render_context: Mapping[str, object]) -> None:
        del render_context

    async def open_scenario(
        self,
        render_context: Mapping[str, object],
    ) -> dict[str, object]:
        del render_context
        return {}

    async def send_user_turn(
        self, render_context: Mapping[str, object]
    ) -> AdapterReply:
        del render_context
        if not self.replies:
            raise AssertionError("No fake replies remaining.")
        return self.replies.pop(0)

    async def close_scenario(self, render_context: Mapping[str, object]) -> None:
        del render_context


class FailingAdapter(FakeAdapter):
    async def health_check(self, render_context: Mapping[str, object]) -> None:
        del render_context
        raise AgentProbeRuntimeError("endpoint down")


class FakeResponsesAPI:
    def __init__(self, *, create_responses: list[object] | None = None) -> None:
        self.create_calls: list[dict[str, object]] = []
        self._create_responses = list(create_responses or [])

    async def create(self, **kwargs: object) -> SimpleNamespace:
        self.create_calls.append(kwargs)
        if not self._create_responses:
            return SimpleNamespace(output_text=None)

        payload = self._create_responses.pop(0)
        if isinstance(payload, SimpleNamespace):
            return payload
        if isinstance(payload, RubricScore):
            return SimpleNamespace(
                output_text=json.dumps(payload.model_dump(by_alias=True))
            )
        if isinstance(payload, dict):
            return SimpleNamespace(output_text=json.dumps(payload))
        return SimpleNamespace(output_text=payload)


class FakeOpenAIClient:
    def __init__(self, *, create_responses: list[object] | None = None) -> None:
        self.responses = FakeResponsesAPI(create_responses=create_responses)


def build_score(score: int = 4, passed: bool = True) -> RubricScore:
    return RubricScore.model_validate(
        {
            "dimensions": {
                "task_completion": {
                    "reasoning": "The agent completed the request.",
                    "evidence": ["The transcript shows a direct answer."],
                    "score": score,
                }
            },
            "overall_notes": "Solid answer.",
            "pass": passed,
        }
    )


def build_persona_step(
    status: str,
    message: str | None = None,
) -> dict[str, str | None]:
    return {"status": status, "message": message}


def write_suite_files(tmp_path: Path) -> dict[str, Path]:
    endpoint_path = tmp_path / "endpoint.yaml"
    endpoint_path.write_text(
        """
transport: http
connection:
  base_url: http://example.test
auth:
  type: bearer_token
  token: secret-token
request:
  method: POST
  url: "{{ base_url }}/chat"
  body_template: |
    {
      "message": "{{ last_message.content }}",
      "session_token": "session-secret"
    }
response:
  format: text
  content_path: "$"
""".strip(),
        encoding="utf-8",
    )

    personas_path = tmp_path / "personas.yaml"
    personas_path.write_text(
        """
personas:
  - id: business-traveler
    name: Business Traveler
    demographics:
      role: business customer
      tech_literacy: high
      domain_expertise: intermediate
      language_style: terse
    personality:
      patience: 2
      assertiveness: 4
      detail_orientation: 5
      cooperativeness: 4
      emotional_intensity: 2
    behavior:
      opening_style: Be direct.
      follow_up_style: Answer follow-up questions directly.
      escalation_triggers: []
      topic_drift: none
      clarification_compliance: high
    system_prompt: You are a direct business traveler.
""".strip(),
        encoding="utf-8",
    )

    rubric_path = tmp_path / "rubric.yaml"
    rubric_path.write_text(
        """
judge:
  provider: openai
  model: anthropic/claude-opus-4.6
  temperature: 0.0
  max_tokens: 500
rubrics:
  - id: customer-support
    name: Customer Support
    pass_threshold: 0.7
    meta_prompt: "Judge behavior: {{ expectations.expected_behavior }}"
    dimensions:
      - id: task_completion
        name: Task Completion
        weight: 1.0
        scale:
          type: likert
          points: 5
          labels:
            1: bad
            5: good
        judge_prompt: "Booking reference: {{ booking_id }}"
""".strip(),
        encoding="utf-8",
    )

    scenarios_path = tmp_path / "scenarios.yaml"
    scenarios_path.write_text(
        """
defaults:
  max_turns: 1
scenarios:
  - id: smoke-scenario
    name: Smoke
    tags: [smoke]
    priority: high
    persona: business-traveler
    rubric: customer-support
    context:
      system_prompt: You are a travel assistant.
      injected_data:
        booking_id: FLT-29481
    turns:
      - role: user
        content: Rebook {{ booking_id }}.
      - role: checkpoint
        assert:
          - tool_called: lookup_booking
            response_mentions: FLT-29481
    expectations:
      expected_behavior: Help the user quickly.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )

    return {
        "endpoint": endpoint_path,
        "scenarios": scenarios_path,
        "personas": personas_path,
        "rubric": rubric_path,
    }


def db_url_for(tmp_path: Path) -> str:
    return f"sqlite:///{(tmp_path / 'runs.sqlite3').resolve()}"


def redacted_reply() -> AdapterReply:
    return AdapterReply(
        assistant_text="I can move FLT-29481 to an 11:15 AM arrival.",
        tool_calls=[
            ToolCallRecord(
                name="lookup_booking",
                args={"booking_id": "FLT-29481"},
                order=1,
                raw={"api_key": "tool-secret"},
            )
        ],
        raw_exchange={
            "request": {
                "headers": {
                    "Authorization": "Bearer secret-token",
                    "X-Trace": "trace-1",
                },
                "json_body": {
                    "session_token": "session-secret",
                    "message": "Rebook FLT-29481.",
                },
            },
            "response": {
                "headers": {
                    "Set-Cookie": "session=session-secret",
                },
                "body": {
                    "token": "response-secret",
                    "message": "I can move FLT-29481 to an 11:15 AM arrival.",
                },
            },
        },
        latency_ms=12.5,
        usage={"input_tokens": 11, "output_tokens": 17},
    )


def assert_successful_run_shape(
    result: RunResult, persisted_run: dict[str, object]
) -> None:
    assert result.run_id is not None
    assert result.passed is True
    assert result.exit_code == 0
    assert persisted_run["run_id"] == result.run_id
    assert persisted_run["status"] == "completed"
    assert persisted_run["aggregate_counts"] == {
        "scenario_total": 1,
        "scenario_passed_count": 1,
        "scenario_failed_count": 0,
        "scenario_errored_count": 0,
    }


def test_init_db_creates_tables_and_is_idempotent(tmp_path: Path):
    database_path = tmp_path / "runs.sqlite3"
    init_db(f"sqlite:///{database_path}")
    init_db(f"sqlite:///{database_path}")

    connection = sqlite3.connect(database_path)
    try:
        table_names = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        assert {
            "meta",
            "runs",
            "scenario_runs",
            "turns",
            "target_events",
            "tool_calls",
            "checkpoints",
            "judge_dimension_scores",
        }.issubset(table_names)
        assert connection.execute(
            "SELECT schema_version FROM meta WHERE id = 1"
        ).fetchone() == (1,)
    finally:
        connection.close()


@pytest.mark.anyio
async def test_sqlite_run_recorder_persists_full_trace_and_queries(tmp_path: Path):
    paths = write_suite_files(tmp_path)
    recorder = SqliteRunRecorder(db_url_for(tmp_path))
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "Rebook FLT-29481."),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    def adapter_factory(endpoint: Endpoints) -> FakeAdapter:
        del endpoint
        return FakeAdapter([redacted_reply()])

    result = await run_suite(
        endpoint=paths["endpoint"],
        scenarios=paths["scenarios"],
        personas=paths["personas"],
        rubric=paths["rubric"],
        adapter_factory=adapter_factory,
        oai_client=cast(openai.AsyncClient, oai_client),
        recorder=recorder,
    )

    persisted_run = get_run(result.run_id or "", db_url=db_url_for(tmp_path))
    assert persisted_run is not None
    assert_successful_run_shape(result, persisted_run)

    scenario = persisted_run["scenarios"][0]
    assert scenario["status"] == "completed"
    assert scenario["passed"] is True
    assert scenario["counts"] == {
        "turn_count": 3,
        "assistant_turn_count": 1,
        "tool_call_count": 1,
        "checkpoint_count": 1,
    }
    assert len(scenario["turns"]) == 3
    assert scenario["turns"][1]["source"] == "user_guided"
    assert len(scenario["target_events"]) == 1
    assert len(scenario["tool_calls"]) == 1
    assert len(scenario["checkpoints"]) == 1
    assert len(scenario["judge_dimension_scores"]) == 1

    summaries = list_runs(db_url=db_url_for(tmp_path))
    assert [item["run_id"] for item in summaries] == [result.run_id]

    latest = latest_run_for_suite(
        persisted_run["suite_fingerprint"],
        db_url=db_url_for(tmp_path),
    )
    assert latest is not None
    assert latest["run_id"] == result.run_id

    older = latest_run_for_suite(
        persisted_run["suite_fingerprint"],
        before_started_at=persisted_run["started_at"],
        db_url=db_url_for(tmp_path),
    )
    assert older is None


@pytest.mark.anyio
async def test_sqlite_run_recorder_redacts_endpoint_and_exchange_secrets(
    tmp_path: Path,
):
    paths = write_suite_files(tmp_path)
    recorder = SqliteRunRecorder(db_url_for(tmp_path))
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "Rebook FLT-29481."),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    def adapter_factory(endpoint: Endpoints) -> FakeAdapter:
        del endpoint
        return FakeAdapter([redacted_reply()])

    result = await run_suite(
        endpoint=paths["endpoint"],
        scenarios=paths["scenarios"],
        personas=paths["personas"],
        rubric=paths["rubric"],
        adapter_factory=adapter_factory,
        oai_client=cast(openai.AsyncClient, oai_client),
        recorder=recorder,
    )

    persisted_run = get_run(result.run_id or "", db_url=db_url_for(tmp_path))
    assert persisted_run is not None
    assert persisted_run["endpoint_snapshot"]["auth"]["token"] == "[REDACTED]"

    raw_exchange = persisted_run["scenarios"][0]["target_events"][0]["raw_exchange"]
    assert raw_exchange["request"]["headers"]["Authorization"] == "[REDACTED]"
    assert raw_exchange["request"]["json_body"]["session_token"] == "[REDACTED]"
    assert raw_exchange["response"]["headers"]["Set-Cookie"] == "[REDACTED]"
    assert raw_exchange["response"]["body"]["token"] == "[REDACTED]"
    assert (
        persisted_run["scenarios"][0]["tool_calls"][0]["raw"]["api_key"] == "[REDACTED]"
    )


@pytest.mark.anyio
async def test_sqlite_run_recorder_distinguishes_exact_and_guided_user_turns(
    tmp_path: Path,
):
    paths = write_suite_files(tmp_path)
    scenarios_path = tmp_path / "scenarios.yaml"
    scenarios_path.write_text(
        """
defaults:
  max_turns: 2
scenarios:
  - id: smoke-scenario
    name: Smoke
    tags: [smoke]
    priority: high
    persona: business-traveler
    rubric: customer-support
    context:
      system_prompt: You are a travel assistant.
      injected_data:
        booking_id: FLT-29481
    turns:
      - role: user
        content: Use booking {{ booking_id }} exactly.
        use_exact_message: true
      - role: user
        content: Ask to arrive before noon.
    expectations:
      expected_behavior: Help the user quickly.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )

    recorder = SqliteRunRecorder(db_url_for(tmp_path))
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "I need to land before noon."),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    def adapter_factory(endpoint: Endpoints) -> FakeAdapter:
        del endpoint
        return FakeAdapter(
            [
                AdapterReply(assistant_text="What timing works?"),
                AdapterReply(assistant_text="I found an 11:15 AM arrival."),
            ]
        )

    result = await run_suite(
        endpoint=paths["endpoint"],
        scenarios=scenarios_path,
        personas=paths["personas"],
        rubric=paths["rubric"],
        adapter_factory=adapter_factory,
        oai_client=cast(openai.AsyncClient, oai_client),
        recorder=recorder,
    )

    persisted_run = get_run(result.run_id or "", db_url=db_url_for(tmp_path))
    assert persisted_run is not None
    sources = [
        turn["source"]
        for turn in persisted_run["scenarios"][0]["turns"]
        if turn["role"] == "user"
    ]
    assert sources == ["user_exact", "user_guided"]


@pytest.mark.anyio
async def test_sqlite_run_recorder_persists_config_errors(tmp_path: Path):
    paths = write_suite_files(tmp_path)
    recorder = SqliteRunRecorder(db_url_for(tmp_path))
    oai_client = FakeOpenAIClient(create_responses=[build_score()])

    with pytest.raises(AgentProbeConfigError, match="No scenarios matched"):
        await run_suite(
            endpoint=paths["endpoint"],
            scenarios=paths["scenarios"],
            personas=paths["personas"],
            rubric=paths["rubric"],
            scenario_id="missing-scenario",
            oai_client=cast(openai.AsyncClient, oai_client),
            recorder=recorder,
        )

    summaries = list_runs(db_url=db_url_for(tmp_path))
    assert len(summaries) == 1
    assert summaries[0]["status"] == "config_error"
    assert summaries[0]["exit_code"] == 2
    assert summaries[0]["final_error"] == {
        "type": "AgentProbeConfigError",
        "message": "No scenarios matched the requested filters.",
    }


@pytest.mark.anyio
async def test_sqlite_run_recorder_persists_runtime_errors_and_scenario_state(
    tmp_path: Path,
):
    paths = write_suite_files(tmp_path)
    recorder = SqliteRunRecorder(db_url_for(tmp_path))
    oai_client = FakeOpenAIClient(create_responses=[build_score()])

    def adapter_factory(endpoint: Endpoints) -> FailingAdapter:
        del endpoint
        return FailingAdapter([])

    with pytest.raises(AgentProbeRuntimeError, match="endpoint down"):
        await run_suite(
            endpoint=paths["endpoint"],
            scenarios=paths["scenarios"],
            personas=paths["personas"],
            rubric=paths["rubric"],
            adapter_factory=adapter_factory,
            oai_client=cast(openai.AsyncClient, oai_client),
            recorder=recorder,
        )

    summaries = list_runs(db_url=db_url_for(tmp_path))
    assert len(summaries) == 1
    assert summaries[0]["status"] == "runtime_error"
    assert summaries[0]["exit_code"] == 3
    assert summaries[0]["aggregate_counts"] == {
        "scenario_total": 1,
        "scenario_passed_count": 0,
        "scenario_failed_count": 0,
        "scenario_errored_count": 1,
    }

    persisted_run = get_run(summaries[0]["run_id"], db_url=db_url_for(tmp_path))
    assert persisted_run is not None
    assert persisted_run["scenarios"][0]["status"] == "runtime_error"
    assert persisted_run["scenarios"][0]["error"] == {
        "type": "AgentProbeRuntimeError",
        "message": "endpoint down",
    }


def test_latest_run_for_suite_accepts_naive_datetime_cutoff(tmp_path: Path) -> None:
    from datetime import datetime

    db_url = db_url_for(tmp_path)
    init_db(db_url)
    # No matching rows; the branch under test is the naive-tz normalization.
    result = latest_run_for_suite(
        "no-such-suite",
        before_started_at=datetime(2099, 1, 1),  # naive datetime
        db_url=db_url,
    )
    assert result is None
