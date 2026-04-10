"""Tests for multi-session reset behaviour, turn isolation, and boundary markers."""

from __future__ import annotations

import warnings
from typing import cast

import openai
import pytest

from agentprobe.adapters import AdapterReply
from agentprobe.data.scenarios import Scenario, ScenarioDefaults
from agentprobe.runner import ScenarioRunResult, run_scenario
from agentprobe.simulator import ConversationTurn

from test_runner import (
    FakeAdapter,
    FakeOpenAIClient,
    build_persona,
    build_persona_step,
    build_rubric,
    build_score,
)


def _build_multi_session_scenario(
    *,
    sessions: list[dict[str, object]],
    scenario_id: str = "multi-session",
    scenario_name: str = "Multi Session",
) -> Scenario:
    return Scenario.model_validate(
        {
            "id": scenario_id,
            "name": scenario_name,
            "persona": "business-traveler",
            "rubric": "customer-support",
            "context": {
                "system_prompt": "You are a travel assistant.",
                "injected_data": {"booking_id": "FLT-29481"},
            },
            "sessions": sessions,
            "expectations": {
                "expected_behavior": "Handle multi-session interactions.",
                "expected_outcome": "resolved",
            },
        }
    )


# -------------------------------------------------------------------
# Flow for use_exact_message=True:
#   - Scripted turn: NO persona step consumed (text is used as-is)
#   - After scripted turns: continuation loop calls generate_persona_step
#     (require_response=False). A "completed" step breaks the loop.
# So each session with N exact-message turns needs:
#   N adapter replies + 1 OAI "completed" step for continuation
# Then at the very end: 1 OAI score response.
# -------------------------------------------------------------------


@pytest.mark.anyio
async def test_reset_none_preserves_adapter_and_state():
    """reset: none -- same adapter, same session state, turn counter accumulates."""
    adapter = FakeAdapter(
        [
            AdapterReply(assistant_text="Got it, session one."),
            AdapterReply(assistant_text="Still here, session two."),
        ]
    )
    # S1: 1 exact turn -> continuation "completed"
    # S2 (reset=none): 1 exact turn -> continuation "completed"
    # Judge score
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("completed"),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    scenario = _build_multi_session_scenario(
        sessions=[
            {
                "id": "s1",
                "time_offset": "0h",
                "reset": "none",
                "turns": [
                    {"role": "user", "content": "First message.", "use_exact_message": True},
                ],
            },
            {
                "id": "s2",
                "time_offset": "1h",
                "reset": "none",
                "turns": [
                    {"role": "user", "content": "Second message.", "use_exact_message": True},
                ],
            },
        ]
    )

    result = await run_scenario(
        adapter,
        scenario,
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=5),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    sent_messages = [
        cast(ConversationTurn, call["last_message"]).content
        for call in adapter.send_calls
    ]
    assert sent_messages == ["First message.", "Second message."]

    assert len(adapter.open_calls) == 1, (
        "reset=none must NOT re-open the scenario"
    )

    assert len(adapter.send_calls) == 2


@pytest.mark.anyio
async def test_reset_new_clears_state_and_reopens():
    """reset: new -- same adapter but session state cleared, turn counter resets, new open_scenario called."""
    adapter = FakeAdapter(
        [
            AdapterReply(assistant_text="Session one reply."),
            AdapterReply(assistant_text="Session two reply."),
        ],
        session_state={"token": "abc123"},
    )
    # S1: 1 exact turn -> continuation "completed"
    # S2 (reset=new): 1 exact turn -> continuation "completed"
    # Judge score
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("completed"),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    scenario = _build_multi_session_scenario(
        sessions=[
            {
                "id": "s1",
                "time_offset": "0h",
                "reset": "none",
                "turns": [
                    {"role": "user", "content": "S1 turn.", "use_exact_message": True},
                ],
            },
            {
                "id": "s2",
                "time_offset": "24h",
                "reset": "new",
                "turns": [
                    {"role": "user", "content": "S2 turn.", "use_exact_message": True},
                ],
            },
        ]
    )

    result = await run_scenario(
        adapter,
        scenario,
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=5),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    assert len(adapter.open_calls) == 2, "reset=new must call open_scenario again"
    assert len(adapter.close_calls) >= 1, "reset=new must close the previous session"
    assert result.passed is True


