from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import openai
import pytest

from agentprobe.adapters import AdapterReply, ToolCallRecord
from agentprobe.data import Endpoints
from agentprobe.data.personas import Persona
from agentprobe.data.rubrics import JudgeConfig, Rubric, RubricDimension, RubricScale
from agentprobe.data.scenarios import Scenario, ScenarioDefaults
from agentprobe.judge import RubricScore
from agentprobe.runner import (
    RunProgressEvent,
    ScenarioRunResult,
    run_scenario,
    run_suite,
)
from agentprobe.simulator import ConversationTurn


class FakeAdapter:
    def __init__(
        self,
        replies: list[AdapterReply],
        *,
        session_state: dict[str, object] | None = None,
    ) -> None:
        self.replies = list(replies)
        self.session_state = dict(session_state or {})
        self.health_calls: list[dict[str, object]] = []
        self.open_calls: list[dict[str, object]] = []
        self.send_calls: list[dict[str, object]] = []
        self.close_calls: list[dict[str, object]] = []

    async def health_check(self, render_context: Mapping[str, object]) -> None:
        self.health_calls.append(dict(render_context))

    async def open_scenario(
        self,
        render_context: Mapping[str, object],
    ) -> dict[str, object]:
        self.open_calls.append(dict(render_context))
        return dict(self.session_state)

    async def send_user_turn(
        self, render_context: Mapping[str, object]
    ) -> AdapterReply:
        self.send_calls.append(dict(render_context))
        if not self.replies:
            raise AssertionError("No fake replies remaining.")
        return self.replies.pop(0)

    async def close_scenario(self, render_context: Mapping[str, object]) -> None:
        self.close_calls.append(dict(render_context))


class FakeResponsesAPI:
    def __init__(self, *, create_responses: list[object] | None = None) -> None:
        self.create_calls: list[dict[str, object]] = []
        self._create_responses = list(create_responses or [])

    async def create(self, **kwargs: object) -> SimpleNamespace:
        self.create_calls.append(kwargs)
        if not self._create_responses:
            raise AssertionError("No fake OpenAI responses remaining.")

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


def build_persona() -> Persona:
    return Persona.model_validate(
        {
            "id": "business-traveler",
            "name": "Business Traveler",
            "description": "Direct and detail-oriented user.",
            "demographics": {
                "role": "business customer",
                "tech_literacy": "high",
                "domain_expertise": "intermediate",
                "language_style": "terse",
            },
            "personality": {
                "patience": 2,
                "assertiveness": 4,
                "detail_orientation": 5,
                "cooperativeness": 4,
                "emotional_intensity": 2,
            },
            "behavior": {
                "opening_style": "Be direct.",
                "follow_up_style": "Answer follow-up questions directly.",
                "escalation_triggers": [],
                "topic_drift": "none",
                "clarification_compliance": "high",
            },
            "system_prompt": "You are a direct business traveler.",
        }
    )


def build_rubric() -> Rubric:
    return Rubric(
        id="customer-support",
        name="Customer Support",
        pass_threshold=0.7,
        meta_prompt="Judge behavior: {{ expectations.expected_behavior }}",
        judge=JudgeConfig(
            provider="openai",
            model="anthropic/claude-opus-4.6",
            temperature=0.0,
            max_tokens=500,
        ),
        dimensions=[
            RubricDimension(
                id="task_completion",
                name="Task Completion",
                weight=1.0,
                scale=RubricScale(
                    type="likert", points=5, labels={1: "bad", 5: "good"}
                ),
                judge_prompt="Booking reference: {{ booking_id }}",
            )
        ],
    )


def build_score(score: int = 4, *, passed: bool | None = None) -> RubricScore:
    final_passed = passed if passed is not None else (float(score) / 5.0) >= 0.7
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
            "pass": final_passed,
        }
    )


def build_persona_step(
    status: str,
    message: str | None = None,
) -> dict[str, str | None]:
    return {"status": status, "message": message}


def simulator_calls(client: FakeOpenAIClient) -> list[dict[str, object]]:
    calls: list[dict[str, object]] = []
    for call in client.responses.create_calls:
        text_config = call.get("text")
        if not isinstance(text_config, dict):
            continue
        text_format = text_config.get("format")
        if not isinstance(text_format, dict):
            continue
        if text_format.get("name") == "persona_step":
            calls.append(call)
    return calls


def build_scenario(*, turns: list[dict[str, object]]) -> Scenario:
    return Scenario.model_validate(
        {
            "id": "flight-rebooking",
            "name": "Flight Rebooking",
            "persona": "business-traveler",
            "rubric": "customer-support",
            "context": {
                "system_prompt": "You are a travel assistant.",
                "injected_data": {"booking_id": "FLT-29481"},
            },
            "turns": turns,
            "expectations": {
                "expected_behavior": "Agent must help the user quickly.",
                "expected_outcome": "resolved",
            },
        }
    )


@pytest.mark.anyio
async def test_run_scenario_renders_injected_data_and_uses_persona_generation():
    adapter = FakeAdapter(
        [
            AdapterReply(assistant_text="What is your timing constraint?"),
            AdapterReply(assistant_text="I found a flight arriving at 11:15 AM."),
        ]
    )
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "Please change booking FLT-29481."),
            build_persona_step("continue", "I need to land before noon."),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    result = await run_scenario(
        adapter,
        build_scenario(
            turns=[
                {"role": "user", "content": "Please change booking {{ booking_id }}."},
                {"role": "user", "content": None},
            ]
        ),
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=2),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    first_message = cast(ConversationTurn, adapter.send_calls[0]["last_message"])
    second_message = cast(ConversationTurn, adapter.send_calls[1]["last_message"])
    assert first_message.content == "Please change booking FLT-29481."
    assert second_message.content == "I need to land before noon."
    assert "Please change booking FLT-29481." in str(
        simulator_calls(oai_client)[0]["input"]
    )
    assert [turn.role for turn in result.transcript] == [
        "system",
        "user",
        "assistant",
        "user",
        "assistant",
    ]


