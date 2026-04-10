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
    ) -> ScenarioRunResult:
        persona_id = persona.id
        rubric_id = rubric.id
        del (
            adapter,
            oai_client,
            recorder,
            scenario_ordinal,
            dry_run,
            adapter_factory,
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
    ) -> ScenarioRunResult:
        persona_id = persona.id
        rubric_id = rubric.id
        del (
            adapter,
            defaults,
            oai_client,
            recorder,
            dry_run,
            adapter_factory,
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