@pytest.mark.anyio
async def test_reset_fresh_agent_creates_new_adapter():
    """reset: fresh_agent -- new adapter from factory, session state cleared."""
    adapters_created: list[FakeAdapter] = []

    def adapter_factory() -> FakeAdapter:
        new_adapter = FakeAdapter(
            [AdapterReply(assistant_text=f"Reply from adapter {len(adapters_created) + 1}.")],
        )
        adapters_created.append(new_adapter)
        return new_adapter

    first_adapter = FakeAdapter(
        [AdapterReply(assistant_text="Reply from initial adapter.")],
    )

    # S1: 1 exact turn -> continuation "completed"
    # S2 (reset=fresh_agent): 1 exact turn -> continuation "completed"
    # Judge score
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("completed"),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    scenario = _build_multi_session_scenario(
        sessions=[
            {
                "id": "s1",
                "time_offset": "0h",
                "reset": "none",
                "turns": [
                    {"role": "user", "content": "S1 turn.", "use_exact_message": True},
                ],
            },
            {
                "id": "s2",
                "time_offset": "48h",
                "reset": "fresh_agent",
                "turns": [
                    {"role": "user", "content": "S2 turn.", "use_exact_message": True},
                ],
            },
        ]
    )

    result = await run_scenario(
        first_adapter,
        scenario,
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=5),
        oai_client=cast(openai.AsyncClient, oai_client),
        adapter_factory=adapter_factory,
    )

    assert len(adapters_created) == 1, "fresh_agent should create exactly one new adapter"

    assert len(first_adapter.send_calls) == 1, "initial adapter should handle S1"
    assert len(adapters_created[0].send_calls) == 1, "new adapter should handle S2"

    s1_msg = cast(ConversationTurn, first_adapter.send_calls[0]["last_message"]).content
    s2_msg = cast(ConversationTurn, adapters_created[0].send_calls[0]["last_message"]).content
    assert s1_msg == "S1 turn."
    assert s2_msg == "S2 turn."

    assert result.passed is True


@pytest.mark.anyio
async def test_fresh_agent_without_factory_degrades_to_new_with_warning():
    """fresh_agent without adapter_factory -- should emit a warning and degrade to 'new' behavior."""
    adapter = FakeAdapter(
        [
            AdapterReply(assistant_text="Session one."),
            AdapterReply(assistant_text="Session two."),
        ]
    )
    # S1: 1 exact turn -> continuation "completed"
    # S2 (degraded fresh_agent -> new): 1 exact turn -> continuation "completed"
    # Judge score
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("completed"),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    scenario = _build_multi_session_scenario(
        sessions=[
            {
                "id": "s1",
                "time_offset": "0h",
                "reset": "none",
                "turns": [
                    {"role": "user", "content": "S1.", "use_exact_message": True},
                ],
            },
            {
                "id": "s2",
                "time_offset": "48h",
                "reset": "fresh_agent",
                "turns": [
                    {"role": "user", "content": "S2.", "use_exact_message": True},
                ],
            },
        ]
    )

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        result = await run_scenario(
            adapter,
            scenario,
            build_persona(),
            build_rubric(),
            defaults=ScenarioDefaults(max_turns=5),
            oai_client=cast(openai.AsyncClient, oai_client),
        )

    degradation_warnings = [
        w for w in caught if "fresh_agent" in str(w.message) and "no adapter_factory" in str(w.message)
    ]
    assert len(degradation_warnings) >= 1, (
        f"Expected a degradation warning but got: {[str(w.message) for w in caught]}"
    )

    assert len(adapter.send_calls) == 2, "should still process both sessions with same adapter"
    assert len(adapter.open_calls) == 2, "degraded fresh_agent should still re-open scenario"
    assert result.passed is True