@pytest.mark.anyio
async def test_run_scenario_uses_exact_messages_only_when_requested():
    adapter = FakeAdapter(
        [
            AdapterReply(assistant_text="What is your timing constraint?"),
            AdapterReply(assistant_text="I found a flight arriving at 11:15 AM."),
        ]
    )
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "I need to land before noon."),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    await run_scenario(
        adapter,
        build_scenario(
            turns=[
                {
                    "role": "user",
                    "content": "Use booking {{ booking_id }} exactly.",
                    "use_exact_message": True,
                },
                {"role": "user", "content": "Ask to land before noon."},
            ]
        ),
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=2),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    first_message = cast(ConversationTurn, adapter.send_calls[0]["last_message"])
    second_message = cast(ConversationTurn, adapter.send_calls[1]["last_message"])
    assert first_message.content == "Use booking FLT-29481 exactly."
    assert second_message.content == "I need to land before noon."
    assert len(simulator_calls(oai_client)) == 2
    assert "Ask to land before noon." in str(simulator_calls(oai_client)[0]["input"])


@pytest.mark.anyio
async def test_run_scenario_accepts_required_response_with_terminal_status_and_message():
    adapter = FakeAdapter([AdapterReply(assistant_text="I can help with that.")])
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("completed", "I need to land before noon."),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    await run_scenario(
        adapter,
        build_scenario(turns=[{"role": "user", "content": "Ask to land before noon."}]),
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=2),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    first_message = cast(ConversationTurn, adapter.send_calls[0]["last_message"])
    assert first_message.content == "I need to land before noon."


@pytest.mark.anyio
async def test_run_scenario_accepts_generated_follow_up_with_terminal_status_and_message():
    adapter = FakeAdapter(
        [
            AdapterReply(assistant_text="I wrote the posts."),
            AdapterReply(assistant_text="It is straightforward."),
        ]
    )
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step(
                "continue",
                "Please create posts for Twitter, LinkedIn, and Instagram.",
            ),
            build_persona_step("completed", "How complicated would that be?"),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    result = await run_scenario(
        adapter,
        build_scenario(
            turns=[
                {
                    "role": "user",
                    "content": "Please create posts for Twitter, LinkedIn, and Instagram.",
                }
            ]
        ),
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=3),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    assert len(adapter.send_calls) == 2
    follow_up = cast(ConversationTurn, adapter.send_calls[1]["last_message"])
    assert follow_up.content == "How complicated would that be?"
    assert [turn.role for turn in result.transcript] == [
        "system",
        "user",
        "assistant",
        "user",
        "assistant",
    ]


