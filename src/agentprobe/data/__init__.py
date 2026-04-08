from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .common import YamlObject, YamlPath, iter_yaml_files, read_yaml
from .endpoints import Endpoints, parse_endpoints_yaml
from .personas import Persona, Personas, parse_persona_yaml
from .rubrics import Rubric, Rubrics, parse_rubrics_yaml
from .scenarios import Scenario, Scenarios, parse_scenario_yaml, parse_scenarios_input


class Collection:
    def __init__(
        self,
        personas: Personas | None = None,
        scenarios: Scenarios | None = None,
        rubrics: Rubrics | None = None,
        endpoints: Endpoints | None = None,
    ) -> None:
        self.personas = personas
        self.scenarios = scenarios
        self.rubrics = rubrics
        self.endpoints = endpoints


@dataclass(slots=True)
class ProcessedYamlFile:
    path: Path
    schema: Literal["personas", "scenarios", "rubrics", "endpoints"]
    object_count: int


def _detect_schema(
    data: YamlObject,
) -> Literal["personas", "scenarios", "rubrics", "endpoints"]:
    if "personas" in data:
        return "personas"
    if "scenarios" in data:
        return "scenarios"
    if "rubrics" in data:
        return "rubrics"

    endpoint_keys = {
        "transport",
        "preset",
        "harness",
        "connection",
        "websocket",
        "auth",
        "session",
        "request",
        "response",
        "health_check",
    }
    if endpoint_keys.intersection(data):
        return "endpoints"

    raise ValueError(
        "Unsupported YAML schema; expected personas, scenarios, rubrics, or endpoint config."
    )


def load_all(data_path: YamlPath) -> Collection:
    collection = Collection()
    seen: dict[str, str] = {}

    for path in iter_yaml_files(data_path):
        raw = read_yaml(path)
        schema = _detect_schema(raw)

        if schema in seen:
            raise ValueError(
                f"Found multiple {schema} YAML documents: {seen[schema]} and {path}. "
                "load_all() currently supports one document per schema type."
            )
        seen[schema] = str(path)

        if schema == "personas":
            collection.personas = parse_persona_yaml(path)
        elif schema == "scenarios":
            collection.scenarios = parse_scenario_yaml(path)
        elif schema == "rubrics":
            collection.rubrics = parse_rubrics_yaml(path)
        elif schema == "endpoints":
            collection.endpoints = parse_endpoints_yaml(path)

    return collection


def parse_yaml_file(path: YamlPath) -> Personas | Scenarios | Rubrics | Endpoints:
    raw = read_yaml(path)
    schema = _detect_schema(raw)

    if schema == "personas":
        return parse_persona_yaml(path)
    if schema == "scenarios":
        return parse_scenario_yaml(path)
    if schema == "rubrics":
        return parse_rubrics_yaml(path)
    return parse_endpoints_yaml(path)


def process_yaml_files(data_path: YamlPath) -> list[ProcessedYamlFile]:
    processed: list[ProcessedYamlFile] = []

    for path in iter_yaml_files(data_path):
        parsed = parse_yaml_file(path)

        if isinstance(parsed, Personas):
            schema: Literal["personas", "scenarios", "rubrics", "endpoints"] = (
                "personas"
            )
            object_count = len(parsed.personas)
        elif isinstance(parsed, Scenarios):
            schema = "scenarios"
            object_count = len(parsed.scenarios)
        elif isinstance(parsed, Rubrics):
            schema = "rubrics"
            object_count = len(parsed.rubrics)
        else:
            schema = "endpoints"
            object_count = 1

        processed.append(
            ProcessedYamlFile(
                path=Path(path),
                schema=schema,
                object_count=object_count,
            )
        )

    return processed


__all__ = [
    "Collection",
    "Endpoints",
    "Persona",
    "Personas",
    "ProcessedYamlFile",
    "Rubric",
    "Rubrics",
    "Scenario",
    "Scenarios",
    "load_all",
    "parse_yaml_file",
    "parse_endpoints_yaml",
    "parse_persona_yaml",
    "parse_rubrics_yaml",
    "parse_scenarios_input",
    "parse_scenario_yaml",
    "process_yaml_files",
]
