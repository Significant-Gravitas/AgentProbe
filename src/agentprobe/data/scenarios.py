from __future__ import annotations

import re
from datetime import timedelta
from pathlib import Path
from typing import Literal, TypeAlias, cast

from pydantic import ConfigDict, Field
from pydantic import model_validator

from .common import (
    AgentProbeModel,
    YamlPath,
    coerce_path,
    iter_yaml_files,
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


def parse_time_offset(offset: str) -> timedelta:
    """Parse '48h', '7d', '0h' etc into timedelta."""
    match = re.fullmatch(r"(\d+)(h|d|m)", offset.strip())
    if not match:
        return timedelta()
    value, unit = int(match.group(1)), match.group(2)
    if unit == "h":
        return timedelta(hours=value)
    elif unit == "d":
        return timedelta(days=value)
    elif unit == "m":
        return timedelta(minutes=value)
    return timedelta()  # pragma: no cover - regex above restricts unit to h|d|m


CopilotMode: TypeAlias = Literal["fast", "extended_thinking"]


class ScenarioDefaults(AgentProbeModel):
    max_turns: int | None = None
    timeout_seconds: int | None = None
    persona: str | None = None
    rubric: str | None = None
    user_name: str | None = None
    copilot_mode: CopilotMode | None = None


class ScenarioContext(AgentProbeModel):
    system_prompt: str | None = None
    user_name: str | None = None
    copilot_mode: CopilotMode | None = None
    injected_data: dict[str, JsonValue] = Field(default_factory=dict)


class CheckpointAssertion(AgentProbeModel):
    tool_called: str | None = None
    with_args: dict[str, JsonValue] | None = None
    response_contains_any: list[str] = Field(default_factory=list)
    response_mentions: str | None = None
    response_must_not_contain: list[str] = Field(default_factory=list)


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


TurnType: TypeAlias = UserTurn | CheckpointTurn | InjectTurn


class FailureMode(AgentProbeModel):
    name: str
    description: str


class ScenarioExpectations(AgentProbeModel):
    model_config = ConfigDict(extra="allow")

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
    id: str | None = None
    time_offset: str = "0h"
    reset: ResetPolicy = "none"
    max_turns: int | None = None
    turns: list[TurnType] = Field(default_factory=list)


class Scenario(AgentProbeModel):
    model_config = ConfigDict(extra="allow")

    id: str
    name: str
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    persona: str | None = None
    rubric: str | None = None
    max_turns: int | None = None
    base_date: str | None = None
    priority: ScenarioPriority | None = None
    context: ScenarioContext | None = None
    turns: list[TurnType] = Field(default_factory=list)
    sessions: list[Session] = Field(default_factory=list)
    expectations: ScenarioExpectations

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
    source_paths: list[Path] = Field(default_factory=list)
    defaults: ScenarioDefaults | None = None
    tags_definition: list[str] = Field(default_factory=list)


class Scenarios(AgentProbeModel):
    metadata: ScenariosMetadata = Field(default_factory=ScenariosMetadata)
    scenarios: list[Scenario] = Field(default_factory=list)


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _parse_failure_modes(raw_list: list[object]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for item in raw_list:
        if isinstance(item, dict):
            for key, value in item.items():
                result.append({"name": str(key), "description": str(value)})
        elif isinstance(item, str):
            result.append({"name": item, "description": item})
    return result


def _parse_scenario_document(raw: dict[str, object], path: YamlPath) -> Scenarios:
    resolved_path = coerce_path(path)
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
        if defaults is not None:
            if "persona" not in payload and defaults.persona is not None:
                payload["persona"] = defaults.persona
            if "rubric" not in payload and defaults.rubric is not None:
                payload["rubric"] = defaults.rubric
            if defaults.user_name is not None or defaults.copilot_mode is not None:
                context = payload.get("context")
                if context is None:
                    context = {}
                    payload["context"] = context
                if isinstance(context, dict):
                    if defaults.user_name is not None and "user_name" not in context:
                        context["user_name"] = defaults.user_name
                    if defaults.copilot_mode is not None and "copilot_mode" not in context:
                        context["copilot_mode"] = defaults.copilot_mode

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
            source_path=resolved_path,
            source_paths=[resolved_path],
            defaults=defaults,
            tags_definition=cast(list[str], raw.get("tags_definition", [])),
        ),
        scenarios=scenarios,
    )


def parse_scenario_yaml(path: YamlPath) -> Scenarios:
    raw = read_yaml(path)
    return _parse_scenario_document(raw, path)


def _coalesce_metadata_value(values: list[str | None]) -> str | None:
    unique_values = {value for value in values if isinstance(value, str)}
    if len(unique_values) == 1:
        return next(iter(unique_values))
    return None


def _merge_scenario_defaults(collections: list[Scenarios]) -> ScenarioDefaults | None:
    merged_values: dict[str, int] = {}
    value_sources: dict[str, Path] = {}

    for collection in collections:
        defaults = collection.metadata.defaults
        source_path = collection.metadata.source_path
        if defaults is None or source_path is None:
            continue

        for field_name, field_value in defaults.model_dump(exclude_none=True).items():
            if field_name in merged_values and merged_values[field_name] != field_value:
                existing_source = value_sources[field_name]
                raise ValueError(
                    f"Conflicting scenario defaults for `{field_name}` between "
                    f"{existing_source} and {source_path}."
                )
            merged_values[field_name] = cast(int, field_value)
            value_sources[field_name] = source_path

    if not merged_values:
        return None
    return ScenarioDefaults.model_validate(merged_values)


def parse_scenarios_input(path: YamlPath) -> Scenarios:
    resolved = coerce_path(path)
    if resolved.is_file():
        return parse_scenario_yaml(resolved)
    if not resolved.is_dir():
        raise ValueError(f"Expected a scenario YAML file or directory: {resolved}")

    collections: list[Scenarios] = []
    for candidate in iter_yaml_files(resolved):
        raw = read_yaml(candidate)
        if "scenarios" not in raw:
            continue
        collections.append(_parse_scenario_document(raw, candidate))

    if not collections:
        raise ValueError(f"No scenario YAML files found under directory: {resolved}")

    merged_scenarios: list[Scenario] = []
    scenario_sources: dict[str, Path] = {}
    tag_definitions: list[str] = []
    seen_tags: set[str] = set()
    source_paths: list[Path] = []

    for collection in collections:
        source_path = collection.metadata.source_path
        if source_path is not None:
            source_paths.append(source_path)

        for tag in collection.metadata.tags_definition:
            if tag not in seen_tags:
                seen_tags.add(tag)
                tag_definitions.append(tag)

        for scenario in collection.scenarios:
            if scenario.id in scenario_sources:
                raise ValueError(
                    f"Duplicate scenario id `{scenario.id}` found in "
                    f"{scenario_sources[scenario.id]} and {source_path}."
                )
            if source_path is not None:
                scenario_sources[scenario.id] = source_path
            merged_scenarios.append(scenario)

    return Scenarios(
        metadata=ScenariosMetadata(
            version=_coalesce_metadata_value(
                [collection.metadata.version for collection in collections]
            ),
            id=_coalesce_metadata_value(
                [collection.metadata.id for collection in collections]
            ),
            name=_coalesce_metadata_value(
                [collection.metadata.name for collection in collections]
            ),
            source_path=resolved,
            source_paths=source_paths,
            defaults=_merge_scenario_defaults(collections),
            tags_definition=tag_definitions,
        ),
        scenarios=merged_scenarios,
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
    "parse_scenarios_input",
    "parse_scenario_yaml",
    "parse_time_offset",
]
