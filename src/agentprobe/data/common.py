from __future__ import annotations

from pathlib import Path
from typing import TypeAlias, cast

import yaml
from pydantic import BaseModel, ConfigDict


YamlPath = str | Path
YamlObject: TypeAlias = dict[str, object]


class AgentProbeModel(BaseModel):
    model_config = ConfigDict(extra="allow")  # type: ignore[typeddict-item]


def coerce_path(path: YamlPath) -> Path:
    return Path(path).expanduser().resolve()


def read_yaml(path: YamlPath) -> YamlObject:
    resolved = coerce_path(path)
    if not resolved.exists():
        raise FileNotFoundError(f"YAML file not found: {resolved}")
    if not resolved.is_file():
        raise ValueError(f"Expected a YAML file, got: {resolved}")

    with resolved.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)

    if data is None:
        raise ValueError(f"YAML file is empty: {resolved}")
    if not isinstance(data, dict):
        raise ValueError(f"Top-level YAML value must be a mapping: {resolved}")
    return cast(YamlObject, data)


def iter_yaml_files(data_path: YamlPath) -> list[Path]:
    resolved = coerce_path(data_path)
    if not resolved.exists():
        raise FileNotFoundError(f"Data path not found: {resolved}")
    if resolved.is_file():
        return [resolved]
    if not resolved.is_dir():
        raise ValueError(f"Expected a directory or YAML file: {resolved}")

    return sorted(
        path
        for path in resolved.rglob("*")
        if path.is_file() and path.suffix.lower() in {".yaml", ".yml"}
    )


__all__ = [
    "AgentProbeModel",
    "YamlObject",
    "YamlPath",
    "coerce_path",
    "iter_yaml_files",
    "read_yaml",
]