@pytest.mark.anyio
async def test_per_session_max_turns_stops_after_limit():
    """Session with max_turns=1 should stop after 1 user turn, next session starts fresh."""
    adapter = FakeAdapter(
        [
            AdapterReply(assistant_text="First session reply."),
            AdapterReply(assistant_text="Second session reply."),
        ]
    )
    # S1: 1 exact turn (max_turns=1 -> stops before continuation can run)
    # Note: when max_turns=1 and stop_session_on_max_turns=True, the
    # continuation loop may be cut short by the _ScenarioMaxTurnsExceeded
    # exception, so we need a continuation step just in case.
    # S2 (reset=new): 1 exact turn -> continuation "completed"
    # Judge score
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("completed"),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    scenario = _build_multi_session_scenario(
        sessions=[
            {
                "id": "s1",
                "time_offset": "0h",
                "reset": "none",
                "max_turns": 1,
                "turns": [
                    {"role": "user", "content": "S1 first turn.", "use_exact_message": True},
                ],
            },
            {
                "id": "s2",
                "time_offset": "24h",
                "reset": "new",
                "turns": [
                    {"role": "user", "content": "S2 turn.", "use_exact_message": True},
                ],
            },
        ]
    )

    result = await run_scenario(
        adapter,
        scenario,
        build_persona(),
        build_rubric(),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    sent_messages = [
        cast(ConversationTurn, call["last_message"]).content
        for call in adapter.send_calls
    ]
    assert "S1 first turn." in sent_messages
    assert "S2 turn." in sent_messages


@pytest.mark.anyio
async def test_turn_counter_isolation_across_sessions():
    """S1 with 3 turns, S2 with fresh_agent reset should start turn count at 0."""
    adapters_created: list[FakeAdapter] = []

    def adapter_factory() -> FakeAdapter:
        new_adapter = FakeAdapter(
            [AdapterReply(assistant_text="Fresh reply.")],
        )
        adapters_created.append(new_adapter)
        return new_adapter

    first_adapter = FakeAdapter(
        [
            AdapterReply(assistant_text="Reply 1."),
            AdapterReply(assistant_text="Reply 2."),
            AdapterReply(assistant_text="Reply 3."),
        ]
    )

    # S1: 3 exact turns -> continuation "completed"
    # S2 (fresh_agent): 1 exact turn -> continuation "completed"
    # Judge score
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("completed"),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    scenario = _build_multi_session_scenario(
        sessions=[
            {
                "id": "s1",
                "time_offset": "0h",
                "reset": "none",
                "max_turns": 5,
                "turns": [
                    {"role": "user", "content": "Turn 1.", "use_exact_message": True},
                    {"role": "user", "content": "Turn 2.", "use_exact_message": True},
                    {"role": "user", "content": "Turn 3.", "use_exact_message": True},
                ],
            },
            {
                "id": "s2",
                "time_offset": "48h",
                "reset": "fresh_agent",
                "max_turns": 3,
                "turns": [
                    {"role": "user", "content": "Fresh turn 1.", "use_exact_message": True},
                ],
            },
        ]
    )

    result = await run_scenario(
        first_adapter,
        scenario,
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=10),
        oai_client=cast(openai.AsyncClient, oai_client),
        adapter_factory=adapter_factory,
    )

    assert len(first_adapter.send_calls) == 3, "S1 should have 3 turns"
    assert len(adapters_created) == 1, "fresh_agent should create one new adapter"
    assert len(adapters_created[0].send_calls) == 1, "S2 should have 1 turn (reset counter)"
    assert result.passed is True


@pytest.mark.anyio
async def test_session_boundary_markers_in_transcript():
    """Verify boundary turns appear in full_transcript with correct format."""
    adapter = FakeAdapter(
        [
            AdapterReply(assistant_text="S1 reply."),
            AdapterReply(assistant_text="S2 reply."),
        ]
    )
    # S1: 1 exact turn -> continuation "completed"
    # S2 (reset=new): 1 exact turn -> continuation "completed"
    # Judge score
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("completed"),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    scenario = _build_multi_session_scenario(
        sessions=[
            {
                "id": "morning",
                "time_offset": "0h",
                "reset": "none",
                "turns": [
                    {"role": "user", "content": "S1 msg.", "use_exact_message": True},
                ],
            },
            {
                "id": "evening",
                "time_offset": "12h",
                "reset": "new",
                "turns": [
                    {"role": "user", "content": "S2 msg.", "use_exact_message": True},
                ],
            },
        ]
    )

    result = await run_scenario(
        adapter,
        scenario,
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=5),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    boundary_turns = [
        turn for turn in result.transcript
        if turn.role == "system" and "Session boundary" in (turn.content or "")
    ]
    assert len(boundary_turns) == 1, "Should have exactly one session boundary"

    boundary_content = boundary_turns[0].content or ""
    assert "session_id: evening" in boundary_content
    assert "reset_policy: new" in boundary_content
    assert "time_offset: 12h" in boundary_content


@pytest.mark.anyio
async def test_session_boundary_includes_user_id_when_provided():
    """Verify the session boundary content includes the user_id when supplied."""
    adapter = FakeAdapter(
        [
            AdapterReply(assistant_text="S1 reply."),
            AdapterReply(assistant_text="S2 reply."),
        ]
    )
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("completed"),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    scenario = _build_multi_session_scenario(
        sessions=[
            {
                "id": "s1",
                "time_offset": "0h",
                "reset": "none",
                "turns": [
                    {"role": "user", "content": "S1 msg.", "use_exact_message": True},
                ],
            },
            {
                "id": "s2",
                "time_offset": "1h",
                "reset": "new",
                "turns": [
                    {"role": "user", "content": "S2 msg.", "use_exact_message": True},
                ],
            },
        ]
    )

    test_user_id = "usr-abc-123-test"
    result = await run_scenario(
        adapter,
        scenario,
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=5),
        oai_client=cast(openai.AsyncClient, oai_client),
        user_id=test_user_id,
    )

    boundary_turns = [
        turn for turn in result.transcript
        if turn.role == "system" and "Session boundary" in (turn.content or "")
    ]
    assert len(boundary_turns) == 1
    assert f"user_id: {test_user_id}" in (boundary_turns[0].content or "")
    assert result.user_id == test_user_id


