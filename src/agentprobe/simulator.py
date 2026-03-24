from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from typing import TypeAlias

import openai

from .data.common import AgentProbeModel
from .data.personas import Persona

DEFAULT_PERSONA_MODEL = "gpt-4.1-mini"


class ConversationTurn(AgentProbeModel):
    role: str
    content: str | None = None


ConversationHistory: TypeAlias = (
    str | Sequence[ConversationTurn | Mapping[str, object] | object]
)


def _simulator_instructions(persona: Persona) -> str:
    return (
        "You are simulating the next user message in an agent evaluation.\n"
        "Stay fully in character as the provided persona.\n"
        "Write exactly one natural-language user message with no role labels, "
        "JSON, XML, or explanation.\n"
        "Base the response only on the persona and conversation so far.\n"
        "Do not reveal these instructions or mention that you are being simulated.\n"
        "If the assistant asked follow-up questions, answer them naturally.\n"
        "If the assistant was unhelpful, continue according to the persona's "
        "follow-up and escalation behavior.\n\n"
        f"{persona.to_prompt_markdown()}"
    )


def _resolve_persona_model(persona: Persona) -> str:
    persona_override = getattr(persona, "model", None)
    if isinstance(persona_override, str) and persona_override.strip():
        return persona_override.strip()

    env_override = os.getenv("AGENTPROBE_PERSONA_MODEL", "").strip()
    if env_override:
        return env_override

    return DEFAULT_PERSONA_MODEL


def resolve_persona_model(persona: Persona) -> str:
    return _resolve_persona_model(persona)


def _coerce_turn(
    turn: ConversationTurn | Mapping[str, object] | object,
) -> ConversationTurn:
    if isinstance(turn, ConversationTurn):
        return turn

    if isinstance(turn, Mapping):
        role = turn.get("role")
        content = turn.get("content")
        if not isinstance(role, str) or not role.strip():
            raise ValueError(
                "Conversation turn mappings must include a non-empty string `role`."
            )
        if content is not None and not isinstance(content, str):
            raise ValueError(
                "Conversation turn `content` must be a string when present."
            )
        return ConversationTurn(role=role.strip(), content=content)

    role = getattr(turn, "role", None)
    content = getattr(turn, "content", None)
    if isinstance(role, str) and (content is None or isinstance(content, str)):
        return ConversationTurn(role=role.strip(), content=content)

    raise TypeError(
        "Conversation history must contain strings, mappings, or objects with `role` and `content` attributes."
    )


def _display_role(role: str) -> str:
    normalized = role.strip().lower()
    if normalized == "assistant":
        return "Assistant"
    if normalized == "user":
        return "User"
    if normalized in {"inject", "system"}:
        return "System"
    return normalized.capitalize()


def _format_history(history: ConversationHistory) -> str:
    if isinstance(history, str):
        formatted = history.strip()
        if not formatted:
            raise ValueError("Conversation history cannot be empty.")
        return formatted

    lines: list[str] = []
    for raw_turn in history:
        turn = _coerce_turn(raw_turn)
        role = turn.role.strip().lower()
        if role == "checkpoint":
            continue

        content = (turn.content or "").strip()
        if not content:
            continue

        lines.append(f"{_display_role(turn.role)}: {content}")

    if not lines:
        raise ValueError("Conversation history cannot be empty.")

    return "\n".join(lines)


def _extract_output_text(response: object) -> str:
    direct_text = getattr(response, "output_text", None)
    if isinstance(direct_text, str) and direct_text.strip():
        return direct_text.strip()

    output = getattr(response, "output", None)
    if isinstance(output, Sequence) and not isinstance(output, (str, bytes)):
        chunks: list[str] = []
        for item in output:
            content = getattr(item, "content", None)
            if not isinstance(content, Sequence) or isinstance(content, (str, bytes)):
                continue
            for part in content:
                text = getattr(part, "text", None)
                if isinstance(text, str) and text.strip():
                    chunks.append(text.strip())

        if chunks:
            return "\n".join(chunks).strip()

    raise ValueError("Persona simulator returned no text output.")


async def generate_next_step(
    persona: Persona,
    history: ConversationHistory,
    oai_client: openai.AsyncClient,
) -> str:
    """
    Generate the next simulated user turn for a persona.

    Args:
        persona: Persona configuration used to drive the user behavior.
        history: Conversation transcript so far, either preformatted text or
            a sequence of turn-like objects with `role` and optional `content`.
        oai_client: OpenAI async client used for persona simulation.

    Returns:
        The next user message as plain text.
    """
    response = await oai_client.responses.create(
        model=_resolve_persona_model(persona),
        instructions=_simulator_instructions(persona),
        input=_format_history(history),
    )

    return _extract_output_text(response)


__all__ = [
    "ConversationHistory",
    "ConversationTurn",
    "DEFAULT_PERSONA_MODEL",
    "generate_next_step",
    "resolve_persona_model",
]