@pytest.mark.anyio
async def test_run_scenario_session_max_turns_stops_only_that_session():
    adapter = FakeAdapter(
        [
            AdapterReply(assistant_text="I stored the contact."),
            AdapterReply(assistant_text="You should CC Sarah."),
        ]
    )
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "One more follow-up question."),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    scenario = Scenario.model_validate(
        {
            "id": "memory-two-session",
            "name": "Memory Two Session",
            "persona": "business-traveler",
            "rubric": "customer-support",
            "context": {
                "system_prompt": "You are a travel assistant.",
                "injected_data": {"booking_id": "FLT-29481"},
            },
            "sessions": [
                {
                    "id": "s1",
                    "time_offset": "0h",
                    "reset": "none",
                    "max_turns": 1,
                    "turns": [
                        {
                            "role": "user",
                            "content": "Store the contact in HubSpot.",
                            "use_exact_message": True,
                        }
                    ],
                },
                {
                    "id": "s2",
                    "time_offset": "48h",
                    "reset": "new",
                    "turns": [
                        {
                            "role": "user",
                            "content": "Who should I CC on proposals?",
                            "use_exact_message": True,
                        }
                    ],
                },
            ],
            "expectations": {
                "expected_behavior": "Reach the second session after capping the first.",
                "expected_outcome": "resolved",
            },
        }
    )

    result = await run_scenario(
        adapter,
        scenario,
        build_persona(),
        build_rubric(),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    assert [
        cast(ConversationTurn, call["last_message"]).content for call in adapter.send_calls
    ] == [
        "Store the contact in HubSpot.",
        "Who should I CC on proposals?",
    ]
    assert "One more follow-up question." not in [
        turn.content for turn in result.transcript
    ]
    assert result.passed is True


@pytest.mark.anyio
async def test_run_scenario_records_checkpoint_failures_without_stopping():
    adapter = FakeAdapter(
        [
            AdapterReply(
                assistant_text="Tracking number ZX9 is on the way.",
                tool_calls=[
                    ToolCallRecord(
                        name="lookup_order", args={"order_id": "123"}, order=1
                    )
                ],
            )
        ]
    )
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "Where is order 123?"),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    result = await run_scenario(
        adapter,
        build_scenario(
            turns=[
                {"role": "user", "content": "Where is order 123?"},
                {
                    "role": "checkpoint",
                    "assert": [
                        {
                            "tool_called": "lookup_order",
                            "with_args": {"order_id": "123"},
                            "response_mentions": "ZX9",
                        }
                    ],
                },
                {
                    "role": "checkpoint",
                    "assert": [{"response_mentions": "refund"}],
                },
            ]
        ),
        build_persona(),
        build_rubric(),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    assert [checkpoint.passed for checkpoint in result.checkpoints] == [True, False]
    assert result.passed is True


@pytest.mark.anyio
async def test_run_scenario_renders_rubric_and_judge_receives_full_transcript():
    adapter = FakeAdapter(
        [
            AdapterReply(
                assistant_text="I can move FLT-29481 to an 11:15 AM arrival.",
                tool_calls=[
                    ToolCallRecord(
                        name="lookup_booking", args={"booking_id": "FLT-29481"}
                    )
                ],
            )
        ]
    )
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "Rebook FLT-29481."),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    await run_scenario(
        adapter,
        build_scenario(turns=[{"role": "user", "content": "Rebook {{ booking_id }}."}]),
        build_persona(),
        build_rubric(),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    call = oai_client.responses.create_calls[-1]
    assert "Booking reference: FLT-29481" in str(call["instructions"])
    assert "Judge behavior: Agent must help the user quickly." in str(
        call["instructions"]
    )
    assert '"additionalProperties": false' in str(call["instructions"])
    assert "Conversation Transcript" in str(call["input"])
    assert "User: Rebook FLT-29481." in str(call["input"])
    assert "Assistant: I can move FLT-29481 to an 11:15 AM arrival." in str(
        call["input"]
    )
    assert "Tool Calls" in str(call["input"])


@pytest.mark.anyio
async def test_run_scenario_exposes_rendered_turns_to_rubric_templates():
    adapter = FakeAdapter([AdapterReply(assistant_text="Handled.")])
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "Please rebook FLT-29481."),
            build_persona_step("completed"),
            build_score(),
        ]
    )
    rubric = build_rubric().model_copy(deep=True)
    rubric.dimensions[0].judge_prompt = "User asked: {{ turns[0].content }}"

    await run_scenario(
        adapter,
        build_scenario(turns=[{"role": "user", "content": "Rebook {{ booking_id }}."}]),
        build_persona(),
        rubric,
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    call = oai_client.responses.create_calls[-1]
    assert "User asked: Please rebook FLT-29481." in str(call["instructions"])


@pytest.mark.anyio
async def test_run_scenario_continues_after_scripted_turns_until_stalled():
    adapter = FakeAdapter(
        [
            AdapterReply(assistant_text="What timing works?"),
            AdapterReply(assistant_text="I can get you in before noon."),
            AdapterReply(assistant_text="There is a 6:45 AM option."),
        ]
    )
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "Please change booking FLT-29481."),
            build_persona_step("continue", "I need to land before noon."),
            build_persona_step("continue", "What options are available?"),
            build_persona_step("stalled"),
            build_score(),
        ]
    )

    await run_scenario(
        adapter,
        build_scenario(
            turns=[
                {"role": "user", "content": "Please change booking {{ booking_id }}."},
                {
                    "role": "user",
                    "content": "Mention that arrival must be before noon.",
                },
            ]
        ),
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=3),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    assert [
        cast(ConversationTurn, call["last_message"]).content
        for call in adapter.send_calls
    ] == [
        "Please change booking FLT-29481.",
        "I need to land before noon.",
        "What options are available?",
    ]


@pytest.mark.anyio
async def test_run_scenario_judges_when_continuation_exceeds_inherited_max_turns():
    adapter = FakeAdapter([AdapterReply(assistant_text="First reply.")])
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "First turn"),
            build_persona_step("continue", "Second turn"),
            build_score(2),
        ]
    )

    result = await run_scenario(
        adapter,
        build_scenario(turns=[{"role": "user", "content": "First turn"}]),
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=1),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    assert len(adapter.send_calls) == 1
    assert result.passed is False
    assert result.overall_score == pytest.approx(0.4)
    judge_call = oai_client.responses.create_calls[-1]
    assert "Scenario flight-rebooking exceeded max_turns=1." in str(judge_call["input"])
    assert "Assistant: First reply." in str(judge_call["input"])


