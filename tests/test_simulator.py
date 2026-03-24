from __future__ import annotations

from types import SimpleNamespace
from typing import cast

import openai
import pytest

from agentprobe.data.personas import Persona
from agentprobe.simulator import (
    ConversationTurn,
    generate_next_step,
)


class FakeResponsesAPI:
    def __init__(self, response: object):
        self.calls: list[dict[str, object]] = []
        self._response = response

    async def create(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        return self._response


class FakeClient:
    def __init__(self, response: object):
        self.responses = FakeResponsesAPI(response)


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


@pytest.mark.anyio
async def test_generate_next_step_uses_env_default_model(monkeypatch):
    monkeypatch.setenv("AGENTPROBE_PERSONA_MODEL", "env-persona-model")
    client = FakeClient(
        SimpleNamespace(output_text="I need to know when the refund will show up.")
    )

    result = await generate_next_step(
        build_persona(),
        [
            {"role": "user", "content": "My order arrived broken."},
            {
                "role": "assistant",
                "content": "I can help with that. Do you want a refund?",
            },
        ],
        oai_client=cast(openai.AsyncClient, client),
    )

    assert result == "I need to know when the refund will show up."
    assert len(client.responses.calls) == 1
    call = client.responses.calls[0]
    assert call["model"] == "env-persona-model"
    assert "Frustrated Customer" in str(call["instructions"])
    assert call["input"] == (
        "User: My order arrived broken.\n"
        "Assistant: I can help with that. Do you want a refund?"
    )


@pytest.mark.anyio
async def test_generate_next_step_prefers_persona_model_override(monkeypatch):
    monkeypatch.setenv("AGENTPROBE_PERSONA_MODEL", "env-persona-model")
    client = FakeClient(
        SimpleNamespace(output_text="Refund, and I need it processed today.")
    )

    await generate_next_step(
        build_persona(model="persona-override-model"),
        "User: My order is broken.\nAssistant: Do you want a refund or replacement?",
        oai_client=cast(openai.AsyncClient, client),
    )

    assert client.responses.calls[0]["model"] == "persona-override-model"


@pytest.mark.anyio
async def test_generate_next_step_ignores_checkpoint_turns():
    client = FakeClient(
        SimpleNamespace(output_text="Yes, order 1234. Can you fix this?")
    )

    result = await generate_next_step(
        build_persona(),
        [
            ConversationTurn(role="user", content="I was charged twice."),
            {"role": "checkpoint", "assert": [{"tool_called": "lookup_charge"}]},
            SimpleNamespace(
                role="assistant", content="I can check that. What is the order number?"
            ),
        ],
        oai_client=cast(openai.AsyncClient, client),
    )

    assert result == "Yes, order 1234. Can you fix this?"
    assert client.responses.calls[0]["input"] == (
        "User: I was charged twice.\n"
        "Assistant: I can check that. What is the order number?"
    )


@pytest.mark.anyio
async def test_generate_next_step_rejects_empty_response_text():
    client = FakeClient(SimpleNamespace(output_text="   "))

    with pytest.raises(ValueError, match="no text output"):
        await generate_next_step(
            build_persona(),
            [{"role": "user", "content": "Hello"}],
            oai_client=cast(openai.AsyncClient, client),
        )
