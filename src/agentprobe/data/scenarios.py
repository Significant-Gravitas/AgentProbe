from __future__ import annotations

from pathlib import Path
from typing import Literal, TypeAlias, cast

from pydantic import Field
from pydantic import model_validator

from .common import (
    AgentProbeModel,
    YamlPath,
    coerce_path,
    read_yaml,
)

JsonScalar: TypeAlias = str | int | float | bool | None
JsonFlatObject: TypeAlias = dict[str, JsonScalar]
JsonFlatList: TypeAlias = list[JsonScalar] | list[JsonFlatObject]
JsonValue: TypeAlias = JsonScalar | JsonFlatObject | JsonFlatList
ScenarioPriority: TypeAlias = Literal["critical", "high", "medium", "low"]
ExpectedOutcome: TypeAlias = Literal[
    "resolved",
    "escalated",
    "deflected",
    "failed",
    "clarified",
]
ResetPolicy: TypeAlias = Literal["none", "new", "fresh_agent"]


class ScenarioDefaults(AgentProbeModel):
    max_turns: int | None = None
    timeout_seconds: int | None = None
    persona: str | None = None
    rubric: str | None = None


class ScenarioContext(AgentProbeModel):
    system_prompt: str | None = None
    injected_data: dict[str, JsonValue] = Field(default_factory=dict)


class CheckpointAssertion(AgentProbeModel):
    tool_called: str | None = None
    with_args: dict[str, JsonValue] | None = None
    response_contains_any: list[str] = Field(default_factory=list)
    response_mentions: str | None = None


class UserTurn(AgentProbeModel):
    role: Literal["user"]
    content: str | None = None
    use_exact_message: bool = False

    @model_validator(mode="after")
    def validate_exact_message_content(self) -> "UserTurn":
        if self.use_exact_message and not isinstance(self.content, str):
            raise ValueError(
                "`use_exact_message` requires `content` so the exact user message can be rendered."
            )
        return self


class CheckpointTurn(AgentProbeModel):
    role: Literal["checkpoint"]
    assert_: list[CheckpointAssertion] = Field(alias="assert", default_factory=list)


class InjectTurn(AgentProbeModel):
    role: Literal["inject"]
    content: str | None = None


class ExpectedTool(AgentProbeModel):
    name: str
    required: bool | None = None
    call_order: int | None = None


class FailureMode(AgentProbeModel):
    """A named failure mode with distinct semantics for grading."""

    name: str
    description: str


class ScenarioExpectations(AgentProbeModel):
    must_include: list[str] = Field(default_factory=list)
    must_not_include: list[str] = Field(default_factory=list)
    expected_tools: list[ExpectedTool] = Field(default_factory=list)
    expected_behavior: str | None = None
    expected_outcome: ExpectedOutcome | None = None
    ground_truth: str | None = None
    escalation_required: bool | None = None
    max_tool_calls: int | None = None
    max_turns_before_escalation: int | None = None
    failure_modes: list[FailureMode] = Field(default_factory=list)
    tester_note: str | None = None


class Session(AgentProbeModel):
    """A session within a multi-session scenario."""

    id: str | None = None
    time_offset: str = "0h"
    reset: ResetPolicy = "none"
    turns: list[UserTurn | CheckpointTurn | InjectTurn] = Field(default_factory=list)


class Scenario(AgentProbeModel):
    id: str
    name: str
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    persona: str | None = None
    rubric: str | None = None
    max_turns: int | None = None
    priority: ScenarioPriority | None = None
    context: ScenarioContext | None = None
    turns: list[UserTurn | CheckpointTurn | InjectTurn] = Field(default_factory=list)
    sessions: list[Session] = Field(default_factory=list)
    expectations: ScenarioExpectations

    @model_validator(mode="after")
    def validate_turns_or_sessions(self) -> "Scenario":
        """Ensure backward compat: scenarios may use turns: or sessions: but
        both empty is also valid (expectations-only scenario)."""
        return self

    def effective_sessions(self) -> list[Session]:
        """Return the session list for execution.

        If the scenario uses flat ``turns:`` (legacy style), wrap them
        in a single synthetic session with ``reset=none``.  If the scenario
        uses ``sessions:``, return those directly.
        """
        if self.sessions:
            return self.sessions
        if self.turns:
            return [
                Session(
                    id="__flat__",
                    time_offset="0h",
                    reset="none",
                    turns=self.turns,
                )
            ]
        return []


class ScenariosMetadata(AgentProbeModel):
    version: str | None = None
    id: str | None = None
    name: str | None = None
    source_path: Path | None = None
    defaults: ScenarioDefaults | None = None
    tags_definition: list[str] = Field(default_factory=list)


class Scenarios(AgentProbeModel):
    metadata: ScenariosMetadata = Field(default_factory=ScenariosMetadata)
    scenarios: list[Scenario] = Field(default_factory=list)


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _parse_failure_modes(raw_list: list[object]) -> list[dict[str, str]]:
    """Convert the shorthand ``- name: description`` dicts into
    ``FailureMode``-compatible dicts."""
    result: list[dict[str, str]] = []
    for item in raw_list:
        if isinstance(item, dict):
            for key, value in item.items():
                result.append({"name": str(key), "description": str(value)})
        elif isinstance(item, str):
            result.append({"name": item, "description": item})
    return result


def parse_scenario_yaml(path: YamlPath) -> Scenarios:
    raw = read_yaml(path)

    raw_defaults = raw.get("defaults")
    defaults = (
        ScenarioDefaults.model_validate(raw_defaults)
        if isinstance(raw_defaults, dict)
        else None
    )

    raw_scenarios = cast(list[object], raw.get("scenarios", []))
    scenarios: list[Scenario] = []
    for raw_scenario in raw_scenarios:
        if not isinstance(raw_scenario, dict):
            continue
        payload = dict(raw_scenario)

        # Apply defaults for persona and rubric if not set at scenario level
        if defaults is not None:
            if "persona" not in payload and defaults.persona is not None:
                payload["persona"] = defaults.persona
            if "rubric" not in payload and defaults.rubric is not None:
                payload["rubric"] = defaults.rubric

        # Normalize failure_modes shorthand
        expectations = payload.get("expectations")
        if isinstance(expectations, dict):
            raw_fm = expectations.get("failure_modes")
            if isinstance(raw_fm, list):
                expectations["failure_modes"] = _parse_failure_modes(raw_fm)

        scenarios.append(Scenario.model_validate(payload))

    return Scenarios(
        metadata=ScenariosMetadata(
            version=_optional_str(raw.get("version")),
            id=_optional_str(raw.get("id")),
            name=_optional_str(raw.get("name")),
            source_path=coerce_path(path),
            defaults=defaults,
            tags_definition=cast(list[str], raw.get("tags_definition", [])),
        ),
        scenarios=scenarios,
    )


__all__ = [
    "CheckpointAssertion",
    "CheckpointTurn",
    "ExpectedTool",
    "FailureMode",
    "InjectTurn",
    "ResetPolicy",
    "Scenario",
    "ScenarioContext",
    "ScenarioDefaults",
    "ScenarioExpectations",
    "Scenarios",
    "ScenariosMetadata",
    "Session",
    "UserTurn",
    "parse_scenario_yaml",
]