@pytest.mark.anyio
async def test_user_id_absent_from_boundary_when_not_provided():
    """Verify user_id is omitted from boundary content when not supplied."""
    adapter = FakeAdapter(
        [
            AdapterReply(assistant_text="S1."),
            AdapterReply(assistant_text="S2."),
        ]
    )
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("completed"),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    scenario = _build_multi_session_scenario(
        sessions=[
            {
                "id": "s1",
                "time_offset": "0h",
                "reset": "none",
                "turns": [
                    {"role": "user", "content": "S1.", "use_exact_message": True},
                ],
            },
            {
                "id": "s2",
                "time_offset": "1h",
                "reset": "new",
                "turns": [
                    {"role": "user", "content": "S2.", "use_exact_message": True},
                ],
            },
        ]
    )

    result = await run_scenario(
        adapter,
        scenario,
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=5),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    boundary_turns = [
        turn for turn in result.transcript
        if turn.role == "system" and "Session boundary" in (turn.content or "")
    ]
    assert len(boundary_turns) == 1
    assert "user_id:" not in (boundary_turns[0].content or "")
    assert result.user_id is None


@pytest.mark.anyio
async def test_user_id_stored_on_scenario_result():
    """Verify user_id is populated on the ScenarioRunResult when provided."""
    adapter = FakeAdapter(
        [AdapterReply(assistant_text="Hello.")],
    )
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("completed"),
            build_score(),
        ]
    )

    scenario = _build_multi_session_scenario(
        sessions=[
            {
                "id": "s1",
                "time_offset": "0h",
                "reset": "none",
                "turns": [
                    {"role": "user", "content": "Hi.", "use_exact_message": True},
                ],
            },
        ]
    )

    result = await run_scenario(
        adapter,
        scenario,
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=2),
        oai_client=cast(openai.AsyncClient, oai_client),
        user_id="test-user-42",
    )

    assert result.user_id == "test-user-42"


@pytest.mark.anyio
async def test_user_id_in_base_context():
    """Verify the user_id is available in the render context passed to adapter calls."""
    adapter = FakeAdapter(
        [AdapterReply(assistant_text="Hello.")],
    )
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("completed"),
            build_score(),
        ]
    )

    scenario = _build_multi_session_scenario(
        sessions=[
            {
                "id": "s1",
                "time_offset": "0h",
                "reset": "none",
                "turns": [
                    {"role": "user", "content": "Hi.", "use_exact_message": True},
                ],
            },
        ]
    )

    result = await run_scenario(
        adapter,
        scenario,
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=2),
        oai_client=cast(openai.AsyncClient, oai_client),
        user_id="context-user-99",
    )

    for call in adapter.open_calls:
        assert call.get("user_id") == "context-user-99"

    for call in adapter.send_calls:
        assert call.get("user_id") == "context-user-99"


@pytest.mark.anyio
async def test_three_sessions_produce_two_boundary_markers():
    """Three sessions should produce exactly two boundary markers."""
    adapter = FakeAdapter(
        [
            AdapterReply(assistant_text="R1."),
            AdapterReply(assistant_text="R2."),
            AdapterReply(assistant_text="R3."),
        ]
    )
    # S1: 1 exact turn -> continuation "completed"
    # S2 (reset=new): 1 exact turn -> continuation "completed"
    # S3 (reset=new): 1 exact turn -> continuation "completed"
    # Judge score
    oai_client = FakeOpenAIClient(
        create_responses=[
            build_persona_step("completed"),
            build_persona_step("completed"),
            build_persona_step("completed"),
            build_score(),
        ]
    )

    scenario = _build_multi_session_scenario(
        sessions=[
            {
                "id": "s1",
                "time_offset": "0h",
                "reset": "none",
                "turns": [
                    {"role": "user", "content": "T1.", "use_exact_message": True},
                ],
            },
            {
                "id": "s2",
                "time_offset": "1h",
                "reset": "new",
                "turns": [
                    {"role": "user", "content": "T2.", "use_exact_message": True},
                ],
            },
            {
                "id": "s3",
                "time_offset": "2h",
                "reset": "new",
                "turns": [
                    {"role": "user", "content": "T3.", "use_exact_message": True},
                ],
            },
        ]
    )

    result = await run_scenario(
        adapter,
        scenario,
        build_persona(),
        build_rubric(),
        defaults=ScenarioDefaults(max_turns=10),
        oai_client=cast(openai.AsyncClient, oai_client),
    )

    boundary_turns = [
        turn for turn in result.transcript
        if turn.role == "system" and "Session boundary" in (turn.content or "")
    ]
    assert len(boundary_turns) == 2

    assert "s2" in (boundary_turns[0].content or "")
    assert "s3" in (boundary_turns[1].content or "")
