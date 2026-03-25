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


class ScenarioDefaults(AgentProbeModel):
    max_turns: int | None = None
    timeout_seconds: int | None = None


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


class Scenario(AgentProbeModel):
    id: str
    name: str
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    persona: str
    rubric: str
    max_turns: int | None = None
    priority: ScenarioPriority | None = None
    context: ScenarioContext | None = None
    turns: list[UserTurn | CheckpointTurn | InjectTurn] = Field(default_factory=list)
    expectations: ScenarioExpectations


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


def parse_scenario_yaml(path: YamlPath) -> Scenarios:
    raw = read_yaml(path)
    return Scenarios(
        metadata=ScenariosMetadata(
            version=_optional_str(raw.get("version")),
            id=_optional_str(raw.get("id")),
            name=_optional_str(raw.get("name")),
            source_path=coerce_path(path),
            defaults=cast(ScenarioDefaults | None, raw.get("defaults")),
            tags_definition=cast(list[str], raw.get("tags_definition", [])),
        ),
        scenarios=cast(list[Scenario], raw.get("scenarios", [])),
    )


__all__ = [
    "CheckpointAssertion",
    "CheckpointTurn",
    "ExpectedTool",
    "InjectTurn",
    "Scenario",
    "ScenarioContext",
    "ScenarioDefaults",
    "ScenarioExpectations",
    "Scenarios",
    "ScenariosMetadata",
    "UserTurn",
    "parse_scenario_yaml",
]