@pytest.mark.anyio
async def test_run_suite_resolves_references_and_filters_tags(tmp_path: Path):
    endpoint_path = tmp_path / "endpoint.yaml"
    endpoint_path.write_text(
        """
transport: http
connection:
  base_url: http://example.test
request:
  method: POST
  url: "{{ base_url }}/chat"
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
    meta_prompt: Judge behavior.
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
        judge_prompt: Check task completion.
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
    persona: business-traveler
    rubric: customer-support
    turns:
      - role: user
        content: Hello smoke
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
  - id: regression-scenario
    name: Regression
    tags: [regression]
    persona: business-traveler
    rubric: customer-support
    turns:
      - role: user
        content: Hello regression
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )

    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "Hello smoke"),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    def adapter_factory(endpoint: Endpoints) -> FakeAdapter:
        return FakeAdapter([AdapterReply(assistant_text="Handled.")])

    result = await run_suite(
        endpoint=endpoint_path,
        scenarios=scenarios_path,
        personas=personas_path,
        rubric=rubric_path,
        tags="smoke",
        adapter_factory=adapter_factory,
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    assert result.exit_code == 0
    assert [item.scenario_id for item in result.results] == ["smoke-scenario"]


@pytest.mark.anyio
async def test_run_suite_merges_scenarios_from_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    endpoint_path = tmp_path / "endpoint.yaml"
    endpoint_path.write_text(
        """
transport: http
connection:
  base_url: http://example.test
request:
  method: POST
  url: "{{ base_url }}/chat"
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
    meta_prompt: Judge behavior.
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
        judge_prompt: Check task completion.
""".strip(),
        encoding="utf-8",
    )

    scenarios_dir = tmp_path / "scenarios"
    scenarios_dir.mkdir()
    (scenarios_dir / "smoke.yaml").write_text(
        """
defaults:
  max_turns: 1
scenarios:
  - id: smoke-scenario
    name: Smoke
    tags: [smoke]
    persona: business-traveler
    rubric: customer-support
    turns:
      - role: user
        content: Hello smoke
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )
    (scenarios_dir / "regression.yaml").write_text(
        """
scenarios:
  - id: regression-scenario
    name: Regression
    tags: [regression]
    persona: business-traveler
    rubric: customer-support
    turns:
      - role: user
        content: Hello regression
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )

    observed_defaults: list[tuple[str, int | None]] = []

    async def fake_run_scenario(
        adapter: FakeAdapter,
        scenario: Scenario,
        persona: Persona,
        rubric: Rubric,
        *,
        defaults: ScenarioDefaults | None = None,
        oai_client: openai.AsyncClient,
        recorder: object | None = None,
        scenario_ordinal: int | None = None,
        dry_run: bool = False,
        adapter_factory: object | None = None,
        user_id: str | None = None,
    ) -> ScenarioRunResult:
        persona_id = persona.id
        rubric_id = rubric.id
        del (
            adapter,
            persona,
            rubric,
            oai_client,
            recorder,
            scenario_ordinal,
            dry_run,
            adapter_factory,
            user_id,
        )
        observed_defaults.append(
            (scenario.id, defaults.max_turns if defaults is not None else None)
        )
        return ScenarioRunResult(
            scenario_id=scenario.id,
            scenario_name=scenario.name,
            persona_id=persona_id,
            rubric_id=rubric_id,
            passed=True,
            overall_score=0.8,
        )

    monkeypatch.setattr("agentprobe.runner.run_scenario", fake_run_scenario)

    def adapter_factory(endpoint: Endpoints) -> FakeAdapter:
        return FakeAdapter([AdapterReply(assistant_text="Handled.")])

    result = await run_suite(
        endpoint=endpoint_path,
        scenarios=scenarios_dir,
        personas=personas_path,
        rubric=rubric_path,
        adapter_factory=adapter_factory,
        oai_client=cast(openai.AsyncClient, FakeOpenAIClient()),
    )

    assert result.exit_code == 0
    assert [item.scenario_id for item in result.results] == [
        "regression-scenario",
        "smoke-scenario",
    ]
    assert observed_defaults == [
        ("regression-scenario", 1),
        ("smoke-scenario", 1),
    ]


@pytest.mark.anyio
async def test_run_suite_repeat_generates_distinct_user_ids_per_iteration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    endpoint_path = tmp_path / "endpoint.yaml"
    endpoint_path.write_text(
        """
transport: http
connection:
  base_url: http://example.test
request:
  method: POST
  url: "{{ base_url }}/chat"
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
    meta_prompt: Judge behavior.
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
        judge_prompt: Check task completion.
""".strip(),
        encoding="utf-8",
    )

    scenarios_path = tmp_path / "scenarios.yaml"
    scenarios_path.write_text(
        """
defaults:
  max_turns: 1
scenarios:
  - id: repeat-scenario
    name: Repeat
    persona: business-traveler
    rubric: customer-support
    turns:
      - role: user
        content: Hello repeat
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )

    # Set the env var that used to collapse iterations onto one user — the
    # regression guard is that run_suite must ignore it and still hand each
    # iteration a fresh uuid.
    monkeypatch.setenv("AUTOGPT_USER_ID", "should-be-ignored-by-run-suite")

    observed_user_ids: list[str | None] = []

    async def fake_run_scenario(
        adapter: FakeAdapter,
        scenario: Scenario,
        persona: Persona,
        rubric: Rubric,
        *,
        defaults: ScenarioDefaults | None = None,
        oai_client: openai.AsyncClient,
        recorder: object | None = None,
        scenario_ordinal: int | None = None,
        dry_run: bool = False,
        adapter_factory: object | None = None,
        user_id: str | None = None,
    ) -> ScenarioRunResult:
        persona_id = persona.id
        rubric_id = rubric.id
        del (
            adapter,
            persona,
            rubric,
            defaults,
            oai_client,
            recorder,
            scenario_ordinal,
            dry_run,
            adapter_factory,
        )
        observed_user_ids.append(user_id)
        return ScenarioRunResult(
            scenario_id=scenario.id,
            scenario_name=scenario.name,
            persona_id=persona_id,
            rubric_id=rubric_id,
            user_id=user_id,
            passed=True,
            overall_score=0.9,
        )

    monkeypatch.setattr("agentprobe.runner.run_scenario", fake_run_scenario)

    def adapter_factory(endpoint: Endpoints) -> FakeAdapter:
        return FakeAdapter([AdapterReply(assistant_text="Handled.")])

    result = await run_suite(
        endpoint=endpoint_path,
        scenarios=scenarios_path,
        personas=personas_path,
        rubric=rubric_path,
        adapter_factory=adapter_factory,
        oai_client=cast(openai.AsyncClient, FakeOpenAIClient()),
        repeat=3,
    )

    assert result.exit_code == 0
    assert len(observed_user_ids) == 3
    assert all(uid is not None for uid in observed_user_ids)
    assert "should-be-ignored-by-run-suite" not in observed_user_ids
    assert len(set(observed_user_ids)) == 3


