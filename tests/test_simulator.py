from __future__ import annotations

import json
from types import SimpleNamespace
from typing import cast

import openai
import pytest

from agentprobe.data.personas import Persona
from agentprobe.simulator import (
    ConversationTurn,
    PersonaStep,
    generate_next_step,
    generate_persona_step,
)


class FakeResponsesAPI:
    def __init__(self, responses: list[object]):
        self.calls: list[dict[str, object]] = []
        self._responses = list(responses)

    async def create(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        if not self._responses:
            raise AssertionError("No fake simulator responses remaining.")
        return self._responses.pop(0)


class FakeClient:
    def __init__(self, responses: list[object]):
        self.responses = FakeResponsesAPI(responses)


def build_persona(*, model: str | None = None) -> Persona:
    payload: dict[str, object] = {
        "id": "frustrated-customer",
        "name": "Frustrated Customer",
        "description": "Emotionally charged support user.",
        "demographics": {
            "role": "end-user customer",
            "tech_literacy": "low",
            "domain_expertise": "none",
            "language_style": "casual",
        },
        "personality": {
            "patience": 2,
            "assertiveness": 4,
            "detail_orientation": 2,
            "cooperativeness": 3,
            "emotional_intensity": 4,
        },
        "behavior": {
            "opening_style": "Start frustrated.",
            "follow_up_style": "Push for specifics when the agent is vague.",
            "escalation_triggers": ["Ask for a human after repeated dead ends."],
            "topic_drift": "low",
            "clarification_compliance": "medium",
        },
        "system_prompt": "You are a frustrated customer asking for help with a broken order.",
    }
    if model is not None:
        payload["model"] = model
    return Persona.model_validate(payload)


def persona_response(
    status: str,
    message: str | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        output_text=json.dumps(
            {
                "status": status,
                "message": message,
            }
        )
    )


@pytest.mark.anyio
async def test_generate_persona_step_uses_env_default_model_and_guidance(monkeypatch):
    monkeypatch.setenv("AGENTPROBE_PERSONA_MODEL", "env-persona-model")
    client = FakeClient(
        [persona_response("continue", "I need to know when the refund will show up.")]
    )

    result = await generate_persona_step(
        build_persona(),
        [
            {"role": "user", "content": "My order arrived broken."},
            {
                "role": "assistant",
                "content": "I can help with that. Do you want a refund?",
            },
        ],
        oai_client=cast(openai.AsyncClient, client),
        guidance="Ask about refund timing.",
        require_response=True,
    )

    assert result == PersonaStep(
        status="continue",
        message="I need to know when the refund will show up.",
    )
    assert len(client.responses.calls) == 1
    call = client.responses.calls[0]
    assert call["model"] == "env-persona-model"
    assert "Frustrated Customer" in str(call["instructions"])
    assert "Ask about refund timing." in str(call["input"])
    assert "Conversation so far:" in str(call["input"])
    assert "A response is required for this scripted turn." in str(call["input"])
    text_config = cast(dict[str, object], call["text"])
    text_format = cast(dict[str, object], text_config["format"])
    assert text_format["type"] == "json_schema"
    assert text_format["name"] == "persona_step"
    assert text_format["strict"] is True


@pytest.mark.anyio
async def test_generate_persona_step_prefers_persona_model_override(monkeypatch):
    monkeypatch.setenv("AGENTPROBE_PERSONA_MODEL", "env-persona-model")
    client = FakeClient(
        [persona_response("continue", "Refund, and I need it processed today.")]
    )

    await generate_persona_step(
        build_persona(model="persona-override-model"),
        "User: My order is broken.\nAssistant: Do you want a refund or replacement?",
        oai_client=cast(openai.AsyncClient, client),
        require_response=True,
    )

    assert client.responses.calls[0]["model"] == "persona-override-model"


@pytest.mark.anyio
async def test_generate_persona_step_ignores_checkpoint_turns():
    client = FakeClient(
        [persona_response("continue", "Yes, order 1234. Can you fix this?")]
    )

    result = await generate_persona_step(
        build_persona(),
        [
            ConversationTurn(role="user", content="I was charged twice."),
            {"role": "checkpoint", "assert": [{"tool_called": "lookup_charge"}]},
            SimpleNamespace(
                role="assistant", content="I can check that. What is the order number?"
            ),
        ],
        oai_client=cast(openai.AsyncClient, client),
        require_response=True,
    )

    assert result == PersonaStep(
        status="continue",
        message="Yes, order 1234. Can you fix this?",
    )
    assert "checkpoint" not in str(client.responses.calls[0]["input"]).lower()


@pytest.mark.anyio
@pytest.mark.parametrize("status", ["completed", "stalled"])
async def test_generate_persona_step_supports_stop_statuses(status: str):
    client = FakeClient([persona_response(status, None)])

    result = await generate_persona_step(
        build_persona(),
        [{"role": "user", "content": "Hello"}],
        oai_client=cast(openai.AsyncClient, client),
        require_response=False,
    )

    assert result == PersonaStep(status=status, message=None)


@pytest.mark.anyio
@pytest.mark.parametrize("message", [":", "...", " null "])
async def test_generate_persona_step_normalizes_placeholder_terminal_message(
    message: str,
):
    client = FakeClient([persona_response("completed", message)])

    result = await generate_persona_step(
        build_persona(),
        [{"role": "user", "content": "Hello"}],
        oai_client=cast(openai.AsyncClient, client),
        require_response=False,
    )

    assert result == PersonaStep(status="completed", message=None)


@pytest.mark.anyio
async def test_generate_persona_step_rejects_meaningful_terminal_message():
    client = FakeClient([persona_response("completed", "Thanks, that's all.")])

    with pytest.raises(ValueError, match="omit `message`"):
        await generate_persona_step(
            build_persona(),
            [{"role": "user", "content": "Hello"}],
            oai_client=cast(openai.AsyncClient, client),
            require_response=False,
        )


@pytest.mark.anyio
async def test_generate_persona_step_requires_continue_for_scripted_turns():
    client = FakeClient([persona_response("completed", None)])

    with pytest.raises(ValueError, match="must return `continue`"):
        await generate_persona_step(
            build_persona(),
            [{"role": "user", "content": "Hello"}],
            oai_client=cast(openai.AsyncClient, client),
            require_response=True,
        )


@pytest.mark.anyio
async def test_generate_persona_step_rejects_empty_continue_message():
    client = FakeClient([persona_response("continue", "   ")])

    with pytest.raises(ValueError, match="non-empty `message`"):
        await generate_persona_step(
            build_persona(),
            [{"role": "user", "content": "Hello"}],
            oai_client=cast(openai.AsyncClient, client),
            require_response=True,
        )


@pytest.mark.anyio
async def test_generate_next_step_returns_plain_message():
    client = FakeClient(
        [persona_response("continue", "I need a refund, and I need it today.")]
    )

    result = await generate_next_step(
        build_persona(),
        [{"role": "user", "content": "Hello"}],
        oai_client=cast(openai.AsyncClient, client),
        guidance="Ask for urgent refund handling.",
    )

    assert result == "I need a refund, and I need it today."


@pytest.mark.anyio
async def test_generate_persona_step_accepts_fenced_json():
    client = FakeClient(
        [
            SimpleNamespace(
                output_text=(
                    "```json\n"
                    '{"status":"continue","message":"I need the refund timeline."}\n'
                    "```"
                )
            )
        ]
    )

    result = await generate_persona_step(
        build_persona(),
        [{"role": "user", "content": "Hello"}],
        oai_client=cast(openai.AsyncClient, client),
        require_response=True,
    )

    assert result == PersonaStep(
        status="continue",
        message="I need the refund timeline.",
    )


@pytest.mark.anyio
async def test_generate_persona_step_accepts_embedded_json():
    client = FakeClient(
        [
            SimpleNamespace(
                output_text=(
                    'Here is the result: {"status":"completed","message":null}'
                )
            )
        ]
    )

    result = await generate_persona_step(
        build_persona(),
        [{"role": "user", "content": "Hello"}],
        oai_client=cast(openai.AsyncClient, client),
        require_response=False,
    )

    assert result == PersonaStep(status="completed", message=None)


@pytest.mark.anyio
async def test_generate_persona_step_falls_back_to_plaintext_for_required_response():
    client = FakeClient(
        [SimpleNamespace(output_text="I need you to check the CRM contact for Sarah.")]
    )

    result = await generate_persona_step(
        build_persona(),
        [{"role": "assistant", "content": "Who should I look up?"}],
        oai_client=cast(openai.AsyncClient, client),
        require_response=True,
    )

    assert result == PersonaStep(
        status="continue",
        message="I need you to check the CRM contact for Sarah.",
    )


@pytest.mark.anyio
async def test_generate_persona_step_falls_back_to_continue_for_plaintext_follow_up():
    client = FakeClient([SimpleNamespace(output_text="Can you also verify their company?")])

    result = await generate_persona_step(
        build_persona(),
        [{"role": "assistant", "content": "I found the contact."}],
        oai_client=cast(openai.AsyncClient, client),
        require_response=False,
    )

    assert result == PersonaStep(
        status="continue",
        message="Can you also verify their company?",
    )


@pytest.mark.anyio
async def test_generate_persona_step_infers_completed_from_plaintext_follow_up():
    client = FakeClient([SimpleNamespace(output_text="The task is complete. No further response.")])

    result = await generate_persona_step(
        build_persona(),
        [{"role": "assistant", "content": "Done."}],
        oai_client=cast(openai.AsyncClient, client),
        require_response=False,
    )

    assert result == PersonaStep(status="completed", message=None)