@pytest.mark.anyio
async def test_run_suite_emits_progress_events(tmp_path: Path):
    endpoint_path = tmp_path / "endpoint.yaml"
    endpoint_path.write_text(
        """
transport: http
connection:
  base_url: http://example.test
request:
  method: POST
  url: "{{ base_url }}/chat"
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
    meta_prompt: Judge behavior.
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
        judge_prompt: Check task completion.
""".strip(),
        encoding="utf-8",
    )

    scenarios_path = tmp_path / "scenarios.yaml"
    scenarios_path.write_text(
        """
scenarios:
  - id: smoke-scenario
    name: Smoke
    persona: business-traveler
    rubric: customer-support
    turns:
      - role: user
        content: Hello smoke
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )

    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "Hello smoke"),
            build_persona_step("completed"),
            build_score(),
        ]
    )
    events: list[RunProgressEvent] = []

    def adapter_factory(endpoint: Endpoints) -> FakeAdapter:
        return FakeAdapter([AdapterReply(assistant_text="Handled.")])

    await run_suite(
        endpoint=endpoint_path,
        scenarios=scenarios_path,
        personas=personas_path,
        rubric=rubric_path,
        adapter_factory=adapter_factory,
        oai_client=cast(openai.AsyncClient, oai_client),
        progress_callback=events.append,
    )

    assert [(event.kind, event.scenario_id) for event in events] == [
        ("suite_started", None),
        ("scenario_started", "smoke-scenario"),
        ("scenario_finished", "smoke-scenario"),
    ]
    assert events[0].scenario_total == 1
    assert events[1].scenario_index == 1
    assert events[2].passed is True
    assert events[2].overall_score == pytest.approx(0.8)


@pytest.mark.anyio
async def test_run_suite_parallel_runs_scenarios_concurrently_and_keeps_result_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    endpoint_path = tmp_path / "endpoint.yaml"
    endpoint_path.write_text(
        """
transport: http
connection:
  base_url: http://example.test
request:
  method: POST
  url: "{{ base_url }}/chat"
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
    meta_prompt: Judge behavior.
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
        judge_prompt: Check task completion.
""".strip(),
        encoding="utf-8",
    )

    scenarios_path = tmp_path / "scenarios.yaml"
    scenarios_path.write_text(
        """
scenarios:
  - id: smoke-scenario
    name: Smoke
    persona: business-traveler
    rubric: customer-support
    turns:
      - role: user
        content: Hello smoke
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
  - id: regression-scenario
    name: Regression
    persona: business-traveler
    rubric: customer-support
    turns:
      - role: user
        content: Hello regression
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )

    async def fake_run_scenario(
        adapter: FakeAdapter,
        scenario: Scenario,
        persona: Persona,
        rubric: Rubric,
        *,
        defaults: ScenarioDefaults | None = None,
        oai_client: openai.AsyncClient,
        recorder: object | None = None,
        scenario_ordinal: int | None = None,
        dry_run: bool = False,
        adapter_factory: object | None = None,
        user_id: str | None = None,
    ) -> ScenarioRunResult:
        persona_id = persona.id
        rubric_id = rubric.id
        del (
            adapter,
            persona,
            rubric,
            defaults,
            oai_client,
            recorder,
            dry_run,
            adapter_factory,
            user_id,
        )
        if scenario.id == "smoke-scenario":
            await asyncio.sleep(0.05)
            return ScenarioRunResult(
                scenario_id=scenario.id,
                scenario_name=scenario.name,
                persona_id=persona_id,
                rubric_id=rubric_id,
                passed=True,
                overall_score=0.8,
            )

        await asyncio.sleep(0.01)
        return ScenarioRunResult(
            scenario_id=scenario.id,
            scenario_name=scenario.name,
            persona_id=persona_id,
            rubric_id=rubric_id,
            passed=True,
            overall_score=0.9,
        )

    monkeypatch.setattr("agentprobe.runner.run_scenario", fake_run_scenario)
    events: list[RunProgressEvent] = []

    def adapter_factory(endpoint: Endpoints) -> FakeAdapter:
        return FakeAdapter([AdapterReply(assistant_text="Handled.")])

    result = await run_suite(
        endpoint=endpoint_path,
        scenarios=scenarios_path,
        personas=personas_path,
        rubric=rubric_path,
        adapter_factory=adapter_factory,
        oai_client=cast(openai.AsyncClient, FakeOpenAIClient()),
        progress_callback=events.append,
        parallel=True,
    )

    assert result.exit_code == 0
    assert [item.scenario_id for item in result.results] == [
        "smoke-scenario",
        "regression-scenario",
    ]
    assert [
        (event.kind, event.scenario_id, event.scenario_index) for event in events
    ] == [
        ("suite_started", None, None),
        ("scenario_started", "smoke-scenario", 1),
        ("scenario_started", "regression-scenario", 2),
        ("scenario_finished", "regression-scenario", 2),
        ("scenario_finished", "smoke-scenario", 1),
    ]
    assert events[3].overall_score == pytest.approx(0.9)
    assert events[4].overall_score == pytest.approx(0.8)


@pytest.mark.anyio
async def test_run_suite_finishes_with_a_judged_failure_after_max_turns(tmp_path: Path):
    endpoint_path = tmp_path / "endpoint.yaml"
    endpoint_path.write_text(
        """
transport: http
connection:
  base_url: http://example.test
request:
  method: POST
  url: "{{ base_url }}/chat"
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
    meta_prompt: Judge behavior.
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
        judge_prompt: Check task completion.
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
    persona: business-traveler
    rubric: customer-support
    turns:
      - role: user
        content: Hello smoke
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )

    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "Hello smoke"),
            build_persona_step("continue", "One more question"),
            build_score(2),
        ]
    )
    events: list[RunProgressEvent] = []

    def adapter_factory(endpoint: Endpoints) -> FakeAdapter:
        return FakeAdapter([AdapterReply(assistant_text="Handled.")])

    result = await run_suite(
        endpoint=endpoint_path,
        scenarios=scenarios_path,
        personas=personas_path,
        rubric=rubric_path,
        adapter_factory=adapter_factory,
        oai_client=cast(openai.AsyncClient, oai_client),
        progress_callback=events.append,
    )

    assert result.exit_code == 1
    assert result.passed is False
    assert [item.scenario_id for item in result.results] == ["smoke-scenario"]
    assert result.results[0].passed is False
    assert [(event.kind, event.scenario_id) for event in events] == [
        ("suite_started", None),
        ("scenario_started", "smoke-scenario"),
        ("scenario_finished", "smoke-scenario"),
    ]


# ---------------------------------------------------------------------------
# Gap-coverage tests (added to guarantee every behavior introduced on this
# branch is exercised, so the TS port can mirror them 1-1).
# ---------------------------------------------------------------------------


def test_prepared_scenario_run_display_id_suffixes_iterations() -> None:
    from agentprobe.runner import _PreparedScenarioRun

    def factory():  # pragma: no cover - never invoked
        raise AssertionError

    scenario = build_scenario(turns=[{"role": "user", "content": "hi"}])
    persona = build_persona()
    rubric = build_rubric()

    first = _PreparedScenarioRun(
        adapter_factory=factory,
        scenario=scenario,
        persona=persona,
        rubric=rubric,
        ordinal=0,
        total=2,
        iteration=1,
    )
    second = _PreparedScenarioRun(
        adapter_factory=factory,
        scenario=scenario,
        persona=persona,
        rubric=rubric,
        ordinal=1,
        total=2,
        iteration=2,
    )
    assert first.display_id == scenario.id
    assert second.display_id == f"{scenario.id}#2"
    assert first.index == 1 and second.index == 2


@pytest.mark.anyio
async def test_run_scenario_warns_on_invalid_base_date_and_falls_back():
    adapter = FakeAdapter(
        [AdapterReply(assistant_text="Handled.")],
    )
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("continue", "Please change booking FLT-29481."),
            build_persona_step("completed"),
            build_score(),
        ]
    )
    scenario = Scenario.model_validate(
        {
            "id": "bad-base-date",
            "name": "Bad base date",
            "persona": "business-traveler",
            "rubric": "customer-support",
            "base_date": "not-a-date",
            "context": {
                "system_prompt": "You are a travel assistant.",
                "injected_data": {"booking_id": "FLT-29481"},
            },
            "turns": [{"role": "user", "content": None}],
            "expectations": {
                "expected_behavior": "Help.",
                "expected_outcome": "resolved",
            },
        }
    )

    with pytest.warns(UserWarning, match="Invalid base_date"):
        result = await run_scenario(
            adapter,
            scenario,
            build_persona(),
            build_rubric(),
            defaults=ScenarioDefaults(max_turns=1),
            oai_client=cast(openai.AsyncClient, oai_client),
        )
    assert result.scenario_id == "bad-base-date"


@pytest.mark.anyio
async def test_run_scenario_dry_run_returns_placeholder_result():
    scenario = build_scenario(turns=[{"role": "user", "content": "hi"}])
    adapter = FakeAdapter([])  # adapter should never be touched under dry_run
    oai_client = FakeOpenAIClient()
    result = await run_scenario(
        adapter,
        scenario,
        build_persona(),
        build_rubric(),
        oai_client=cast(openai.AsyncClient, oai_client),
        dry_run=True,
        user_id="fixed-user",
    )
    assert result.passed is True
    assert result.overall_score == 0.0
    assert result.user_id == "fixed-user"
    assert result.transcript == []
    # Dry-run short-circuits before any adapter call.
    assert adapter.health_calls == []
    assert adapter.open_calls == []


@pytest.mark.anyio
async def test_run_suite_missing_persona_raises_config_error(tmp_path: Path):
    from agentprobe.errors import AgentProbeConfigError

    endpoint_path = tmp_path / "endpoint.yaml"
    endpoint_path.write_text(
        """
transport: http
connection:
  base_url: http://example.test
request:
  method: POST
  url: "{{ base_url }}/chat"
response:
  format: text
  content_path: "$"
""".strip(),
        encoding="utf-8",
    )
    personas_path = tmp_path / "personas.yaml"
    personas_path.write_text("personas: []", encoding="utf-8")
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
    name: CS
    pass_threshold: 0.7
    meta_prompt: Judge.
    dimensions:
      - id: task_completion
        name: TC
        weight: 1.0
        scale: {type: likert, points: 5, labels: {1: bad, 5: good}}
        judge_prompt: Check.
""".strip(),
        encoding="utf-8",
    )
    scenarios_path = tmp_path / "scenarios.yaml"
    scenarios_path.write_text(
        """
scenarios:
  - id: orphan
    name: Orphan
    rubric: customer-support
    turns:
      - {role: user, content: hi}
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )

    def adapter_factory(endpoint: Endpoints) -> FakeAdapter:
        return FakeAdapter([AdapterReply(assistant_text="x")])

    with pytest.raises(AgentProbeConfigError, match="has no persona"):
        await run_suite(
            endpoint=endpoint_path,
            scenarios=scenarios_path,
            personas=personas_path,
            rubric=rubric_path,
            adapter_factory=adapter_factory,
            oai_client=cast(openai.AsyncClient, FakeOpenAIClient()),
        )


@pytest.mark.anyio
async def test_run_suite_unknown_persona_raises_config_error(tmp_path: Path):
    from agentprobe.errors import AgentProbeConfigError

    endpoint_path = tmp_path / "endpoint.yaml"
    endpoint_path.write_text(
        """
transport: http
connection:
  base_url: http://example.test
request:
  method: POST
  url: "{{ base_url }}/chat"
response:
  format: text
  content_path: "$"
""".strip(),
        encoding="utf-8",
    )
    personas_path = tmp_path / "personas.yaml"
    personas_path.write_text("personas: []", encoding="utf-8")
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
    name: CS
    pass_threshold: 0.7
    meta_prompt: Judge.
    dimensions:
      - id: task_completion
        name: TC
        weight: 1.0
        scale: {type: likert, points: 5, labels: {1: bad, 5: good}}
        judge_prompt: Check.
""".strip(),
        encoding="utf-8",
    )
    scenarios_path = tmp_path / "scenarios.yaml"
    scenarios_path.write_text(
        """
scenarios:
  - id: ghost
    name: Ghost
    persona: does-not-exist
    rubric: customer-support
    turns:
      - {role: user, content: hi}
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )

    def adapter_factory(endpoint: Endpoints) -> FakeAdapter:
        return FakeAdapter([AdapterReply(assistant_text="x")])

    with pytest.raises(AgentProbeConfigError, match="unknown persona"):
        await run_suite(
            endpoint=endpoint_path,
            scenarios=scenarios_path,
            personas=personas_path,
            rubric=rubric_path,
            adapter_factory=adapter_factory,
            oai_client=cast(openai.AsyncClient, FakeOpenAIClient()),
        )


@pytest.mark.anyio
async def test_run_suite_missing_rubric_and_unknown_rubric_raise_config_error(
    tmp_path: Path,
):
    from agentprobe.errors import AgentProbeConfigError

    endpoint_path = tmp_path / "endpoint.yaml"
    endpoint_path.write_text(
        """
transport: http
connection:
  base_url: http://example.test
request:
  method: POST
  url: "{{ base_url }}/chat"
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
  - id: p
    name: P
    demographics: {role: x, tech_literacy: high, domain_expertise: basic, language_style: terse}
    personality: {patience: 2, assertiveness: 2, detail_orientation: 2, cooperativeness: 2, emotional_intensity: 2}
    behavior: {opening_style: Hi., follow_up_style: Yes., escalation_triggers: [], topic_drift: none, clarification_compliance: high}
    system_prompt: P.
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
    name: CS
    pass_threshold: 0.7
    meta_prompt: Judge.
    dimensions:
      - id: task_completion
        name: TC
        weight: 1.0
        scale: {type: likert, points: 5, labels: {1: bad, 5: good}}
        judge_prompt: Check.
""".strip(),
        encoding="utf-8",
    )

    def adapter_factory(endpoint: Endpoints) -> FakeAdapter:
        return FakeAdapter([AdapterReply(assistant_text="x")])

    # Scenario with no rubric and no defaults rubric
    scenarios_path = tmp_path / "scenarios.yaml"
    scenarios_path.write_text(
        """
scenarios:
  - id: no-rubric
    name: No rubric
    persona: p
    turns:
      - {role: user, content: hi}
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )
    with pytest.raises(AgentProbeConfigError, match="has no rubric"):
        await run_suite(
            endpoint=endpoint_path,
            scenarios=scenarios_path,
            personas=personas_path,
            rubric=rubric_path,
            adapter_factory=adapter_factory,
            oai_client=cast(openai.AsyncClient, FakeOpenAIClient()),
        )

    # Scenario referencing an unknown rubric id
    scenarios_path.write_text(
        """
scenarios:
  - id: ghost-rubric
    name: Ghost rubric
    persona: p
    rubric: nope
    turns:
      - {role: user, content: hi}
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )
    with pytest.raises(AgentProbeConfigError, match="unknown rubric"):
        await run_suite(
            endpoint=endpoint_path,
            scenarios=scenarios_path,
            personas=personas_path,
            rubric=rubric_path,
            adapter_factory=adapter_factory,
            oai_client=cast(openai.AsyncClient, FakeOpenAIClient()),
        )


@pytest.mark.anyio
async def test_run_suite_without_adapter_factory_builds_from_endpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    endpoint_path = tmp_path / "endpoint.yaml"
    endpoint_path.write_text(
        """
transport: http
connection:
  base_url: http://example.test
request:
  method: POST
  url: "{{ base_url }}/chat"
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
  - id: p
    name: P
    demographics: {role: x, tech_literacy: high, domain_expertise: basic, language_style: terse}
    personality: {patience: 2, assertiveness: 2, detail_orientation: 2, cooperativeness: 2, emotional_intensity: 2}
    behavior: {opening_style: Hi., follow_up_style: Yes., escalation_triggers: [], topic_drift: none, clarification_compliance: high}
    system_prompt: P.
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
    name: CS
    pass_threshold: 0.7
    meta_prompt: Judge.
    dimensions:
      - id: task_completion
        name: TC
        weight: 1.0
        scale: {type: likert, points: 5, labels: {1: bad, 5: good}}
        judge_prompt: Check.
""".strip(),
        encoding="utf-8",
    )
    scenarios_path = tmp_path / "scenarios.yaml"
    scenarios_path.write_text(
        """
defaults: {max_turns: 1}
scenarios:
  - id: s
    name: S
    persona: p
    rubric: customer-support
    turns:
      - {role: user, content: hi}
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )

    built_with: list[dict[str, object]] = []
    fake_adapter = FakeAdapter([AdapterReply(assistant_text="x")])

    def fake_build_endpoint_adapter(endpoint_config, autogpt_auth_resolver=None):
        built_with.append({"resolver": autogpt_auth_resolver})
        return fake_adapter

    monkeypatch.setattr(
        "agentprobe.runner.build_endpoint_adapter", fake_build_endpoint_adapter
    )

    async def fake_run_scenario(
        adapter,
        scenario,
        persona,
        rubric,
        *,
        defaults=None,
        oai_client,
        recorder=None,
        scenario_ordinal=None,
        dry_run=False,
        adapter_factory=None,
        user_id=None,
    ) -> ScenarioRunResult:
        # Invoke the factory once to hit the no-adapter-factory fallback path.
        built_adapter = adapter_factory() if adapter_factory else adapter
        assert built_adapter is fake_adapter
        return ScenarioRunResult(
            scenario_id=scenario.id,
            scenario_name=scenario.name,
            persona_id=persona.id,
            rubric_id=rubric.id,
            user_id=user_id,
            passed=True,
            overall_score=1.0,
        )

    monkeypatch.setattr("agentprobe.runner.run_scenario", fake_run_scenario)

    result = await run_suite(
        endpoint=endpoint_path,
        scenarios=scenarios_path,
        personas=personas_path,
        rubric=rubric_path,
        oai_client=cast(openai.AsyncClient, FakeOpenAIClient()),
    )
    assert result.exit_code == 0
    assert len(built_with) >= 1
    # Also invoke the resolver closure so its body (which imports resolve_auth)
    # is executed; we stub resolve_auth to avoid touching the real AutoGPT module.
    resolver = built_with[-1]["resolver"]
    assert callable(resolver)
    monkeypatch.setattr(
        "agentprobe.endpoints.autogpt.resolve_auth",
        lambda user_id: {"user_id": user_id},
    )
    assert resolver() == {"user_id": result.results[0].user_id}


def test_evaluate_checkpoint_turn_response_must_not_contain() -> None:
    from agentprobe.data.scenarios import CheckpointAssertion
    from agentprobe.runner import _evaluate_checkpoint_turn

    reply = AdapterReply(assistant_text="Sorry, I cannot help with that.")
    result = _evaluate_checkpoint_turn(
        [CheckpointAssertion(response_must_not_contain=["cannot help"])],
        reply,
    )
    assert result.passed is False
    assert any("cannot help" in f for f in result.failures)

    ok = _evaluate_checkpoint_turn(
        [CheckpointAssertion(response_must_not_contain=["never said"])],
        reply,
    )
    assert ok.passed is True


def test_overall_score_scoring_overrides_below_and_above_flip_passed() -> None:
    from agentprobe.data.rubrics import ScoreThreshold, ScoringOverrides
    from agentprobe.runner import _overall_score

    base_rubric = build_rubric()

    # Passing score; then auto-fail because below threshold
    rubric_below = base_rubric.model_copy(
        update={
            "scoring_overrides": ScoringOverrides(
                auto_fail_conditions=[
                    ScoreThreshold(dimension="task_completion", below=5)
                ]
            )
        }
    )
    score = build_score(score=4, passed=True)
    overall = _overall_score(rubric_below, score)
    assert overall == pytest.approx(0.8)
    assert score.passed is False

    # Auto-fail because above threshold
    rubric_above = base_rubric.model_copy(
        update={
            "scoring_overrides": ScoringOverrides(
                auto_fail_conditions=[
                    ScoreThreshold(dimension="task_completion", above=3)
                ]
            )
        }
    )
    score2 = build_score(score=4, passed=True)
    _overall_score(rubric_above, score2)
    assert score2.passed is False

    # Condition pointing to an unknown dimension is a no-op (the `continue`
    # branch). We should still return a sane overall_score and leave passed.
    rubric_unknown = base_rubric.model_copy(
        update={
            "scoring_overrides": ScoringOverrides(
                auto_fail_conditions=[
                    ScoreThreshold(dimension="not-a-dimension", below=10)
                ]
            )
        }
    )
    score3 = build_score(score=4, passed=True)
    _overall_score(rubric_unknown, score3)
    assert score3.passed is True


@pytest.mark.anyio
async def test_run_suite_parallel_emits_scenario_error_event_and_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    endpoint_path = tmp_path / "endpoint.yaml"
    endpoint_path.write_text(
        """
transport: http
connection:
  base_url: http://example.test
request:
  method: POST
  url: "{{ base_url }}/chat"
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
  - id: p
    name: P
    demographics: {role: x, tech_literacy: high, domain_expertise: basic, language_style: terse}
    personality: {patience: 2, assertiveness: 2, detail_orientation: 2, cooperativeness: 2, emotional_intensity: 2}
    behavior: {opening_style: Hi., follow_up_style: Yes., escalation_triggers: [], topic_drift: none, clarification_compliance: high}
    system_prompt: P.
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
    name: CS
    pass_threshold: 0.7
    meta_prompt: Judge.
    dimensions:
      - id: task_completion
        name: TC
        weight: 1.0
        scale: {type: likert, points: 5, labels: {1: bad, 5: good}}
        judge_prompt: Check.
""".strip(),
        encoding="utf-8",
    )
    scenarios_path = tmp_path / "scenarios.yaml"
    scenarios_path.write_text(
        """
defaults: {max_turns: 1}
scenarios:
  - id: boom
    name: Boom
    persona: p
    rubric: customer-support
    turns:
      - {role: user, content: hi}
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )

    async def fake_run_scenario(*args, **kwargs) -> ScenarioRunResult:
        raise RuntimeError("scenario explosion")

    monkeypatch.setattr("agentprobe.runner.run_scenario", fake_run_scenario)

    def adapter_factory(endpoint: Endpoints) -> FakeAdapter:
        return FakeAdapter([AdapterReply(assistant_text="x")])

    events: list[RunProgressEvent] = []
    with pytest.raises(RuntimeError, match="scenario explosion"):
        await run_suite(
            endpoint=endpoint_path,
            scenarios=scenarios_path,
            personas=personas_path,
            rubric=rubric_path,
            adapter_factory=adapter_factory,
            oai_client=cast(openai.AsyncClient, FakeOpenAIClient()),
            progress_callback=events.append,
            parallel=True,
            repeat=2,
        )

    kinds = [e.kind for e in events]
    assert "scenario_error" in kinds
    # repeat=2 → second iteration display_id carries #2 suffix
    error_events = [e for e in events if e.kind == "scenario_error"]
    assert any(e.scenario_id == "boom#2" for e in error_events)
    assert all(isinstance(e.error, RuntimeError) for e in error_events)
